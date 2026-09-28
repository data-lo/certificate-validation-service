import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { KAFKA_CLIENT, MONITORED_SERVICE } from './incident.constants';
import { OcspFailureEventPublisher } from './ocsp-failure-event.publisher';

/** Broker por defecto: el puerto externo del contenedor `signature_kafka`. */
export const DEFAULT_KAFKA_BROKER = 'localhost:9094';

/**
 * Publicación de los fallos OCSP en Kafka.
 *
 * Vive aparte de `IncidentsModule` para que la validación de certificados dependa sólo del
 * productor, no de la base de datos ni de Redis: el endpoint sigue validando aunque la parte de
 * incidencias esté caída.
 *
 * `producerOnlyMode` evita que el cliente se una a un grupo de consumidores sólo para publicar.
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: KAFKA_CLIENT,
        inject: [ConfigService],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.KAFKA,
          options: {
            client: {
              clientId: `${
                configService.get<string>('KAFKA_CLIENT_ID') ||
                MONITORED_SERVICE
              }-producer`,
              brokers: [
                configService.get<string>('KAFKA_BROKER') ||
                  DEFAULT_KAFKA_BROKER,
              ],
              retry: { retries: 3 },
            },
            producer: { allowAutoTopicCreation: true },
            producerOnlyMode: true,
          },
        }),
      },
    ]),
  ],
  providers: [OcspFailureEventPublisher],
  exports: [OcspFailureEventPublisher],
})
export class OcspFailureEventsModule {}
