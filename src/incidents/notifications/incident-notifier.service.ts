import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DistributedLockService } from '../../common/redis/distributed-lock.service';
import { ServiceIncidentEntity } from '../entities/service-incident.entity';
import {
  DEFAULT_INCIDENT_ALERT_THRESHOLD,
  INCIDENT_KEY,
  MAX_NOTIFICATION_ATTEMPTS,
  NOTIFICATION_RETRY_INTERVAL_MS,
} from '../incident.constants';
import { describeError } from '../ocsp-failure-classifier';
import {
  IncidentNotificationKind,
  IncidentService,
} from '../services/incident.service';
import { IncidentEmailService } from './incident-email.service';
import {
  IncidentEmail,
  buildIncidentAlertEmail,
  buildRecoveryAlertEmail,
} from './incident-email.templates';

/** Vida del lock de incidencias: cubre de sobra un chequeo OCSP y dos correos con reintentos. */
export const INCIDENT_LOCK_TTL_MS = 4 * 60 * 1000;

/** Cuántos correos salieron o fallaron en una ejecución. */
export interface DispatchSummary {
  sent: number;
  failed: number;
}

/**
 * Envía los dos únicos correos de cada incidencia: el aviso al alcanzar el umbral y el resumen de
 * recuperación.
 *
 * **Nunca por intento ni por usuario.** El estado de cada correo vive en la incidencia
 * (`incident_alert_sent`, `recovery_alert_sent`): se busca lo pendiente, se envía y se marca. Un
 * correo que falla cuenta un intento y no se reintenta hasta que pasa
 * `NOTIFICATION_RETRY_INTERVAL_MS` —a lo sumo una vez por ciclo del cron, aunque el consumer
 * despache tras cada evento—, hasta `MAX_NOTIFICATION_ATTEMPTS`.
 *
 * **Una sola réplica a la vez.** `dispatchPending` supone que quien llama tiene el lock
 * `INCIDENT_KEY`; `tryDispatch` lo toma por su cuenta y, si otra réplica lo tiene, no hace nada:
 * esa réplica ya está enviando lo pendiente.
 */
@Injectable()
export class IncidentNotifier {
  private readonly logger = new Logger(IncidentNotifier.name);
  private readonly threshold: number;

  /**
   * @param incidentService - Estado de las incidencias.
   * @param emailService - Envío por SendGrid.
   * @param locks - Lock distribuido.
   * @param configService - Fuente de `INCIDENT_ALERT_THRESHOLD`.
   * @returns El notificador.
   *
   * @example
   * ```ts
   * const notifier = new IncidentNotifier(incidentService, emailService, locks, configService);
   * ```
   */
  constructor(
    private readonly incidentService: IncidentService,
    private readonly emailService: IncidentEmailService,
    private readonly locks: DistributedLockService,
    configService: ConfigService,
  ) {
    this.threshold =
      Number(configService.get<string>('INCIDENT_ALERT_THRESHOLD')) ||
      DEFAULT_INCIDENT_ALERT_THRESHOLD;
  }

  /**
   * Toma el lock y envía lo pendiente; si otra réplica tiene el lock, no hace nada.
   *
   * Lo usa el consumer tras cada evento, para que el aviso salga en cuanto se cruza el umbral y
   * no hasta el siguiente ciclo del cron. Nunca lanza: un fallo aquí no debe devolver el mensaje
   * a Kafka, porque el evento ya quedó registrado.
   *
   * @returns El resumen de envíos, o `null` si el lock estaba tomado o algo falló.
   *
   * @example
   * ```ts
   * await notifier.tryDispatch();
   * ```
   */
  async tryDispatch(): Promise<DispatchSummary | null> {
    try {
      const run = await this.locks.runExclusive(
        INCIDENT_KEY,
        INCIDENT_LOCK_TTL_MS,
        () => this.dispatchPending(),
      );
      return run.acquired ? run.result : null;
    } catch (error) {
      this.logger.error(
        `No se pudieron despachar los correos de incidencias: ${describeError(error)}`,
      );
      return null;
    }
  }

  /**
   * Envía el aviso de las incidencias abiertas que cruzaron el umbral y el resumen de las
   * resueltas. Debe llamarse con el lock `INCIDENT_KEY` tomado.
   *
   * @returns Cuántos correos salieron y cuántos fallaron.
   *
   * @throws {Error} Si falla la consulta a la base (los fallos de envío no se propagan).
   *
   * @example
   * ```ts
   * await locks.runExclusive(INCIDENT_KEY, INCIDENT_LOCK_TTL_MS, () => notifier.dispatchPending());
   * ```
   */
  async dispatchPending(): Promise<DispatchSummary> {
    const summary: DispatchSummary = { sent: 0, failed: 0 };
    const retryBefore = new Date(Date.now() - NOTIFICATION_RETRY_INTERVAL_MS);

    const awaitingAlert = await this.incidentService.findAwaitingIncidentAlert(
      this.threshold,
      MAX_NOTIFICATION_ATTEMPTS,
      retryBefore,
    );
    for (const incident of awaitingAlert) {
      await this.notify(
        incident,
        'INCIDENT_ALERT',
        buildIncidentAlertEmail(incident),
        summary,
      );
    }

    const awaitingRecovery =
      await this.incidentService.findAwaitingRecoveryAlert(
        this.threshold,
        MAX_NOTIFICATION_ATTEMPTS,
        retryBefore,
      );
    for (const incident of awaitingRecovery) {
      await this.notify(
        incident,
        'RECOVERY_ALERT',
        buildRecoveryAlertEmail(incident),
        summary,
      );
    }

    return summary;
  }

  /**
   * Envía un correo de la incidencia y deja el resultado registrado en ella.
   *
   * @param incident - Incidencia notificada.
   * @param kind - Qué correo es.
   * @param email - Contenido ya armado.
   * @param summary - Resumen de la ejecución, que se actualiza.
   * @returns Nada; los fallos de envío se cuentan, no se lanzan.
   *
   * @example
   * ```ts
   * await this.notify(incident, 'INCIDENT_ALERT', buildIncidentAlertEmail(incident), summary);
   * ```
   */
  private async notify(
    incident: ServiceIncidentEntity,
    kind: IncidentNotificationKind,
    email: IncidentEmail,
    summary: DispatchSummary,
  ): Promise<void> {
    try {
      await this.emailService.send(email, `${kind} ${incident.id}`);
      await this.incidentService.markNotificationSent(
        incident.id,
        kind,
        new Date(),
      );
      summary.sent++;
      this.logger.log(
        `${kind} enviado para la incidencia ${incident.id} (intentos afectados: ${incident.affectedAttempts})`,
      );
    } catch (error) {
      const attempts =
        (kind === 'INCIDENT_ALERT'
          ? incident.incidentAlertAttempts
          : incident.recoveryAlertAttempts) + 1;

      await this.incidentService.recordNotificationFailure(
        incident.id,
        kind,
        describeError(error),
        new Date(),
      );
      summary.failed++;
      this.logger.error(
        `${kind} de la incidencia ${incident.id} no se pudo enviar (intento ${attempts} de ${MAX_NOTIFICATION_ATTEMPTS})` +
          `${attempts >= MAX_NOTIFICATION_ATTEMPTS ? '; no se volverá a intentar' : ''}: ${describeError(error)}`,
      );
    }
  }
}
