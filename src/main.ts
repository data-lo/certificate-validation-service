import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { API_KEY_HEADER } from './auth/api-key.guard';
import { configureApp } from './app.setup';

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

  await app.listen(process.env.PORT ?? 3003);
}
void bootstrap();
