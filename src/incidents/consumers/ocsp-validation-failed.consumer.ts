import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { OcspValidationFailedEvent } from '../events/ocsp-validation-failed.event';
import { OCSP_VALIDATION_FAILED_TOPIC } from '../incident.constants';
import { IncidentNotifier } from '../notifications/incident-notifier.service';
import { describeError } from '../ocsp-failure-classifier';
import {
  IncidentService,
  RecordFailureResult,
} from '../services/incident.service';

/** Esperas entre intentos de registrar un evento cuando la base falla. */
export const RECORD_RETRY_DELAYS_MS = [500, 2000];

/**
 * Consume `certificate-validation.ocsp-validation-failed` y lo suma a la incidencia.
 *
 * **Idempotente.** Kafka puede entregar el mismo mensaje más de una vez; `IncidentService`
 * reclama el `eventId` en la base y una reentrega responde `DUPLICATE` sin sumar nada.
 *
 * **Qué pasa con los mensajes que no se pueden procesar:**
 * - Si no cumplen el contrato del evento, se registran y se descartan: reintentarlos no los va a
 *   arreglar y bloquearían la partición.
 * - Si falla la base, se reintenta dentro del mismo mensaje y, si sigue fallando, se relanza el
 *   error para que Kafka NO confirme el offset y lo vuelva a entregar. Gracias a la idempotencia
 *   esa reentrega es segura.
 */
@Controller()
export class OcspValidationFailedConsumer {
  private readonly logger = new Logger(OcspValidationFailedConsumer.name);

  /**
   * @param incidentService - Registro de eventos e incidencias.
   * @param notifier - Envío inmediato del aviso cuando se cruza el umbral.
   * @returns El consumer.
   *
   * @example
   * ```ts
   * const consumer = new OcspValidationFailedConsumer(incidentService, notifier);
   * ```
   */
  constructor(
    private readonly incidentService: IncidentService,
    private readonly notifier: IncidentNotifier,
  ) {}

  /**
   * Procesa un evento `OCSP_VALIDATION_FAILED`.
   *
   * @param payload - Valor del mensaje de Kafka, ya deserializado.
   * @returns El resultado del registro, o `null` si el mensaje se descartó por inválido.
   *
   * @throws {Error} Si la base sigue fallando tras los reintentos; Kafka reentrega el mensaje.
   *
   * @example
   * ```ts
   * await consumer.handle({ eventId: '0b6f…', type: 'OCSP_VALIDATION_FAILED', … });
   * ```
   */
  @EventPattern(OCSP_VALIDATION_FAILED_TOPIC)
  async handle(
    @Payload() payload: unknown,
  ): Promise<RecordFailureResult | null> {
    const event = plainToInstance(OcspValidationFailedEvent, payload);
    const errors =
      payload && typeof payload === 'object' ? await validate(event) : [];

    if (!payload || typeof payload !== 'object' || errors.length > 0) {
      this.logger.error(
        `Mensaje inválido en ${OCSP_VALIDATION_FAILED_TOPIC}, se descarta: ${errors
          .flatMap((error) => Object.values(error.constraints ?? {}))
          .join('; ')} — ${JSON.stringify(payload)}`,
      );
      return null;
    }

    const result = await this.recordWithRetries(event);

    if (result.outcome === 'DUPLICATE') {
      this.logger.log(
        `Evento duplicado ignorado (eventId=${event.eventId}): no suma a la incidencia`,
      );
      return result;
    }

    this.logger.log(
      `Evento ${event.eventId} (${event.errorType}) sumado a la incidencia ${result.incident.id}` +
        ` [${result.incident.status}${result.late ? ', tardío' : ''}]: intentos afectados ${result.incident.affectedAttempts}`,
    );

    await this.notifier.tryDispatch();
    return result;
  }

  /**
   * Registra el evento reintentando si la base falla.
   *
   * @param event - Evento validado.
   * @returns El resultado del registro.
   *
   * @throws {Error} El último error de la base si todos los intentos fallan.
   *
   * @example
   * ```ts
   * const result = await this.recordWithRetries(event);
   * ```
   */
  private async recordWithRetries(
    event: OcspValidationFailedEvent,
  ): Promise<RecordFailureResult> {
    const attempts = RECORD_RETRY_DELAYS_MS.length + 1;

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.incidentService.recordFailureEvent(event);
      } catch (error) {
        if (attempt >= attempts) {
          this.logger.error(
            `No se pudo registrar el evento ${event.eventId} tras ${attempts} intentos; Kafka lo reentregará: ${describeError(
              error,
            )}`,
          );
          throw error;
        }
        this.logger.warn(
          `Falló el registro del evento ${event.eventId} (intento ${attempt} de ${attempts}): ${describeError(
            error,
          )}`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, RECORD_RETRY_DELAYS_MS[attempt - 1]),
        );
      }
    }
  }
}
