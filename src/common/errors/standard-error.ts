import { HttpException, HttpStatus, Logger } from '@nestjs/common';

import { ApplicationException } from '../exceptions/application.exception';
import {
  InvalidRequestException,
  UnexpectedValidationException,
} from '../exceptions/common.exceptions';
import { ERROR_CODE_ENUM } from './error-code.enum';
import { ErrorResponseDto } from './error-response.dto';

const logger = new Logger('ErrorResponse');

/**
 * `HttpException` cuyo cuerpo YA es la estructura estándar.
 *
 * La produce el interceptor global; el filtro global la reconoce y la escribe tal cual, sin volver
 * a traducirla ni a registrarla.
 */
export class StandardErrorHttpException extends HttpException {
  /**
   * @param body - Respuesta de error ya armada.
   * @returns Una excepción cuyo `getResponse()` es `body`.
   *
   * @example
   * ```ts
   * throw new StandardErrorHttpException(toErrorResponse(error, '/api/v1/certificates/validate'));
   * ```
   */
  constructor(readonly body: ErrorResponseDto) {
    super(body, body.statusCode);
  }
}

/**
 * Traduce cualquier error a la estructura estándar y registra el error original.
 *
 * Reglas:
 * - Una `ApplicationException` conserva su código, estado y mensaje (todos seguros de exponer).
 * - Una `HttpException` genérica de Nest (ruta inexistente, cuerpo JSON mal formado) recibe un
 *   código por su estado y un mensaje FIJO: su mensaje original puede describir internals.
 * - Cualquier otra cosa es un 500 `CERTIFICATE_VALIDATION_ERROR`.
 *
 * El log lleva el detalle técnico y, en los 5xx, la pila; la respuesta nunca. Los 4xx se registran
 * como advertencia porque son fallos del consumidor o del certificado, no del servicio.
 *
 * @param error - Lo que se haya lanzado.
 * @param path - Ruta de la petición, para la respuesta y el log.
 * @returns La respuesta de error estándar, con `timestamp` del momento de la traducción.
 *
 * @example
 * ```ts
 * const body = toErrorResponse(new InvalidApiKeyException(), '/api/v1/certificates/validate');
 * // body.code === 'INVALID_API_KEY', body.statusCode === 401
 * ```
 */
export function toErrorResponse(
  error: unknown,
  path: string,
): ErrorResponseDto {
  const known = toApplicationException(error);
  const statusCode = known.getStatus();

  const body: ErrorResponseDto = {
    statusCode,
    code: known.code,
    message: known.message,
    timestamp: new Date().toISOString(),
    path,
  };

  logError(body, known, error);

  return body;
}

function toApplicationException(error: unknown): ApplicationException {
  if (error instanceof ApplicationException) {
    return error;
  }

  if (error instanceof HttpException) {
    const status = error.getStatus();
    const detail = describe(error);

    if (status === HttpStatus.NOT_FOUND) {
      return new ResourceNotFoundException(detail);
    }

    if (status >= 400 && status < 500) {
      // Cuerpo JSON ilegible, demasiado grande, método no permitido...: todo es un problema de
      // forma de la petición y el consumidor lo trata igual.
      return new InvalidRequestException(detail);
    }
  }

  return new UnexpectedValidationException(error);
}

function logError(
  body: ErrorResponseDto,
  known: ApplicationException,
  original: unknown,
): void {
  const summary = `${body.statusCode} ${body.code} en ${body.path}`;
  const detail = known.internalDetail ?? describe(known.cause ?? original);
  const line = detail ? `${summary}: ${detail}` : summary;

  if (body.statusCode >= 500) {
    const stack = original instanceof Error ? original.stack : undefined;
    const causeStack =
      known.cause instanceof Error ? known.cause.stack : undefined;
    logger.error(line, causeStack ?? stack);
    return;
  }

  logger.warn(line);
}

function describe(error: unknown): string | undefined {
  if (error instanceof ApplicationException) {
    return error.internalDetail;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return error === undefined ? undefined : String(error);
}

/**
 * Ruta inexistente. Vive aquí y no con las demás porque sólo la produce la traducción de los
 * `NotFoundException` que lanza el router de Nest.
 */
class ResourceNotFoundException extends ApplicationException {
  constructor(internalDetail?: string) {
    super(
      ERROR_CODE_ENUM.RESOURCE_NOT_FOUND,
      'El recurso solicitado no existe',
      HttpStatus.NOT_FOUND,
      internalDetail,
    );
  }
}
