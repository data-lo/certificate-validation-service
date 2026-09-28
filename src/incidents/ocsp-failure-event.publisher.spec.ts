import { Logger } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';

import {
  MONITORED_SERVICE,
  OCSP_FAILURE_TYPE_ENUM,
  OCSP_VALIDATION_FAILED_TOPIC,
} from './incident.constants';
import { OcspFailureEventPublisher } from './ocsp-failure-event.publisher';

describe('OcspFailureEventPublisher', () => {
  let emit: jest.Mock;
  let publisher: OcspFailureEventPublisher;

  beforeEach(() => {
    emit = jest.fn().mockReturnValue(of(undefined));
    publisher = new OcspFailureEventPublisher({
      emit,
      close: jest.fn(),
    } as unknown as ClientKafka);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('publica un OCSP_VALIDATION_FAILED con el contrato mínimo, con el servicio como llave', async () => {
    const event = await publisher.publish(
      new Error(
        'Failed to send OCSP request: Operation timed out after 5000ms',
      ),
      { certificateSerial: 'ABC', signingRequestId: 'doc-1', userId: 'u-1' },
    );

    expect(event).toEqual({
      eventId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      type: 'OCSP_VALIDATION_FAILED',
      occurredAt: expect.any(String),
      service: MONITORED_SERVICE,
      certificateSerial: 'ABC',
      signingRequestId: 'doc-1',
      userId: 'u-1',
      errorType: OCSP_FAILURE_TYPE_ENUM.TIMEOUT,
      errorMessage:
        'Failed to send OCSP request: Operation timed out after 5000ms',
    });
    expect(new Date(event!.occurredAt).toISOString()).toBe(event!.occurredAt);
    expect(emit).toHaveBeenCalledWith(OCSP_VALIDATION_FAILED_TOPIC, {
      key: MONITORED_SERVICE,
      value: event,
    });
  });

  it('genera un eventId distinto por intento', async () => {
    const first = await publisher.publish(new Error('x'));
    const second = await publisher.publish(new Error('x'));

    expect(first!.eventId).not.toBe(second!.eventId);
  });

  it('omite los datos de contexto que no vinieron', async () => {
    const event = await publisher.publish(new Error('x'));

    expect(event).not.toHaveProperty('userId');
    expect(event).not.toHaveProperty('signingRequestId');
    expect(event).not.toHaveProperty('certificateSerial');
  });

  /** Kafka caído no puede convertirse en un error de la validación. */
  it('si Kafka falla, lo registra con el evento completo y no lanza', async () => {
    emit.mockReturnValue(throwError(() => new Error('broker down')));

    await expect(publisher.publish(new Error('x'))).resolves.toBeNull();
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining('Evento perdido'),
    );
  });
});
