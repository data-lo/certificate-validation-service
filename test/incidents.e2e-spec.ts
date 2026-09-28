import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { buildDatabaseOptions } from '../src/database/database.config';
import { OcspValidationFailedEvent } from '../src/incidents/events/ocsp-validation-failed.event';
import {
  INCIDENT_STATUS_ENUM,
  MONITORED_SERVICE,
  OCSP_FAILURE_TYPE_ENUM,
} from '../src/incidents/incident.constants';
import { IncidentService } from '../src/incidents/services/incident.service';

/**
 * `IncidentService` contra un Postgres de verdad: la idempotencia, la incidencia única y los
 * contadores se garantizan con restricciones y sentencias de la base, así que sólo se pueden
 * probar ahí.
 *
 * Crea una base desechable (`certificate_validation_it_<random>`) con las migraciones del servicio
 * y la borra al terminar; nunca toca la base de desarrollo. Conexión: `DB_HOST`, `DB_PORT`,
 * `DB_USER`, `DB_PASSWORD` (por defecto, el `signature_postgres` local en 5434).
 */
const connection = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5434,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
};
const DATABASE = `certificate_validation_it_${randomUUID().slice(0, 8)}`;

/** `retryBefore` que no descarta nada intentado hasta ahora. */
const NOW = new Date(Date.now() + 60_000);
/** Un intento lo bastante viejo como para poder reintentarse. */
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');

