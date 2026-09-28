import { Injectable, Logger } from '@nestjs/common';

import {
  DispatchSummary,
  IncidentNotifier,
} from '../notifications/incident-notifier.service';
import { IncidentService } from './incident.service';
import { OcspHealthCheckService } from './ocsp-health-check.service';

/** Qué hizo un ciclo de monitoreo. */
export interface MonitorCycleSummary {
  /** `NO_INCIDENT`: no había nada abierto; `STILL_FAILING`: sigue caído; `RESOLVED`: se cerró. */
  outcome: 'NO_INCIDENT' | 'STILL_FAILING' | 'RESOLVED';
  incidentId?: string;
  notifications: DispatchSummary;
}

/**
 * Un ciclo del monitoreo de OCSP: comprueba la incidencia abierta y envía lo pendiente.
 *
 * Vive aparte del job con `@Cron` para que la lógica se pruebe sin scheduler ni lock. El job es
 * quien toma el lock `INCIDENT_KEY`: aquí se supone tomado.
 */
@Injectable()
export class IncidentMonitorService {
  private readonly logger = new Logger(IncidentMonitorService.name);

  /**
   * @param incidentService - Estado de las incidencias.
   * @param healthCheck - Chequeo de salud contra OCSP.
   * @param notifier - Envío de correos pendientes.
   * @returns El servicio.
   *
   * @example
   * ```ts
   * const monitor = new IncidentMonitorService(incidentService, healthCheck, notifier);
   * ```
   */
  constructor(
    private readonly incidentService: IncidentService,
    private readonly healthCheck: OcspHealthCheckService,
    private readonly notifier: IncidentNotifier,
  ) {}

  /**
   * Ejecuta un ciclo. Debe llamarse con el lock `INCIDENT_KEY` tomado.
   *
   * 1. Sin incidencia abierta no consulta al SAT: las incidencias las abren los intentos reales,
   *    y no hace falta salir a la red cada 5 minutos para confirmar que todo está bien.
   * 2. Con una abierta, hace el chequeo de salud. Si OCSP responde, la cierra; si sigue fallando,
   *    suma el chequeo a la incidencia (que puede así cruzar el umbral del aviso) y no envía nada
   *    más que lo que ya estaba pendiente.
   * 3. Siempre despacha lo pendiente: el aviso de la abierta, el resumen de la recién cerrada o
   *    los reintentos de correos que fallaron en ciclos anteriores.
   *
   * @returns Qué pasó en el ciclo.
   *
   * @throws {Error} Si falla la base de datos.
   *
   * @example
   * ```ts
   * const summary = await monitor.runCycle();
   * ```
   */
  async runCycle(): Promise<MonitorCycleSummary> {
    const open = await this.incidentService.findOpenIncident();

    if (!open) {
      return {
        outcome: 'NO_INCIDENT',
        notifications: await this.notifier.dispatchPending(),
      };
    }

    const result = await this.healthCheck.check();
    const checkedAt = new Date();

    if (result.healthy) {
      const resolved = await this.incidentService.resolveIncident(
        open.id,
        checkedAt,
      );
      if (resolved) {
        this.logger.log(
          `OCSP recuperado: incidencia ${resolved.id} cerrada (inicio ${resolved.startedAt.toISOString()}, intentos afectados ${resolved.affectedAttempts}, chequeos fallidos ${resolved.failedHealthChecks})`,
        );
      }
      return {
        outcome: 'RESOLVED',
        incidentId: open.id,
        notifications: await this.notifier.dispatchPending(),
      };
    }

    const updated = await this.incidentService.recordFailedHealthCheck(
      open.id,
      result.errorType,
      checkedAt,
    );
    this.logger.warn(
      `OCSP sigue sin responder (${result.errorType}): incidencia ${open.id} abierta, intentos afectados ${
        updated?.affectedAttempts ?? open.affectedAttempts
      }, chequeos fallidos ${updated?.failedHealthChecks ?? open.failedHealthChecks}. ${result.errorMessage}`,
    );

    return {
      outcome: 'STILL_FAILING',
      incidentId: open.id,
      notifications: await this.notifier.dispatchPending(),
    };
  }
}
