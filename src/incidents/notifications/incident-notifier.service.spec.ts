import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DistributedLockService } from '../../common/redis/distributed-lock.service';
import { ServiceIncidentEntity } from '../entities/service-incident.entity';
import {
  INCIDENT_KEY,
  INCIDENT_STATUS_ENUM,
  MAX_NOTIFICATION_ATTEMPTS,
  NOTIFICATION_RETRY_INTERVAL_MS,
} from '../incident.constants';
import { IncidentService } from '../services/incident.service';
import { IncidentEmailService } from './incident-email.service';
import { IncidentNotifier } from './incident-notifier.service';

const OPEN = {
  id: 'inc-open',
  service: 'certificate-validation-service',
  status: INCIDENT_STATUS_ENUM.OPEN,
  startedAt: new Date('2026-09-28T18:00:00Z'),
  resolvedAt: null,
  lastFailureAt: new Date('2026-09-28T18:10:00Z'),
  lastErrorType: null,
  affectedAttempts: 3,
  failedHealthChecks: 0,
  incidentAlertAttempts: 0,
  recoveryAlertAttempts: 0,
} as unknown as ServiceIncidentEntity;

const RESOLVED = {
  ...OPEN,
  id: 'inc-resolved',
  status: INCIDENT_STATUS_ENUM.RESOLVED,
  resolvedAt: new Date('2026-09-28T19:00:00Z'),
} as ServiceIncidentEntity;

describe('IncidentNotifier', () => {
  let incidentService: {
    findAwaitingIncidentAlert: jest.Mock;
    findAwaitingRecoveryAlert: jest.Mock;
    markNotificationSent: jest.Mock;
    recordNotificationFailure: jest.Mock;
  };
  let send: jest.Mock;
  let runExclusive: jest.Mock;
  let notifier: IncidentNotifier;

  beforeEach(() => {
    incidentService = {
      findAwaitingIncidentAlert: jest.fn().mockResolvedValue([]),
      findAwaitingRecoveryAlert: jest.fn().mockResolvedValue([]),
      markNotificationSent: jest.fn(),
      recordNotificationFailure: jest.fn(),
    };
    send = jest.fn().mockResolvedValue(undefined);
    runExclusive = jest.fn(
      async (_key: string, _ttl: number, task: () => Promise<unknown>) => ({
        acquired: true,
        result: await task(),
      }),
    );
    notifier = new IncidentNotifier(
      incidentService as unknown as IncidentService,
      { send } as unknown as IncidentEmailService,
      { runExclusive } as unknown as DistributedLockService,
      { get: () => '3' } as unknown as ConfigService,
    );
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('busca lo pendiente con el umbral, el tope de intentos y el intervalo entre reintentos', async () => {
    await notifier.dispatchPending();

    const before = Date.now();
    expect(incidentService.findAwaitingIncidentAlert).toHaveBeenCalledWith(
      3,
      MAX_NOTIFICATION_ATTEMPTS,
      expect.any(Date),
    );
    expect(incidentService.findAwaitingRecoveryAlert).toHaveBeenCalledWith(
      3,
      MAX_NOTIFICATION_ATTEMPTS,
      expect.any(Date),
    );
    const [, , retryBefore] =
      incidentService.findAwaitingIncidentAlert.mock.calls[0];
    expect(before - retryBefore.getTime()).toBeGreaterThanOrEqual(
      NOTIFICATION_RETRY_INTERVAL_MS - 1000,
    );
  });

  it('envía el aviso de la incidencia abierta y lo marca como enviado', async () => {
    incidentService.findAwaitingIncidentAlert.mockResolvedValue([OPEN]);

    const summary = await notifier.dispatchPending();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].subject).toContain('[Incidencia]');
    expect(incidentService.markNotificationSent).toHaveBeenCalledWith(
      'inc-open',
      'INCIDENT_ALERT',
      expect.any(Date),
    );
    expect(summary).toEqual({ sent: 1, failed: 0 });
  });

  it('envía el resumen de recuperación de la incidencia resuelta', async () => {
    incidentService.findAwaitingRecoveryAlert.mockResolvedValue([RESOLVED]);

    await notifier.dispatchPending();

    expect(send.mock.calls[0][0].subject).toContain('[Recuperado]');
    expect(incidentService.markNotificationSent).toHaveBeenCalledWith(
      'inc-resolved',
      'RECOVERY_ALERT',
      expect.any(Date),
    );
  });

  /** Un correo fallido no se marca: queda pendiente para el siguiente ciclo, con su intento contado. */
  it('si el envío falla, cuenta el intento y no lo marca como enviado', async () => {
    incidentService.findAwaitingIncidentAlert.mockResolvedValue([OPEN]);
    send.mockRejectedValue(new Error('SendGrid 503'));

    const summary = await notifier.dispatchPending();

    expect(incidentService.markNotificationSent).not.toHaveBeenCalled();
    expect(incidentService.recordNotificationFailure).toHaveBeenCalledWith(
      'inc-open',
      'INCIDENT_ALERT',
      'SendGrid 503',
      expect.any(Date),
    );
    expect(summary).toEqual({ sent: 0, failed: 1 });
  });

  it('un correo fallido no impide enviar el siguiente', async () => {
    incidentService.findAwaitingIncidentAlert.mockResolvedValue([OPEN]);
    incidentService.findAwaitingRecoveryAlert.mockResolvedValue([RESOLVED]);
    send.mockRejectedValueOnce(new Error('SendGrid 503'));

    const summary = await notifier.dispatchPending();

    expect(summary).toEqual({ sent: 1, failed: 1 });
  });

  describe('tryDispatch', () => {
    it('toma el lock de la incidencia', async () => {
      await notifier.tryDispatch();

      expect(runExclusive).toHaveBeenCalledWith(
        INCIDENT_KEY,
        expect.any(Number),
        expect.any(Function),
      );
    });

    /** Otra réplica ya está despachando: ésta no envía nada, así no hay correos repetidos. */
    it('no envía nada si otra réplica tiene el lock', async () => {
      runExclusive.mockResolvedValue({ acquired: false });
      incidentService.findAwaitingIncidentAlert.mockResolvedValue([OPEN]);

      await expect(notifier.tryDispatch()).resolves.toBeNull();
      expect(send).not.toHaveBeenCalled();
    });

    it('no lanza si Redis o la base fallan', async () => {
      runExclusive.mockRejectedValue(new Error('redis down'));

      await expect(notifier.tryDispatch()).resolves.toBeNull();
    });
  });
});