async function admin(sql: string): Promise<void> {
  const client = new Client({ ...connection, database: 'postgres' });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

function failureEvent(
  overrides: Partial<OcspValidationFailedEvent> = {},
): OcspValidationFailedEvent {
  return {
    eventId: randomUUID(),
    type: 'OCSP_VALIDATION_FAILED',
    occurredAt: new Date().toISOString(),
    service: MONITORED_SERVICE,
    errorType: OCSP_FAILURE_TYPE_ENUM.TIMEOUT,
    errorMessage: 'Operation timed out',
    ...overrides,
  };
}

describe('IncidentService (Postgres)', () => {
  let dataSource: DataSource;
  let service: IncidentService;

  beforeAll(async () => {
    await admin(`CREATE DATABASE "${DATABASE}"`);
    dataSource = new DataSource(
      buildDatabaseOptions({
        DB_HOST: connection.host,
        DB_PORT: String(connection.port),
        DB_USER: connection.user,
        DB_PASSWORD: connection.password,
        DB_NAME: DATABASE,
      }),
    );
    await dataSource.initialize();
    await dataSource.runMigrations();
    service = new IncidentService(dataSource);
  });

  afterAll(async () => {
    await dataSource?.destroy();
    await admin(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE "ocsp_failure_events", "service_incidents"',
    );
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('un fallo abre una incidencia OPEN con un intento afectado y conserva el evento', async () => {
    const event = failureEvent({
      userId: 'user-1',
      signingRequestId: 'doc-1',
      certificateSerial: 'ABC',
    });

    const result = await service.recordFailureEvent(event);

    expect(result.outcome).toBe('RECORDED');
    if (result.outcome !== 'RECORDED') return;
    expect(result.incident).toMatchObject({
      service: MONITORED_SERVICE,
      status: INCIDENT_STATUS_ENUM.OPEN,
      affectedAttempts: 1,
      lastErrorType: OCSP_FAILURE_TYPE_ENUM.TIMEOUT,
      incidentAlertSent: false,
      recoveryAlertSent: false,
    });
    expect(result.incident.startedAt.toISOString()).toBe(event.occurredAt);

    const [stored] = await dataSource.query(
      'SELECT * FROM "ocsp_failure_events" WHERE "event_id" = $1',
      [event.eventId],
    );
    expect(stored).toMatchObject({
      incident_id: result.incident.id,
      user_id: 'user-1',
      signing_request_id: 'doc-1',
      certificate_serial: 'ABC',
      error_type: 'TIMEOUT',
    });
  });

  it('muchos fallos durante la misma caída suman a UNA sola incidencia abierta', async () => {
    for (let i = 0; i < 5; i++) {
      await service.recordFailureEvent(failureEvent());
    }

    const incidents = await dataSource.query(
      'SELECT "status", "affected_attempts" FROM "service_incidents"',
    );
    expect(incidents).toEqual([{ status: 'OPEN', affected_attempts: 5 }]);
  });

  /** Dos réplicas procesando el primer fallo a la vez no pueden abrir dos incidencias. */
  it('fallos concurrentes siguen dejando una sola incidencia abierta', async () => {
    await Promise.all(
      Array.from({ length: 20 }, () =>
        service.recordFailureEvent(failureEvent()),
      ),
    );

    const incidents = await dataSource.query(
      'SELECT "affected_attempts" FROM "service_incidents" WHERE "status" = \'OPEN\'',
    );
    expect(incidents).toEqual([{ affected_attempts: 20 }]);
  });

  it('un evento duplicado de Kafka no incrementa dos veces el contador', async () => {
    const event = failureEvent();

    const first = await service.recordFailureEvent(event);
    const second = await service.recordFailureEvent(event);
    const concurrent = await Promise.all([
      service.recordFailureEvent(event),
      service.recordFailureEvent(event),
    ]);

    expect(first.outcome).toBe('RECORDED');
    expect(second).toEqual({ outcome: 'DUPLICATE' });
    expect(concurrent).toEqual([
      { outcome: 'DUPLICATE' },
      { outcome: 'DUPLICATE' },
    ]);
    const [incident] = await dataSource.query(
      'SELECT "affected_attempts" FROM "service_incidents"',
    );
    expect(incident.affected_attempts).toBe(1);
  });

  /** La restricción de la base es la última línea de defensa, no sólo el código. */
  it('la base rechaza una segunda incidencia OPEN del mismo servicio', async () => {
    await service.recordFailureEvent(failureEvent());

    await expect(
      dataSource.query(
        `INSERT INTO "service_incidents" ("service", "status", "started_at", "last_failure_at")
         VALUES ($1, 'OPEN', now(), now())`,
        [MONITORED_SERVICE],
      ),
    ).rejects.toThrow(/UQ_service_incidents_open_per_service/);
  });

  it('al recuperarse se cierra, y un fallo posterior abre una incidencia NUEVA', async () => {
    const first = await service.recordFailureEvent(
      failureEvent({ occurredAt: '2026-09-28T18:00:00.000Z' }),
    );
    if (first.outcome !== 'RECORDED') throw new Error('esperaba RECORDED');

    const resolved = await service.resolveIncident(
      first.incident.id,
      new Date('2026-09-28T18:30:00.000Z'),
    );
    expect(resolved).toMatchObject({ status: INCIDENT_STATUS_ENUM.RESOLVED });
    expect(resolved!.resolvedAt!.toISOString()).toBe(
      '2026-09-28T18:30:00.000Z',
    );
    await expect(service.findOpenIncident()).resolves.toBeNull();

    const later = await service.recordFailureEvent(
      failureEvent({ occurredAt: '2026-09-28T19:00:00.000Z' }),
    );
    if (later.outcome !== 'RECORDED') throw new Error('esperaba RECORDED');

    expect(later.incident.id).not.toBe(first.incident.id);
    expect(later.incident).toMatchObject({
      status: INCIDENT_STATUS_ENUM.OPEN,
      affectedAttempts: 1,
    });
    const statuses = await dataSource.query(
      'SELECT "status" FROM "service_incidents" ORDER BY "started_at"',
    );
    expect(statuses).toEqual([{ status: 'RESOLVED' }, { status: 'OPEN' }]);
  });

  it('cerrar dos veces la misma incidencia sólo la cierra la primera', async () => {
    const result = await service.recordFailureEvent(failureEvent());
    if (result.outcome !== 'RECORDED') throw new Error('esperaba RECORDED');

    const [a, b] = await Promise.all([
      service.resolveIncident(result.incident.id, new Date()),
      service.resolveIncident(result.incident.id, new Date()),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  /** El consumer iba atrasado: la caída de ese fallo ya terminó y no debe reabrirse. */
  it('un evento tardío se suma a la incidencia ya resuelta, sin abrir otra', async () => {
    const first = await service.recordFailureEvent(
      failureEvent({ occurredAt: '2026-09-28T18:00:00.000Z' }),
    );
    if (first.outcome !== 'RECORDED') throw new Error('esperaba RECORDED');
    await service.resolveIncident(
      first.incident.id,
      new Date('2026-09-28T18:30:00.000Z'),
    );

    const late = await service.recordFailureEvent(
      failureEvent({ occurredAt: '2026-09-28T17:55:00.000Z' }),
    );

    expect(late).toMatchObject({ outcome: 'RECORDED', late: true });
    if (late.outcome !== 'RECORDED') return;
    expect(late.incident.id).toBe(first.incident.id);
    expect(late.incident.affectedAttempts).toBe(2);
    expect(late.incident.startedAt.toISOString()).toBe(
      '2026-09-28T17:55:00.000Z',
    );
    await expect(service.findOpenIncident()).resolves.toBeNull();
  });

  it('un evento anterior al primero conocido adelanta el inicio de la incidencia abierta', async () => {
    await service.recordFailureEvent(
      failureEvent({ occurredAt: '2026-09-28T18:10:00.000Z' }),
    );
    const earlier = await service.recordFailureEvent(
      failureEvent({ occurredAt: '2026-09-28T18:00:00.000Z' }),
    );
    if (earlier.outcome !== 'RECORDED') throw new Error('esperaba RECORDED');

    expect(earlier.incident.startedAt.toISOString()).toBe(
      '2026-09-28T18:00:00.000Z',
    );
    expect(earlier.incident.lastFailureAt.toISOString()).toBe(
      '2026-09-28T18:10:00.000Z',
    );
  });

  describe('correos pendientes', () => {
    it('el aviso se pide sólo al alcanzar el umbral, contando chequeos fallidos', async () => {
      const result = await service.recordFailureEvent(failureEvent());
      if (result.outcome !== 'RECORDED') throw new Error('esperaba RECORDED');
      await service.recordFailureEvent(failureEvent());

      await expect(
        service.findAwaitingIncidentAlert(3, 10, NOW),
      ).resolves.toEqual([]);

      await service.recordFailedHealthCheck(
        result.incident.id,
        OCSP_FAILURE_TYPE_ENUM.NETWORK_ERROR,
        new Date(),
      );

      const pending = await service.findAwaitingIncidentAlert(3, 10, NOW);
      expect(pending.map((incident) => incident.id)).toEqual([
        result.incident.id,
      ]);
      expect(pending[0]).toMatchObject({
        failedHealthChecks: 1,
        lastErrorType: OCSP_FAILURE_TYPE_ENUM.NETWORK_ERROR,
      });
    });

    /** Una vez enviado el aviso, ningún fallo más de la misma incidencia lo vuelve a pedir. */
    it('un aviso ya enviado no se vuelve a pedir aunque sigan los fallos', async () => {
      const result = await service.recordFailureEvent(failureEvent());
      if (result.outcome !== 'RECORDED') throw new Error('esperaba RECORDED');
      await service.markNotificationSent(
        result.incident.id,
        'INCIDENT_ALERT',
        new Date(),
      );

      for (let i = 0; i < 5; i++) {
        await service.recordFailureEvent(failureEvent());
      }

      await expect(
        service.findAwaitingIncidentAlert(1, 10, NOW),
      ).resolves.toEqual([]);
    });

    it('la recuperación se pide una sola vez, y sólo si la incidencia llegó al umbral', async () => {
      const small = await service.recordFailureEvent(
        failureEvent({ occurredAt: '2026-09-28T10:00:00.000Z' }),
      );
      if (small.outcome !== 'RECORDED') throw new Error('esperaba RECORDED');
      await service.resolveIncident(
        small.incident.id,
        new Date('2026-09-28T10:05:00.000Z'),
      );

      const big = await service.recordFailureEvent(
        failureEvent({ occurredAt: '2026-09-28T11:00:00.000Z' }),
      );
      if (big.outcome !== 'RECORDED') throw new Error('esperaba RECORDED');
      await service.markNotificationSent(
        big.incident.id,
        'INCIDENT_ALERT',
        new Date(),
      );
      await service.resolveIncident(
        big.incident.id,
        new Date('2026-09-28T11:30:00.000Z'),
      );

      const pending = await service.findAwaitingRecoveryAlert(3, 10, NOW);
      expect(pending.map((incident) => incident.id)).toEqual([big.incident.id]);

      await service.markNotificationSent(
        big.incident.id,
        'RECOVERY_ALERT',
        new Date(),
      );
      await expect(
        service.findAwaitingRecoveryAlert(3, 10, NOW),
      ).resolves.toEqual([]);
    });

    /** Una ráfaga de eventos con SendGrid caído no debe agotar los intentos en segundos. */
    it('un correo que acaba de fallar no se reintenta hasta que pasa el intervalo', async () => {
      const result = await service.recordFailureEvent(failureEvent());
      if (result.outcome !== 'RECORDED') throw new Error('esperaba RECORDED');
      const failedAt = new Date('2026-09-28T18:00:00.000Z');

      await service.recordNotificationFailure(
        result.incident.id,
        'INCIDENT_ALERT',
        'SendGrid 503',
        failedAt,
      );

      await expect(
        service.findAwaitingIncidentAlert(
          1,
          10,
          new Date('2026-09-28T17:59:00.000Z'),
        ),
      ).resolves.toEqual([]);
      const due = await service.findAwaitingIncidentAlert(
        1,
        10,
        new Date('2026-09-28T18:04:00.000Z'),
      );
      expect(due.map((incident) => incident.id)).toEqual([result.incident.id]);
    });

    it('deja de insistir al llegar al tope de intentos y guarda el último error', async () => {
      const result = await service.recordFailureEvent(failureEvent());
      if (result.outcome !== 'RECORDED') throw new Error('esperaba RECORDED');

      await service.recordNotificationFailure(
        result.incident.id,
        'INCIDENT_ALERT',
        'SendGrid 503',
        LONG_AGO,
      );
      await service.recordNotificationFailure(
        result.incident.id,
        'INCIDENT_ALERT',
        'SendGrid 401',
        LONG_AGO,
      );

      await expect(
        service.findAwaitingIncidentAlert(1, 2, NOW),
      ).resolves.toEqual([]);
      const [row] = await service.findRecent(1);
      expect(row).toMatchObject({
        incidentAlertAttempts: 2,
        incidentAlertSent: false,
        lastNotificationError: 'SendGrid 401',
      });
    });
  });
});
