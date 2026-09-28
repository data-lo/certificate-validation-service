import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { ServiceIncidentEntity } from '../entities/service-incident.entity';
import { OcspValidationFailedEvent } from '../events/ocsp-validation-failed.event';
import {
  INCIDENT_STATUS_ENUM,
  MONITORED_SERVICE,
  OCSP_FAILURE_TYPE_ENUM,
} from '../incident.constants';

/** Resultado de registrar un evento de fallo. */
export type RecordFailureResult =
  | { outcome: 'DUPLICATE' }
  | {
      outcome: 'RECORDED';
      incident: ServiceIncidentEntity;
      /** El fallo ocurrió antes de que se resolviera una incidencia: se sumó a esa, ya cerrada. */
      late: boolean;
    };

/** Tipo de correo de una incidencia. */
export type IncidentNotificationKind = 'INCIDENT_ALERT' | 'RECOVERY_ALERT';

/**
 * Veces que se reintenta abrir o actualizar la incidencia si el chequeo de salud la cierra justo
 * en medio. Con una ya basta; el resto es margen.
 */
const MAX_UPSERT_ROUNDS = 3;

/**
 * Estado de las incidencias de OCSP en Postgres.
 *
 * Todo lo que tiene que ser atómico entre réplicas se resuelve en la base y no en memoria: la
 * unicidad de la incidencia abierta (índice único parcial), la idempotencia de los eventos
 * (llave primaria `event_id`) y los contadores (`UPDATE ... SET x = x + 1`).
 */
@Injectable()
export class IncidentService {
  private readonly logger = new Logger(IncidentService.name);

  /**
   * @param dataSource - Conexión a la base del servicio.
   * @returns El servicio.
   *
   * @example
   * ```ts
   * const service = new IncidentService(dataSource);
   * ```
   */
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Registra un evento `OCSP_VALIDATION_FAILED` y lo suma a la incidencia que le corresponde.
   *
   * Todo va en una transacción:
   * 1. **Reclama el `eventId`** insertándolo en `ocsp_failure_events`. Si ya existía, es una
   *    reentrega de Kafka: se responde `DUPLICATE` sin tocar ningún contador.
   * 2. **Evento tardío.** Si ocurrió antes de que se resolviera alguna incidencia (el consumer iba
   *    atrasado), se suma a la primera incidencia resuelta después de él, en vez de abrir una nueva
   *    por una caída que ya terminó.
   * 3. **Si no, abre o actualiza la incidencia `OPEN`.** El `INSERT ... ON CONFLICT DO NOTHING`
   *    contra el índice parcial hace que dos réplicas que ven el primer fallo a la vez terminen
   *    en la misma fila. `started_at` baja si el evento es anterior al primero conocido.
   *
   * @param event - Evento ya validado.
   * @returns `DUPLICATE`, o la incidencia actualizada y si el evento llegó tarde.
   *
   * @throws {Error} Si falla la base de datos; la transacción se revierte y el `eventId` queda
   *   libre para la siguiente entrega.
   *
   * @example
   * ```ts
   * const result = await incidentService.recordFailureEvent(event);
   * if (result.outcome === 'RECORDED') result.incident.affectedAttempts; // 4
   * ```
   */
  async recordFailureEvent(
    event: OcspValidationFailedEvent,
  ): Promise<RecordFailureResult> {
    return this.dataSource.transaction(async (manager) => {
      const occurredAt = new Date(event.occurredAt);

      const claimed: unknown[] = await manager.query(
        `INSERT INTO "ocsp_failure_events"
           ("event_id", "service", "occurred_at", "error_type", "error_message",
            "signing_request_id", "user_id", "certificate_serial")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT ("event_id") DO NOTHING
         RETURNING "event_id"`,
        [
          event.eventId,
          event.service,
          occurredAt,
          event.errorType,
          event.errorMessage ?? null,
          event.signingRequestId ?? null,
          event.userId ?? null,
          event.certificateSerial ?? null,
        ],
      );

      if (claimed.length === 0) {
        return { outcome: 'DUPLICATE' as const };
      }

      const { incidentId, late } = await this.attachFailure(
        manager,
        event.service,
        occurredAt,
        event.errorType,
      );

      await manager.query(
        `UPDATE "ocsp_failure_events" SET "incident_id" = $1 WHERE "event_id" = $2`,
        [incidentId, event.eventId],
      );

      const incident = await manager.findOneByOrFail(ServiceIncidentEntity, {
        id: incidentId,
      });

      return { outcome: 'RECORDED' as const, incident, late };
    });
  }

