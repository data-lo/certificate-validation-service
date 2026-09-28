import { Logger } from '@nestjs/common';

import { ServiceIncidentEntity } from '../entities/service-incident.entity';
import { OCSP_FAILURE_TYPE_ENUM } from '../incident.constants';
import { IncidentNotifier } from '../notifications/incident-notifier.service';
import { IncidentMonitorService } from './incident-monitor.service';
import { IncidentService } from './incident.service';
import { OcspHealthCheckService } from './ocsp-health-check.service';

const OPEN = {
  id: 'inc-1',
  startedAt: new Date('2026-09-28T18:00:00Z'),
  affectedAttempts: 5,
  failedHealthChecks: 1,
} as ServiceIncidentEntity;

describe('IncidentMonitorService.runCycle', () => {
  let incidentService: {
    findOpenIncident: jest.Mock;
    resolveIncident: jest.Mock;
    recordFailedHealthCheck: jest.Mock;
  };
  let check: jest.Mock;
  let dispatchPending: jest.Mock;
  let monitor: IncidentMonitorService;

  beforeEach(() => {
    incidentService = {
      findOpenIncident: jest.fn().mockResolvedValue(OPEN),
      resolveIncident: jest.fn().mockResolvedValue(OPEN),
      recordFailedHealthCheck: jest.fn().mockResolvedValue(OPEN),
    };
    check = jest.fn().mockResolvedValue({ healthy: true });
    dispatchPending = jest.fn().mockResolvedValue({ sent: 0, failed: 0 });
    monitor = new IncidentMonitorService(
      incidentService as unknown as IncidentService,
      { check } as unknown as OcspHealthCheckService,
      { dispatchPending } as unknown as IncidentNotifier,
    );
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('sin incidencia abierta no consulta OCSP, pero despacha correos pendientes', async () => {
    incidentService.findOpenIncident.mockResolvedValue(null);

    const summary = await monitor.runCycle();

    expect(check).not.toHaveBeenCalled();
    expect(dispatchPending).toHaveBeenCalledTimes(1);
    expect(summary.outcome).toBe('NO_INCIDENT');
  });

  it('si OCSP responde, cierra la incidencia y despacha el resumen', async () => {
    const summary = await monitor.runCycle();

    expect(incidentService.resolveIncident).toHaveBeenCalledWith(
      'inc-1',
      expect.any(Date),
    );
    expect(incidentService.recordFailedHealthCheck).not.toHaveBeenCalled();
    expect(dispatchPending).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ outcome: 'RESOLVED', incidentId: 'inc-1' });
  });

  it('si OCSP sigue fallando, mantiene la incidencia abierta y suma el chequeo', async () => {
    check.mockResolvedValue({
      healthy: false,
      errorType: OCSP_FAILURE_TYPE_ENUM.TIMEOUT,
      errorMessage: 'timeout',
    });

    const summary = await monitor.runCycle();

    expect(incidentService.resolveIncident).not.toHaveBeenCalled();
    expect(incidentService.recordFailedHealthCheck).toHaveBeenCalledWith(
      'inc-1',
      OCSP_FAILURE_TYPE_ENUM.TIMEOUT,
      expect.any(Date),
    );
    expect(summary.outcome).toBe('STILL_FAILING');
  });
});
