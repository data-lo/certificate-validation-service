import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import { OCSP_FAILURE_TYPE_ENUM } from '../incident.constants';

/**
 * Cada evento `OCSP_VALIDATION_FAILED` procesado, conservado para auditoría.
 *
 * La llave primaria es el `eventId` del evento: es lo que hace idempotente al consumer. Una
 * segunda entrega del mismo mensaje choca contra la llave y no vuelve a sumar en
 * `service_incidents.affected_attempts`.
 */
@Entity('ocsp_failure_events')
export class OcspFailureEventEntity {
  @PrimaryColumn({ name: 'event_id', type: 'uuid' })
  eventId: string;

  /**
   * Incidencia a la que se sumó. Nullable sólo por el orden de escritura: el renglón se inserta
   * primero —para reclamar el `eventId`— y se asigna dentro de la misma transacción.
   */
  @Column({ name: 'incident_id', type: 'uuid', nullable: true })
  incidentId: string | null;

  @Column({ type: 'varchar', length: 100 })
  service: string;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  @Column({ name: 'error_type', type: 'varchar', length: 30 })
  errorType: OCSP_FAILURE_TYPE_ENUM;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({
    name: 'signing_request_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  signingRequestId: string | null;

  @Column({ name: 'user_id', type: 'varchar', length: 255, nullable: true })
  userId: string | null;

  @Column({
    name: 'certificate_serial',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  certificateSerial: string | null;

  /** Momento en que el consumer lo procesó; la diferencia con `occurredAt` es el retraso de Kafka. */
  @CreateDateColumn({ name: 'processed_at', type: 'timestamptz' })
  processedAt: Date;
}
