import { HttpStatus } from '@nestjs/common';

import { ERROR_CODE_ENUM } from '../errors/error-code.enum';
import { ApplicationException } from './application.exception';

/**
 * API Key ausente o inválida.
 *
 * Un solo código para los dos casos a propósito: distinguir "no la mandaste" de "la mandaste mal"
 * sólo le sirve a quien está probando claves. El caso concreto queda en el log.
 */
export class InvalidApiKeyException extends ApplicationException {
  /**
   * @param internalDetail - Qué falló exactamente (ausente o distinta); sólo para el log.
   * @returns La excepción con código `INVALID_API_KEY` y estado 401.
   *
   * @example
   * ```ts
   * throw new InvalidApiKeyException('Header x-api-key ausente');
   * ```
   */
  constructor(internalDetail?: string) {
    super(
      ERROR_CODE_ENUM.INVALID_API_KEY,
      'La API Key es inválida o no fue proporcionada',
      HttpStatus.UNAUTHORIZED,
      internalDetail,
    );
  }
}

/**
 * La petición no cumple el contrato del endpoint (DTO).
 */
export class InvalidRequestException extends ApplicationException {
  /**
   * @param internalDetail - Restricciones que fallaron, tal como las reporta class-validator.
   * @returns La excepción con código `INVALID_REQUEST` y estado 400.
   *
   * @example
   * ```ts
   * throw new InvalidRequestException('certificate must be base64 encoded');
   * ```
   */
  constructor(internalDetail?: string) {
    super(
      ERROR_CODE_ENUM.INVALID_REQUEST,
      'La solicitud no tiene el formato esperado',
      HttpStatus.BAD_REQUEST,
      internalDetail,
    );
  }
}

/**
 * Error no previsto durante la validación.
 *
 * Es el destino de cualquier cosa que no sea una excepción conocida: su mensaje nunca incluye el
 * error original, que se conserva en `cause` para el log.
 */
export class UnexpectedValidationException extends ApplicationException {
  /**
   * @param cause - Error original que no tenía traducción conocida.
   * @returns La excepción con código `CERTIFICATE_VALIDATION_ERROR` y estado 500.
   *
   * @example
   * ```ts
   * throw new UnexpectedValidationException(error);
   * ```
   */
  constructor(cause?: unknown) {
    super(
      ERROR_CODE_ENUM.CERTIFICATE_VALIDATION_ERROR,
      'Ocurrió un error inesperado al validar el certificado',
      HttpStatus.INTERNAL_SERVER_ERROR,
      undefined,
      cause,
    );
  }
}
