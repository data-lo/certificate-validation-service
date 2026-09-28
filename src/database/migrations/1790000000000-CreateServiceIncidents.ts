import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Crea las incidencias de disponibilidad de OCSP y los eventos que las alimentan.
 *
 * - `service_incidents`: una fila por caída. `UQ_service_incidents_open_per_service` es un índice
 *   único PARCIAL (`WHERE status = 'OPEN'`): una sola incidencia abierta por servicio, y tantas
 *   resueltas como caídas haya habido.
 * - `ocsp_failure_events`: un renglón por `eventId`; su llave primaria es la idempotencia del
 *   consumer de Kafka.
 */
export class CreateServiceIncidents1790000000000 implements MigrationInterface {
  name = 'CreateServiceIncidents1790000000000';

  /**
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @example
   * ```ts
   * await new CreateServiceIncidents1790000000000().up(queryRunner);
   * ```
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "service_incidents" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "service" varchar(100) NOT NULL,
        "status" varchar(20) NOT NULL,
        "started_at" timestamptz NOT NULL,
        "resolved_at" timestamptz,
        "last_failure_at" timestamptz NOT NULL,
        "last_error_type" varchar(30),
        "affected_attempts" integer NOT NULL DEFAULT 0,
        "failed_health_checks" integer NOT NULL DEFAULT 0,
        "incident_alert_sent" boolean NOT NULL DEFAULT false,
        "incident_alert_sent_at" timestamptz,
        "incident_alert_attempts" integer NOT NULL DEFAULT 0,
        "incident_alert_last_attempt_at" timestamptz,
        "recovery_alert_sent" boolean NOT NULL DEFAULT false,
        "recovery_alert_sent_at" timestamptz,
        "recovery_alert_attempts" integer NOT NULL DEFAULT 0,
        "recovery_alert_last_attempt_at" timestamptz,
        "last_notification_error" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_service_incidents" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_service_incidents_status"
          CHECK ("status" IN ('OPEN', 'RESOLVED')),
        CONSTRAINT "CHK_service_incidents_resolved_at"
          CHECK (("status" = 'OPEN') = ("resolved_at" IS NULL)),
        CONSTRAINT "CHK_service_incidents_counters"
          CHECK ("affected_attempts" >= 0 AND "failed_health_checks" >= 0)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_service_incidents_open_per_service"
        ON "service_incidents" ("service") WHERE "status" = 'OPEN'
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_service_incidents_service_started_at"
        ON "service_incidents" ("service", "started_at" DESC)
    `);

    await queryRunner.query(`
      CREATE TABLE "ocsp_failure_events" (
        "event_id" uuid NOT NULL,
        "incident_id" uuid,
        "service" varchar(100) NOT NULL,
        "occurred_at" timestamptz NOT NULL,
        "error_type" varchar(30) NOT NULL,
        "error_message" text,
        "signing_request_id" varchar(255),
        "user_id" varchar(255),
        "certificate_serial" varchar(255),
        "processed_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ocsp_failure_events" PRIMARY KEY ("event_id"),
        CONSTRAINT "FK_ocsp_failure_events_incident"
          FOREIGN KEY ("incident_id") REFERENCES "service_incidents" ("id")
          ON DELETE RESTRICT,
        CONSTRAINT "CHK_ocsp_failure_events_error_type"
          CHECK ("error_type" IN ('TIMEOUT', 'NETWORK_ERROR', 'OCSP_UNAVAILABLE'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_ocsp_failure_events_incident_id"
        ON "ocsp_failure_events" ("incident_id")
    `);
  }

  /**
   * @param queryRunner - Conexión de la migración.
   * @returns Nada.
   *
   * @example
   * ```ts
   * await new CreateServiceIncidents1790000000000().down(queryRunner);
   * ```
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ocsp_failure_events"`);
    await queryRunner.query(`DROP TABLE "service_incidents"`);
  }
}