  /**
   * Suma un chequeo de salud fallido a la incidencia abierta.
   *
   * @param incidentId - Incidencia abierta.
   * @param errorType - Causa del fallo del chequeo.
   * @param failedAt - Momento del chequeo.
   * @returns La incidencia actualizada, o `null` si ya no estaba abierta.
   *
   * @example
   * ```ts
   * await incidentService.recordFailedHealthCheck(incident.id, OCSP_FAILURE_TYPE_ENUM.TIMEOUT, new Date());
   * ```
   */
  async recordFailedHealthCheck(
    incidentId: string,
    errorType: OCSP_FAILURE_TYPE_ENUM,
    failedAt: Date,
  ): Promise<ServiceIncidentEntity | null> {
    const updated = await this.updateReturningId(
      this.dataSource.manager,
      `UPDATE "service_incidents"
         SET "failed_health_checks" = "failed_health_checks" + 1,
             "last_failure_at" = GREATEST("last_failure_at", $2),
             "last_error_type" = $3,
             "updated_at" = now()
       WHERE "id" = $1 AND "status" = 'OPEN'
       RETURNING "id"`,
      [incidentId, failedAt, errorType],
    );

    return updated ? this.findById(updated) : null;
  }

  /**
   * Cierra la incidencia abierta.
   *
   * Sólo cierra si sigue `OPEN`: si otra réplica ya la cerró, no la vuelve a tocar y responde
   * `null`, así que el cierre (y el correo que dispara) ocurre una sola vez.
   *
   * @param incidentId - Incidencia a cerrar.
   * @param resolvedAt - Momento en que OCSP volvió a responder.
   * @returns La incidencia resuelta, o `null` si ya no estaba abierta.
   *
   * @example
   * ```ts
   * const resolved = await incidentService.resolveIncident(incident.id, new Date());
   * ```
   */
  async resolveIncident(
    incidentId: string,
    resolvedAt: Date,
  ): Promise<ServiceIncidentEntity | null> {
    const updated = await this.updateReturningId(
      this.dataSource.manager,
      `UPDATE "service_incidents"
         SET "status" = 'RESOLVED', "resolved_at" = GREATEST($2, "started_at"), "updated_at" = now()
       WHERE "id" = $1 AND "status" = 'OPEN'
       RETURNING "id"`,
      [incidentId, resolvedAt],
    );

    return updated ? this.findById(updated) : null;
  }

  /**
   * La incidencia abierta del servicio, si hay una.
   *
   * @returns La incidencia `OPEN`, o `null`.
   *
   * @example
   * ```ts
   * const open = await incidentService.findOpenIncident();
   * ```
   */
  async findOpenIncident(): Promise<ServiceIncidentEntity | null> {
    return this.dataSource.manager.findOneBy(ServiceIncidentEntity, {
      service: MONITORED_SERVICE,
      status: INCIDENT_STATUS_ENUM.OPEN,
    });
  }

  /**
   * Incidencias abiertas que ya alcanzaron el umbral y cuyo aviso sigue pendiente.
   *
   * @param threshold - Fallos (intentos afectados + chequeos fallidos) que disparan el aviso.
   * @param maxAttempts - Intentos de envío tras los que se deja de insistir.
   * @param retryBefore - Sólo las que no se intentaron después de este momento: un correo que
   *   falló no se reintenta hasta que pasa `NOTIFICATION_RETRY_INTERVAL_MS`.
   * @returns Las incidencias por avisar, la más antigua primero.
   *
   * @example
   * ```ts
   * const pending = await incidentService.findAwaitingIncidentAlert(3, 10, new Date(Date.now() - 240_000));
   * ```
   */
  async findAwaitingIncidentAlert(
    threshold: number,
    maxAttempts: number,
    retryBefore: Date,
  ): Promise<ServiceIncidentEntity[]> {
    return this.dataSource.manager
      .createQueryBuilder(ServiceIncidentEntity, 'incident')
      .where('incident.service = :service', { service: MONITORED_SERVICE })
      .andWhere('incident.status = :status', {
        status: INCIDENT_STATUS_ENUM.OPEN,
      })
      .andWhere('incident.incidentAlertSent = false')
      .andWhere(
        'incident.affectedAttempts + incident.failedHealthChecks >= :threshold',
        { threshold },
      )
      .andWhere('incident.incidentAlertAttempts < :maxAttempts', {
        maxAttempts,
      })
      .andWhere(
        '(incident.incidentAlertLastAttemptAt IS NULL OR incident.incidentAlertLastAttemptAt <= :retryBefore)',
        { retryBefore },
      )
      .orderBy('incident.startedAt', 'ASC')
      .getMany();
  }

