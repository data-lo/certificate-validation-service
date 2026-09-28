import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { DistributedLockService } from '../../common/redis/distributed-lock.service';
import { INCIDENT_KEY } from '../incident.constants';
import { INCIDENT_LOCK_TTL_MS } from '../notifications/incident-notifier.service';
import { describeError } from '../ocsp-failure-classifier';
import {
  IncidentMonitorService,
  MonitorCycleSummary,
} from '../services/incident-monitor.service';

/** Nombre del job en el `SchedulerRegistry`. */
export const OCSP_INCIDENT_MONITOR_JOB = 'ocsp-incident-monitor';

/** Periodo del cron; debe coincidir con `CronExpression.EVERY_5_MINUTES`. */
export const MONITOR_CYCLE_MS = 5 * 60 * 1000;

/** Cuánto espera el ciclo reclamado a que el consumer suelte el lock de la incidencia. */
export const MONITOR_LOCK_WAIT_MS = 60 * 1000;

/**
 * Llave del reclamo de un ciclo. Redondea al periodo más cercano, así que réplicas con relojes
 * desfasados unos segundos caen en la misma llave.
 *
 * @param now - Momento en que se disparó el cron.
 * @returns La llave del ciclo, p. ej. `certificate-validation-service:incident:cycle:5966104`.
 *
 * @example
 * ```ts
 * monitorCycleKey(new Date('2026-09-28T21:40:00Z'));
 * ```
 */
export function monitorCycleKey(now: Date): string {
  return `${INCIDENT_KEY}:cycle:${Math.round(now.getTime() / MONITOR_CYCLE_MS)}`;
}

/**
 * Cada 5 minutos, un ciclo de monitoreo de OCSP (ver `IncidentMonitorService.runCycle`).
 *
 * **Una sola réplica por ciclo.** Todas disparan el cron a la vez; la primera que reclama la
 * llave del ciclo (`monitorCycleKey`, que no se libera y expira sola) lo ejecuta y las demás lo
 * saltan. No basta con el lock `INCIDENT_KEY`: se libera al terminar, y una réplica cuyo cron se
 * disparó unos milisegundos después lo encontraba libre y repetía el chequeo (se reprodujo en
 * local con dos réplicas: los chequeos fallidos se contaban dos veces por ciclo).
 *
 * El ciclo reclamado además toma `INCIDENT_KEY`, esperando hasta `MONITOR_LOCK_WAIT_MS`, para no
 * cruzarse con el consumer si en ese momento está enviando un correo.
 */
@Injectable()
export class OcspIncidentMonitorJob {
  private readonly logger = new Logger(OcspIncidentMonitorJob.name);

  /**
   * @param locks - Lock distribuido.
   * @param monitor - Lógica del ciclo.
   * @returns El job.
   *
   * @example
   * ```ts
   * const job = new OcspIncidentMonitorJob(locks, monitor);
   * ```
   */
  constructor(
    private readonly locks: DistributedLockService,
    private readonly monitor: IncidentMonitorService,
  ) {}

  /**
   * Ejecuta el ciclo si esta réplica reclama el periodo. Nunca lanza: un ciclo fallido se
   * registra y el siguiente lo vuelve a intentar.
   *
   * @returns El resumen del ciclo, o `null` si otra réplica lo reclamó o el ciclo falló.
   *
   * @example
   * ```ts
   * await job.run();
   * ```
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: OCSP_INCIDENT_MONITOR_JOB })
  async run(): Promise<MonitorCycleSummary | null> {
    try {
      const cycleKey = monitorCycleKey(new Date());

      if (!(await this.locks.claimOnce(cycleKey, 2 * MONITOR_CYCLE_MS))) {
        this.logger.debug(
          `Ciclo de monitoreo omitido: otra réplica ya reclamó ${cycleKey}`,
        );
        return null;
      }

      const run = await this.locks.runExclusive(
        INCIDENT_KEY,
        INCIDENT_LOCK_TTL_MS,
        () => this.monitor.runCycle(),
        { waitMs: MONITOR_LOCK_WAIT_MS },
      );

      if (!run.acquired) {
        this.logger.warn(
          `Ciclo de monitoreo omitido: ${INCIDENT_KEY} siguió ocupado ${MONITOR_LOCK_WAIT_MS} ms`,
        );
        return null;
      }

      this.logger.log(
        `Ciclo de monitoreo OCSP: ${run.result.outcome}${
          run.result.incidentId ? ` (incidencia ${run.result.incidentId})` : ''
        }, correos enviados ${run.result.notifications.sent}, fallidos ${run.result.notifications.failed}`,
      );
      return run.result;
    } catch (error) {
      this.logger.error(
        `Falló el ciclo de monitoreo OCSP; se reintenta en el siguiente: ${describeError(error)}`,
      );
      return null;
    }
  }
}
