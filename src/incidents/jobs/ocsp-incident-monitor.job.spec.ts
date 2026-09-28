import { Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { ScheduleModule } from '@nestjs/schedule';

import { DistributedLockService } from '../../common/redis/distributed-lock.service';
import { INCIDENT_KEY } from '../incident.constants';
import { IncidentMonitorService } from '../services/incident-monitor.service';
import {
  MONITOR_CYCLE_MS,
  MONITOR_LOCK_WAIT_MS,
  OCSP_INCIDENT_MONITOR_JOB,
  OcspIncidentMonitorJob,
  monitorCycleKey,
} from './ocsp-incident-monitor.job';

describe('OcspIncidentMonitorJob', () => {
  let runExclusive: jest.Mock;
  let claimOnce: jest.Mock;
  let runCycle: jest.Mock;
  let job: OcspIncidentMonitorJob;

  beforeEach(() => {
    runCycle = jest.fn().mockResolvedValue({
      outcome: 'RESOLVED',
      incidentId: 'inc-1',
      notifications: { sent: 1, failed: 0 },
    });
    runExclusive = jest.fn(
      async (_key: string, _ttl: number, task: () => Promise<unknown>) => ({
        acquired: true,
        result: await task(),
      }),
    );
    claimOnce = jest.fn().mockResolvedValue(true);
    job = new OcspIncidentMonitorJob(
      { runExclusive, claimOnce } as unknown as DistributedLockService,
      { runCycle } as unknown as IncidentMonitorService,
    );
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('reclama el ciclo y lo ejecuta bajo el lock de la incidencia, esperando si está ocupado', async () => {
    await expect(job.run()).resolves.toMatchObject({ outcome: 'RESOLVED' });

    expect(claimOnce).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${INCIDENT_KEY}:cycle:[0-9]+$`)),
      2 * MONITOR_CYCLE_MS,
    );
    expect(runExclusive).toHaveBeenCalledWith(
      INCIDENT_KEY,
      expect.any(Number),
      expect.any(Function),
      { waitMs: MONITOR_LOCK_WAIT_MS },
    );
  });

  /** Con varias réplicas, sólo la que reclama el ciclo chequea, cierra y notifica. */
  it('si otra réplica ya reclamó el ciclo, no lo ejecuta', async () => {
    claimOnce.mockResolvedValue(false);

    await expect(job.run()).resolves.toBeNull();
    expect(runExclusive).not.toHaveBeenCalled();
    expect(runCycle).not.toHaveBeenCalled();
  });

  it('si el lock de la incidencia no se libera a tiempo, omite el ciclo', async () => {
    runExclusive.mockResolvedValue({ acquired: false });

    await expect(job.run()).resolves.toBeNull();
    expect(runCycle).not.toHaveBeenCalled();
  });

  /** Réplicas con relojes desfasados unos segundos deben caer en la misma llave. */
  it('la llave del ciclo tolera el desfase de reloj entre réplicas', () => {
    expect(monitorCycleKey(new Date('2026-09-28T21:39:57Z'))).toBe(
      monitorCycleKey(new Date('2026-09-28T21:40:03Z')),
    );
    expect(monitorCycleKey(new Date('2026-09-28T21:40:00Z'))).not.toBe(
      monitorCycleKey(new Date('2026-09-28T21:45:00Z')),
    );
  });

  it('un ciclo fallido no lanza: se reintenta en el siguiente', async () => {
    runCycle.mockRejectedValue(new Error('db down'));

    await expect(job.run()).resolves.toBeNull();
  });

  it('queda programado cada 5 minutos', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        OcspIncidentMonitorJob,
        {
          provide: DistributedLockService,
          useValue: { runExclusive, claimOnce },
        },
        { provide: IncidentMonitorService, useValue: { runCycle } },
      ],
    }).compile();
    await moduleRef.init();

    const cronJob = moduleRef
      .get(SchedulerRegistry)
      .getCronJob(OCSP_INCIDENT_MONITOR_JOB);
    expect(cronJob.cronTime.source).toBe('0 */5 * * * *');

    await moduleRef.close();
  });
});