  /**
   * Incidencias resueltas cuyo correo de recuperación sigue pendiente.
   *
   * Sólo las que alguien tendría que saber que se recuperaron: las que dispararon el aviso o
   * alcanzaron el umbral aunque el aviso no llegara a salir. Un fallo aislado que se recuperó
   * antes del umbral se cierra sin correo.
   *
   * @param threshold - Fallos que disparan el aviso.
   * @param maxAttempts - Intentos de envío tras los que se deja de insistir.
   * @param retryBefore - Sólo las que no se intentaron después de este momento.
   * @returns Las incidencias por notificar, la que se resolvió antes primero.
   *
   * @example
   * ```ts
   * const pending = await incidentService.findAwaitingRecoveryAlert(3, 10, new Date(Date.now() - 240_000));
   * ```
   */
  async findAwaitingRecoveryAlert(
    threshold: number,
    maxAttempts: number,
    retryBefore: Date,
  ): Promise<ServiceIncidentEntity[]> {
    return this.dataSource.manager
      .createQueryBuilder(ServiceIncidentEntity, 'incident')
      .where('incident.service = :service', { service: MONITORED_SERVICE })
      .andWhere('incident.status = :status', {
        status: INCIDENT_STATUS_ENUM.RESOLVED,
      })
      .andWhere('incident.recoveryAlertSent = false')
      .andWhere(
        '(incident.incidentAlertSent = true OR incident.affectedAttempts + incident.failedHealthChecks >= :threshold)',
        { threshold },
      )
      .andWhere('incident.recoveryAlertAttempts < :maxAttempts', {
        maxAttempts,
      })
      .andWhere(
        '(incident.recoveryAlertLastAttemptAt IS NULL OR incident.recoveryAlertLastAttemptAt <= :retryBefore)',
        { retryBefore },
      )
      .orderBy('incident.resolvedAt', 'ASC')
      .getMany();
  }

  /**
   * Marca como enviado uno de los dos correos de la incidencia y cuenta el intento.
   *
   * @param incidentId - Incidencia notificada.
   * @param kind - Qué correo se envió.
   * @param sentAt - Momento del envío.
   * @returns Nada.
   *
   * @example
   * ```ts
   * await incidentService.markNotificationSent(incident.id, 'RECOVERY_ALERT', new Date());
   * ```
   */
  async markNotificationSent(
    incidentId: string,
    kind: IncidentNotificationKind,
    sentAt: Date,
  ): Promise<void> {
    const prefix = kind === 'INCIDENT_ALERT' ? 'incident' : 'recovery';

    await this.dataSource.manager.query(
      `UPDATE "service_incidents"
         SET "${prefix}_alert_sent" = true,
             "${prefix}_alert_sent_at" = $2,
             "${prefix}_alert_attempts" = "${prefix}_alert_attempts" + 1,
             "${prefix}_alert_last_attempt_at" = $2,
             "updated_at" = now()
       WHERE "id" = $1`,
      [incidentId, sentAt],
    );
  }

  /**
   * Cuenta un intento fallido de envío y guarda el motivo.
   *
   * @param incidentId - Incidencia cuyo correo no salió.
   * @param kind - Qué correo falló.
   * @param errorMessage - Motivo del fallo.
   * @param attemptedAt - Momento del intento; el siguiente espera `NOTIFICATION_RETRY_INTERVAL_MS`.
   * @returns Nada.
   *
   * @example
   * ```ts
   * await incidentService.recordNotificationFailure(incident.id, 'INCIDENT_ALERT', 'SendGrid 503', new Date());
   * ```
   */
  async recordNotificationFailure(
    incidentId: string,
    kind: IncidentNotificationKind,
    errorMessage: string,
    attemptedAt: Date,
  ): Promise<void> {
    const prefix = kind === 'INCIDENT_ALERT' ? 'incident' : 'recovery';

    await this.dataSource.manager.query(
      `UPDATE "service_incidents"
         SET "${prefix}_alert_attempts" = "${prefix}_alert_attempts" + 1,
             "${prefix}_alert_last_attempt_at" = $3,
             "last_notification_error" = $2,
             "updated_at" = now()
       WHERE "id" = $1`,
      [incidentId, errorMessage, attemptedAt],
    );
  }

