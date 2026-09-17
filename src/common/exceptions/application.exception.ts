import { HttpException, HttpStatus } from '@nestjs/common';

import { ERROR_CODE_ENUM } from '../errors/error-code.enum';

/**
 * Base de todas las excepciones conocidas del servicio.
 *
 * Separa lo que ve el consumidor de lo que se registra: `message` es un texto fijo y seguro de
 * exponer, y `internalDetail` (junto con `cause`) guarda el motivo técnico real, que sólo va al log.
 * Así una excepción puede llevar el mensaje de OpenSSL o de la librería OCSP sin que llegue nunca
 * a la respuesta.
 */
export abstract class ApplicationException extends HttpException {
  /**
   * Construye una excepción conocida con su código estable.
   *
   * @param code - Código de error que recibe el consumidor en el campo `code`.
   * @param message - Mensaje en español, seguro de exponer.
   * @param status - Código HTTP de la respuesta.
   * @param internalDetail - Detalle técnico que sólo se registra en el log.
   * @param cause - Error original que motivó la excepción, si lo hay.
   * @returns Una instancia lista para lanzarse.
   *
   * @example
   * ```ts
   * class MyException extends ApplicationException {
   *   constructor() {
   *     super(ERROR_CODE_ENUM.INVALID_REQUEST, 'Solicitud inválida', HttpStatus.BAD_REQUEST);
   *   }
   * }
   * ```
   */
  protected constructor(
    readonly code: ERROR_CODE_ENUM,
    message: string,
    status: HttpStatus,
    readonly internalDetail?: string,
    cause?: unknown,
  ) {
    super(message, status, { cause });
  }
}
