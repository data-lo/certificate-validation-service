/**
 * Códigos de error estables del servicio.
 *
 * Son el CONTRATO con los consumidores: `signature-server` decide qué hacer leyendo este campo,
 * nunca el `message`, que es texto para personas y puede cambiar. Renombrar o reutilizar un código
 * es un cambio incompatible.
 */
export enum ERROR_CODE_ENUM {
  /** Falta el header `x-api-key` o no coincide con `API_KEY`. */
  INVALID_API_KEY = 'INVALID_API_KEY',
  /** El cuerpo de la petición no cumple el DTO (campo ausente, tipo o formato incorrecto). */
  INVALID_REQUEST = 'INVALID_REQUEST',
  /** El certificado no se pudo interpretar como X.509 (DER o PEM). */
  INVALID_CERTIFICATE = 'INVALID_CERTIFICATE',
  /** La fecha de referencia es posterior al fin de vigencia del certificado. */
  CERTIFICATE_EXPIRED = 'CERTIFICATE_EXPIRED',
  /** La fecha de referencia es anterior al inicio de vigencia del certificado. */
  CERTIFICATE_NOT_YET_VALID = 'CERTIFICATE_NOT_YET_VALID',
  /** El respondedor OCSP del SAT informó que el certificado está revocado. */
  CERTIFICATE_REVOKED = 'CERTIFICATE_REVOKED',
  /** El certificado no encadena a ninguna AC de confianza del SAT. */
  INVALID_TRUST_CHAIN = 'INVALID_TRUST_CHAIN',
  /** El respondedor OCSP del SAT no contestó (caído, lento o inalcanzable). */
  OCSP_SERVICE_UNAVAILABLE = 'OCSP_SERVICE_UNAVAILABLE',
  /** La ruta solicitada no existe. */
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  /** Fallo no previsto durante la validación. */
  CERTIFICATE_VALIDATION_ERROR = 'CERTIFICATE_VALIDATION_ERROR',
}
