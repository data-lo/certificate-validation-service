import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { randomUUID } from 'node:crypto';
import { lastValueFrom } from 'rxjs';

import {
  MAX_EVENT_ERROR_MESSAGE_LENGTH,
  OcspValidationFailedEvent,
} from './events/ocsp-validation-failed.event';
import {
  KAFKA_CLIENT,
  MONITORED_SERVICE,
  OCSP_VALIDATION_FAILED_EVENT,
  OCSP_VALIDATION_FAILED_TOPIC,
} from './incident.constants';
import { classifyOcspError, describeError } from './ocsp-failure-classifier';

/** Datos del intento de validación que acompañan al evento; todos opcionales. */
export interface OcspFailureContext {
  certificateSerial?: string;
  signingRequestId?: string;
  userId?: string;
}

/**
 * Publica en Kafka cada intento de validación que no pudo consultar OCSP.
 *
 * **Nunca interrumpe la validación.** Publicar es un efecto secundario: si Kafka está caído, el
 * usuario recibe igual su 503 (o su 200 `UNVERIFIED`) y el fallo de publicación queda en el log
 * con el evento completo, para reconstruir la cuenta a mano si hiciera falta.
 */
@Injectable()
export class OcspFailureEventPublisher implements OnModuleDestroy {
  private readonly logger = new Logger(OcspFailureEventPublisher.name);

  /**
   * @param kafkaClient - Productor de Kafka (`producerOnlyMode`): se conecta en el primer envío.
   * @returns El publicador.
   *
   * @example
   * ```ts
   * const publisher = new OcspFailureEventPublisher(kafkaClient);
   * ```
   */
  constructor(
    @Inject(KAFKA_CLIENT) private readonly kafkaClient: ClientKafka,
  ) {}

  /**
   * Arma el evento `OCSP_VALIDATION_FAILED` del fallo y lo publica.
   *
   * Registra en el log el detalle técnico del error y el `eventId`, que es con lo que se
   * relaciona el log con el renglón de `ocsp_failure_events`. La promesa nunca se rechaza: quien
   * llama puede no esperarla (`void publisher.publish(...)`).
   *
   * @param error - Lo que lanzó la consulta OCSP; decide el `errorType`.
   * @param context - Serie del certificado y, si el consumidor los mandó, solicitud y usuario.
   * @returns El evento publicado, o `null` si no se pudo publicar.
   *
   * @example
   * ```ts
   * void publisher.publish(error, { certificateSerial: certificate.serialNumber });
   * ```
   */
  async publish(
    error: unknown,
    context: OcspFailureContext = {},
  ): Promise<OcspValidationFailedEvent | null> {
    const event: OcspValidationFailedEvent = {
      eventId: randomUUID(),
      type: OCSP_VALIDATION_FAILED_EVENT,
      occurredAt: new Date().toISOString(),
      service: MONITORED_SERVICE,
      errorType: classifyOcspError(error),
      errorMessage: describeError(error).slice(
        0,
        MAX_EVENT_ERROR_MESSAGE_LENGTH,
      ),
      ...(context.signingRequestId && {
        signingRequestId: context.signingRequestId,
      }),
      ...(context.userId && { userId: context.userId }),
      ...(context.certificateSerial && {
        certificateSerial: context.certificateSerial,
      }),
    };

    this.logger.warn(
      `Fallo OCSP ${event.errorType} (eventId=${event.eventId}, serie=${
        event.certificateSerial ?? '-'
      }): ${event.errorMessage}`,
    );

    try {
      await lastValueFrom(
        this.kafkaClient.emit(OCSP_VALIDATION_FAILED_TOPIC, {
          key: MONITORED_SERVICE,
          value: event,
        }),
      );
      this.logger.log(
        `Evento ${OCSP_VALIDATION_FAILED_EVENT} publicado (eventId=${event.eventId})`,
      );
      return event;
    } catch (publishError) {
      this.logger.error(
        `No se pudo publicar ${OCSP_VALIDATION_FAILED_EVENT} en ${OCSP_VALIDATION_FAILED_TOPIC}: ${describeError(
          publishError,
        )}. Evento perdido: ${JSON.stringify(event)}`,
      );
      return null;
    }
  }

  /**
   * Cierra el productor al apagar la aplicación.
   *
   * @returns Nada.
   *
   * @example
   * ```ts
   * await publisher.onModuleDestroy();
   * ```
   */
  async onModuleDestroy(): Promise<void> {
    await this.kafkaClient.close();
  }
}
