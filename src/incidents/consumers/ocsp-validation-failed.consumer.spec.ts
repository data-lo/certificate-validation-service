import { Logger } from '@nestjs/common';

import { OCSP_FAILURE_TYPE_ENUM } from '../incident.constants';
import { IncidentNotifier } from '../notifications/incident-notifier.service';
import { IncidentService } from '../services/incident.service';
import { OcspValidationFailedConsumer } from './ocsp-validation-failed.consumer';

const EVENT = {
  eventId: '0b6f2c3e-8d1a-4f5b-9c7e-2a4d6f8b1c3e',
  type: 'OCSP_VALIDATION_FAILED',
  occurredAt: '2026-09-28T18:00:00.000Z',
  service: 'certificate-validation-service',
  errorType: OCSP_FAILURE_TYPE_ENUM.NETWORK_ERROR,
  errorMessage: 'fetch failed',
};

describe('OcspValidationFailedConsumer', () => {
  let recordFailureEvent: jest.Mock;
  let tryDispatch: jest.Mock;
  let consumer: OcspValidationFailedConsumer;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    recordFailureEvent = jest.fn().mockResolvedValue({
      outcome: 'RECORDED',
      incident: { id: 'inc-1', status: 'OPEN', affectedAttempts: 1 },
      late: false,
    });
    tryDispatch = jest.fn().mockResolvedValue(null);
    consumer = new OcspValidationFailedConsumer(
      { recordFailureEvent } as unknown as IncidentService,
      { tryDispatch } as unknown as IncidentNotifier,
    );
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('registra el evento y despacha lo pendiente en cuanto se suma', async () => {
    await consumer.handle(EVENT);

    expect(recordFailureEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: EVENT.eventId }),
    );
    expect(tryDispatch).toHaveBeenCalledTimes(1);
  });

  /** Una reentrega de Kafka no suma y tampoco vuelve a disparar correos. */
  it('un duplicado no despacha correos', async () => {
    recordFailureEvent.mockResolvedValue({ outcome: 'DUPLICATE' });

    await expect(consumer.handle(EVENT)).resolves.toEqual({
      outcome: 'DUPLICATE',
    });
    expect(tryDispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['sin eventId', { ...EVENT, eventId: undefined }],
    ['eventId que no es UUID', { ...EVENT, eventId: 'abc' }],
    ['tipo ajeno', { ...EVENT, type: 'OTHER' }],
    ['servicio ajeno', { ...EVENT, service: 'signature-server' }],
    ['errorType desconocido', { ...EVENT, errorType: 'BOOM' }],
    ['fecha inválida', { ...EVENT, occurredAt: 'ayer' }],
    ['payload nulo', null],
    ['payload de texto', 'hola'],
  ])(
    'descarta un mensaje inválido (%s) sin lanzar',
    async (_label, payload) => {
      await expect(consumer.handle(payload)).resolves.toBeNull();
      expect(recordFailureEvent).not.toHaveBeenCalled();
    },
  );

  it('reintenta si la base falla y registra al segundo intento', async () => {
    recordFailureEvent
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce({ outcome: 'DUPLICATE' });

    const handling = consumer.handle(EVENT);
    await jest.advanceTimersByTimeAsync(500);

    await expect(handling).resolves.toEqual({ outcome: 'DUPLICATE' });
    expect(recordFailureEvent).toHaveBeenCalledTimes(2);
  });

  /** Relanzar hace que Kafka no confirme el offset y lo reentregue; la idempotencia lo vuelve seguro. */
  it('si la base sigue fallando, relanza para que Kafka reentregue', async () => {
    recordFailureEvent.mockRejectedValue(new Error('db down'));

    const handling = consumer.handle(EVENT);
    const assertion = expect(handling).rejects.toThrow('db down');
    await jest.advanceTimersByTimeAsync(2500);
    await assertion;

    expect(recordFailureEvent).toHaveBeenCalledTimes(3);
    expect(tryDispatch).not.toHaveBeenCalled();
  });
});