  /**
   * Las incidencias más recientes del servicio, para auditoría.
   *
   * @param limit - Cuántas devolver.
   * @returns Las incidencias, la más reciente primero.
   *
   * @example
   * ```ts
   * const recent = await incidentService.findRecent(20);
   * ```
   */
  async findRecent(limit: number): Promise<ServiceIncidentEntity[]> {
    return this.dataSource.manager.find(ServiceIncidentEntity, {
      where: { service: MONITORED_SERVICE },
      order: { startedAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * Decide a qué incidencia pertenece un fallo, la actualiza y devuelve su id.
   *
   * @param manager - Transacción en curso.
   * @param service - Servicio del evento.
   * @param occurredAt - Momento del fallo.
   * @param errorType - Causa del fallo.
   * @returns La incidencia a la que se sumó y si fue una ya resuelta.
   *
   * @throws {Error} Si tras `MAX_UPSERT_ROUNDS` vueltas no logra asignar la incidencia.
   *
   * @example
   * ```ts
   * const { incidentId, late } = await this.attachFailure(manager, service, occurredAt, errorType);
   * ```
   */
  private async attachFailure(
    manager: EntityManager,
    service: string,
    occurredAt: Date,
    errorType: OCSP_FAILURE_TYPE_ENUM,
  ): Promise<{ incidentId: string; late: boolean }> {
    for (let round = 1; round <= MAX_UPSERT_ROUNDS; round++) {
      const resolvedId = await this.updateReturningId(
        manager,
        `UPDATE "service_incidents"
           SET "affected_attempts" = "affected_attempts" + 1,
               "started_at" = LEAST("started_at", $2),
               "updated_at" = now()
         WHERE "id" = (
           SELECT "id" FROM "service_incidents"
           WHERE "service" = $1 AND "status" = 'RESOLVED' AND "resolved_at" >= $2
           ORDER BY "resolved_at" ASC
           LIMIT 1
         )
         RETURNING "id"`,
        [service, occurredAt],
      );

      if (resolvedId) {
        this.logger.warn(
          `Evento tardío: el fallo de ${occurredAt.toISOString()} se sumó a la incidencia ya resuelta ${resolvedId}`,
        );
        return { incidentId: resolvedId, late: true };
      }

      await manager.query(
        `INSERT INTO "service_incidents"
           ("service", "status", "started_at", "last_failure_at", "last_error_type")
         VALUES ($1, 'OPEN', $2, $2, $3)
         ON CONFLICT ("service") WHERE "status" = 'OPEN' DO NOTHING`,
        [service, occurredAt, errorType],
      );

      const openId = await this.updateReturningId(
        manager,
        `UPDATE "service_incidents"
           SET "affected_attempts" = "affected_attempts" + 1,
               "started_at" = LEAST("started_at", $2),
               "last_error_type" = CASE WHEN $2 >= "last_failure_at" THEN $3 ELSE "last_error_type" END,
               "last_failure_at" = GREATEST("last_failure_at", $2),
               "updated_at" = now()
         WHERE "service" = $1 AND "status" = 'OPEN'
         RETURNING "id"`,
        [service, occurredAt, errorType],
      );

      if (openId) {
        return { incidentId: openId, late: false };
      }

      // Entre el INSERT y el UPDATE el chequeo de salud cerró la incidencia: se vuelve a decidir.
      this.logger.warn(
        `La incidencia abierta se cerró mientras se registraba un fallo; ronda ${round} de ${MAX_UPSERT_ROUNDS}`,
      );
    }

    throw new Error(
      `No se pudo asignar el fallo de ${occurredAt.toISOString()} a ninguna incidencia`,
    );
  }

  /**
   * Ejecuta un `UPDATE ... RETURNING "id"` y devuelve el id afectado.
   *
   * El driver de Postgres devuelve `[filas, cuenta]` para los UPDATE; esto lo aísla.
   *
   * @param manager - Conexión o transacción.
   * @param sql - Sentencia con `RETURNING "id"`.
   * @param parameters - Parámetros posicionales.
   * @returns El id de la fila actualizada, o `null` si no actualizó ninguna.
   *
   * @example
   * ```ts
   * const id = await this.updateReturningId(manager, 'UPDATE ... RETURNING "id"', [incidentId]);
   * ```
   */
  private async updateReturningId(
    manager: EntityManager,
    sql: string,
    parameters: unknown[],
  ): Promise<string | null> {
    const result: unknown = await manager.query(sql, parameters);
    const rows = (
      Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result
    ) as { id: string }[];

    return rows[0]?.id ?? null;
  }

  /**
   * @param id - Incidencia a leer.
   * @returns La incidencia.
   *
   * @throws {EntityNotFoundError} Si no existe.
   *
   * @example
   * ```ts
   * const incident = await this.findById('9b0c...');
   * ```
   */
  private async findById(id: string): Promise<ServiceIncidentEntity> {
    return this.dataSource.manager.findOneByOrFail(ServiceIncidentEntity, {
      id,
    });
  }
}
