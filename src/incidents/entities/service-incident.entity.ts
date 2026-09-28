import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import {
  INCIDENT_STATUS_ENUM,
  OCSP_FAILURE_TYPE_ENUM,
} from '../incident.constants';

/**
 * Una caída de OCSP, de su primer fallo a su recuperación.
 *
 * **Una sola `OPEN` por servicio**, garantizado en la base por el índice único parcial
 * `UQ_service_incidents_open_per_service` (`service` WHERE `status = 'OPEN'`). No es un
 * `UNIQUE (service, status)` porque eso permitiría también una sola `RESOLVED` por servicio, y
 * cada caída posterior tiene que quedar como incidencia nueva, con su propio historial.
 *
 * Las columnas `*_alert_*` son el rastro de los dos únicos correos de la incidencia: si se
 * enviaron, cuándo y cuántas veces se intentó.
 */
@Entity('service_incidents')
export class ServiceIncidentEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  service: string;

  @Column({ type: 'varchar', length: 20 })
  status: INCIDENT_STATUS_ENUM;

  /** Momento del primer fallo conocido; baja si llega un evento anterior. */
  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt: Date;

  /** Momento en que el chequeo de salud vio responder a OCSP. `null` mientras está abierta. */
  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  /** Momento del último fallo registrado, de un intento o del chequeo de salud. */
  @Column({ name: 'last_failure_at', type: 'timestamptz' })
  lastFailureAt: Date;

  @Column({
    name: 'last_error_type',
    type: 'varchar',
    length: 30,
    nullable: true,
  })
  lastErrorType: OCSP_FAILURE_TYPE_ENUM | null;

  /** Intentos de validación afectados: uno por evento `OCSP_VALIDATION_FAILED` distinto. */
  @Column({ name: 'affected_attempts', type: 'integer', default: 0 })
  affectedAttempts: number;

  /** Chequeos de salud del cron que fallaron mientras estuvo abierta. */
  @Column({ name: 'failed_health_checks', type: 'integer', default: 0 })
  failedHealthChecks: number;

  @Column({ name: 'incident_alert_sent', type: 'boolean', default: false })
  incidentAlertSent: boolean;

  @Column({
    name: 'incident_alert_sent_at',
    type: 'timestamptz',
    nullable: true,
  })
  incidentAlertSentAt: Date | null;

  @Column({ name: 'incident_alert_attempts', type: 'integer', default: 0 })
  incidentAlertAttempts: number;

  /** Último intento de enviar el aviso, exitoso o no: marca el ritmo de los reintentos. */
  @Column({
    name: 'incident_alert_last_attempt_at',
    type: 'timestamptz',
    nullable: true,
  })
  incidentAlertLastAttemptAt: Date | null;

  @Column({ name: 'recovery_alert_sent', type: 'boolean', default: false })
  recoveryAlertSent: boolean;

  @Column({
    name: 'recovery_alert_sent_at',
    type: 'timestamptz',
    nullable: true,
  })
  recoveryAlertSentAt: Date | null;

  @Column({ name: 'recovery_alert_attempts', type: 'integer', default: 0 })
  recoveryAlertAttempts: number;

  /** Último intento de enviar la recuperación, exitoso o no: marca el ritmo de los reintentos. */
  @Column({
    name: 'recovery_alert_last_attempt_at',
    type: 'timestamptz',
    nullable: true,
  })
  recoveryAlertLastAttemptAt: Date | null;

  /** Último error de envío de correo, para diagnosticar sin buscar en los logs. */
  @Column({ name: 'last_notification_error', type: 'text', nullable: true })
  lastNotificationError: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
