import { HttpStatus } from '@nestjs/common';

import { ERROR_CODE_ENUM } from '../../common/errors/error-code.enum';
import { ApplicationException } from '../../common/exceptions/application.exception';

/**
 * Excepciones de la validación de certificados.
 *
 * Son la versión de este servicio de las que ya existían en `signature-server`
 * (`src/efirma/efirma.exceptions.ts`): mismos casos y mismos estados HTTP (422 para un certificado
 * que no se acepta, 503 para el SAT caído), pero con código estable y sin detalles técnicos en el
 * mensaje. Del lado de `signature-server`, cada código se vuelve a traducir a su excepción original.
 *
 * `INVALID_CERTIFICATE` responde 400 y no 422: lo que llegó no es un certificado, así que es un
 * error de forma de la petición, no un certificado que se rechaza.
 */

/** El contenido recibido no es un certificado X.509 legible. */
export class InvalidCertificateException extends ApplicationException {
  /**
   * @param cause - Error de OpenSSL al interpretar el certificado; sólo para el log.
   * @returns La excepción con código `INVALID_CERTIFICATE` y estado 400.
   *
   * @example
   * ```ts
   * throw new InvalidCertificateException(error);
   * ```
   */
  constructor(cause?: unknown) {
    super(
      ERROR_CODE_ENUM.INVALID_CERTIFICATE,
      'El certificado proporcionado no es válido',
      HttpStatus.BAD_REQUEST,
      undefined,
      cause,
    );
  }
}

/** La fecha de referencia es posterior al fin de la vigencia. */
export class CertificateExpiredException extends ApplicationException {
  /**
   * @param notAfter - Fin de la vigencia del certificado.
   * @returns La excepción con código `CERTIFICATE_EXPIRED` y estado 422.
   *
   * @example
   * ```ts
   * throw new CertificateExpiredException(new Date(certificate.validTo));
   * ```
   */
  constructor(notAfter: Date) {
    super(
      ERROR_CODE_ENUM.CERTIFICATE_EXPIRED,
      'El certificado está vencido',
      HttpStatus.UNPROCESSABLE_ENTITY,
      `Vigente hasta ${notAfter.toISOString()}`,
    );
  }
}

/** La fecha de referencia es anterior al inicio de la vigencia. */
export class CertificateNotYetValidException extends ApplicationException {
  /**
   * @param notBefore - Inicio de la vigencia del certificado.
   * @returns La excepción con código `CERTIFICATE_NOT_YET_VALID` y estado 422.
   *
   * @example
   * ```ts
   * throw new CertificateNotYetValidException(new Date(certificate.validFrom));
   * ```
   */
  constructor(notBefore: Date) {
    super(
      ERROR_CODE_ENUM.CERTIFICATE_NOT_YET_VALID,
      'El certificado todavía no está vigente',
      HttpStatus.UNPROCESSABLE_ENTITY,
      `Vigente desde ${notBefore.toISOString()}`,
    );
  }
}

/** El certificado no encadena a una AC de confianza del SAT. */
export class InvalidTrustChainException extends ApplicationException {
  /**
   * @param internalDetail - En qué eslabón se rompió la cadena; sólo para el log.
   * @returns La excepción con código `INVALID_TRUST_CHAIN` y estado 422.
   *
   * @example
   * ```ts
   * throw new InvalidTrustChainException('Emisor "CN=AC X" no encontrado');
   * ```
   */
  constructor(internalDetail?: string) {
    super(
      ERROR_CODE_ENUM.INVALID_TRUST_CHAIN,
      'El certificado no encadena a una autoridad certificadora del SAT válida',
      HttpStatus.UNPROCESSABLE_ENTITY,
      internalDetail,
    );
  }
}

/** El SAT informó que el certificado está revocado. */
export class CertificateRevokedException extends ApplicationException {
  /**
   * @param revokedAt - Fecha de revocación informada por el SAT, si vino.
   * @param reason - Razón de revocación informada por el SAT, si vino.
   * @returns La excepción con código `CERTIFICATE_REVOKED` y estado 422.
   *
   * @example
   * ```ts
   * throw new CertificateRevokedException(result.revocationTime, String(result.revocationReason));
   * ```
   */
  constructor(revokedAt?: Date, reason?: string) {
    super(
      ERROR_CODE_ENUM.CERTIFICATE_REVOKED,
      'El certificado fue revocado por el SAT',
      HttpStatus.UNPROCESSABLE_ENTITY,
      `Revocado${revokedAt ? ` el ${revokedAt.toISOString()}` : ''}${
        reason ? ` (razón: ${reason})` : ''
      }`,
    );
  }
}

/**
 * El respondedor OCSP del SAT no contestó.
 *
 * 503 porque el problema es ajeno y reintentar más tarde tiene sentido.
 */
export class OcspServiceUnavailableException extends ApplicationException {
  /**
   * @param cause - Error de la consulta OCSP (timeout, DNS, respuesta ilegible); sólo para el log.
   * @returns La excepción con código `OCSP_SERVICE_UNAVAILABLE` y estado 503.
   *
   * @example
   * ```ts
   * throw new OcspServiceUnavailableException(error);
   * ```
   */
  constructor(cause?: unknown) {
    super(
      ERROR_CODE_ENUM.OCSP_SERVICE_UNAVAILABLE,
      'El servicio OCSP del SAT no está disponible. Vuelve a intentarlo en unos minutos',
      HttpStatus.SERVICE_UNAVAILABLE,
      undefined,
      cause,
    );
  }
}
