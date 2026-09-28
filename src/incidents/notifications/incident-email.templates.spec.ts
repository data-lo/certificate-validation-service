import { ServiceIncidentEntity } from '../entities/service-incident.entity';
import {
  INCIDENT_STATUS_ENUM,
  OCSP_FAILURE_TYPE_ENUM,
} from '../incident.constants';
import {
  buildIncidentAlertEmail,
  buildRecoveryAlertEmail,
  formatDuration,
  formatEmailDate,
} from './incident-email.templates';

function incident(
  overrides: Partial<ServiceIncidentEntity> = {},
): ServiceIncidentEntity {
  return {
    id: 'inc-1',
    service: 'certificate-validation-service',
    status: INCIDENT_STATUS_ENUM.RESOLVED,
    startedAt: new Date('2026-09-28T18:00:00.000Z'),
    resolvedAt: new Date('2026-09-28T19:05:03.000Z'),
    lastFailureAt: new Date('2026-09-28T19:00:00.000Z'),
    lastErrorType: OCSP_FAILURE_TYPE_ENUM.TIMEOUT,
    affectedAttempts: 17,
    failedHealthChecks: 12,
    incidentAlertSent: true,
    incidentAlertSentAt: null,
    incidentAlertAttempts: 1,
    incidentAlertLastAttemptAt: null,
    recoveryAlertSent: false,
    recoveryAlertSentAt: null,
    recoveryAlertAttempts: 0,
    recoveryAlertLastAttemptAt: null,
    lastNotificationError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('formatDuration', () => {
  it.each([
    [0, '0 s'],
    [42_000, '42 s'],
    [125_000, '2 min 5 s'],
    [3_903_000, '1 h 5 min 3 s'],
    [3_600_000, '1 h 0 min 0 s'],
    [-5_000, '0 s'],
  ])('%i ms → %s', (milliseconds, expected) => {
    expect(formatDuration(milliseconds)).toBe(expected);
  });
});

describe('buildRecoveryAlertEmail', () => {
  it('incluye inicio, recuperación, duración e intentos afectados', () => {
    const email = buildRecoveryAlertEmail(incident());

    expect(email.subject).toContain('[Recuperado]');
    expect(email.text).toContain(
      `Inicio: ${formatEmailDate(new Date('2026-09-28T18:00:00.000Z'))}`,
    );
    expect(email.text).toContain(
      `Recuperación: ${formatEmailDate(new Date('2026-09-28T19:05:03.000Z'))}`,
    );
    expect(email.text).toContain('Duración: 1 h 5 min 3 s');
    expect(email.text).toContain('Intentos de firma afectados: 17');
    expect(email.html).toContain('17');
  });

  it('muestra las fechas en la hora de Ciudad de México', () => {
    expect(formatEmailDate(new Date('2026-09-28T18:00:00.000Z'))).toMatch(
      /12:00:00/,
    );
  });

  it('se niega a armar el resumen de una incidencia sin resolver', () => {
    expect(() =>
      buildRecoveryAlertEmail(
        incident({ status: INCIDENT_STATUS_ENUM.OPEN, resolvedAt: null }),
      ),
    ).toThrow(/no está resuelta/);
  });
});

describe('buildIncidentAlertEmail', () => {
  it('avisa la caída con su causa y la promesa de un solo correo de recuperación', () => {
    const email = buildIncidentAlertEmail(
      incident({ status: INCIDENT_STATUS_ENUM.OPEN, resolvedAt: null }),
    );

    expect(email.subject).toContain('[Incidencia]');
    expect(email.text).toContain('Tiempo de espera agotado (TIMEOUT)');
    expect(email.text).toContain('Intentos de firma afectados: 17');
    expect(email.text).toContain('un solo correo cuando se recupere');
  });

  it('escapa el HTML de los valores', () => {
    const email = buildIncidentAlertEmail(
      incident({ service: '<script>x</script>', resolvedAt: null }),
    );

    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
  });
});
