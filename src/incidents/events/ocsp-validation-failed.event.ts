import {
  Equals,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

import {
  MONITORED_SERVICE,
  OCSP_FAILURE_TYPE_ENUM,
  OCSP_VALIDATION_FAILED_EVENT,
} from '../incident.constants';

/** Largo máximo del mensaje de error que viaja en el evento. */
export const MAX_EVENT_ERROR_MESSAGE_LENGTH = 1000;

/**
 * Payload de `certificate-validation.ocsp-validation-failed`: un intento de validación que no
 * pudo consultar OCSP.
 *
 * Es a la vez el contrato del evento y la validación que aplica el consumer: un mensaje que no
 * cumple esta forma se registra y se descarta, en vez de romper el procesamiento del topic.
 */
export class OcspValidationFailedEvent {
  /** UUID único del evento; es la llave de idempotencia del consumer. */
  @IsUUID()
  eventId: string;

  @Equals(OCSP_VALIDATION_FAILED_EVENT)
  type: typeof OCSP_VALIDATION_FAILED_EVENT;

  /** Momento del fallo, ISO-8601. Decide a qué incidencia pertenece el evento. */
  @IsISO8601({ strict: true })
  occurredAt: string;

  @Equals(MONITORED_SERVICE)
  service: typeof MONITORED_SERVICE;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  signingRequestId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  userId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  certificateSerial?: string;

  @IsEnum(OCSP_FAILURE_TYPE_ENUM)
  errorType: OCSP_FAILURE_TYPE_ENUM;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_EVENT_ERROR_MESSAGE_LENGTH)
  errorMessage?: string;
}
