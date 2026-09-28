import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { API_KEY_HEADER } from './auth/api-key.guard';
import { configureApp } from './app.setup';
import { MONITORED_SERVICE } from './incidents/incident.constants';
import { ensureKafkaTopics } from './incidents/kafka-topics';
import { DEFAULT_KAFKA_BROKER } from './incidents/ocsp-failure-events.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Certificate Validation Service API')
    .setDescription(
      'Validación de certificados de e.firma: vigencia, cadena de confianza del SAT y estado de ' +
        `revocación vía OCSP. Todos los endpoints requieren el header "${API_KEY_HEADER}".`,
    )
    .setVersion('1.0')
    .addApiKey(
      { type: 'apiKey', name: API_KEY_HEADER, in: 'header' },
      API_KEY_HEADER,
    )
    .addSecurityRequirements(API_KEY_HEADER)
    .build();
  SwaggerModule.setup(
    'docs',
    app,
    SwaggerModule.createDocument(app, swaggerConfig),
    {
      swaggerOptions: { persistAuthorization: true },
    },
  );

  // Consumer de los eventos de fallo OCSP. Los guards, pipes y filtros globales de configureApp
  // son de HTTP: sin `inheritAppConfig` no alcanzan a los mensajes de Kafka, que no traen
  // x-api-key.
  const kafkaClientId = process.env.KAFKA_CLIENT_ID || MONITORED_SERVICE;
  const kafkaBrokers = [process.env.KAFKA_BROKER || DEFAULT_KAFKA_BROKER];
  await ensureKafkaTopics(kafkaBrokers, kafkaClientId);

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: { clientId: kafkaClientId, brokers: kafkaBrokers },
      consumer: {
        groupId:
          process.env.KAFKA_CONSUMER_GROUP_ID ||
          `${MONITORED_SERVICE}-consumer`,
        allowAutoTopicCreation: true,
      },
    },
  });
  await app.startAllMicroservices();

  await app.listen(process.env.PORT ?? 3003);
}
void bootstrap();
