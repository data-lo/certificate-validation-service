import { OCSP_FAILURE_TYPE_ENUM } from './incident.constants';

/**
 * Prefijo con el que `easy-ocsp` envuelve los errores de `fetch` (ver su `fetchWrapper`): todo lo
 * que empieza así ocurrió ANTES de tener una respuesta HTTP del SAT.
 */
const FETCH_ERROR_PREFIX = 'Failed to send OCSP request:';

/** Texto que `easy-ocsp` usa cuando aborta la petición por `timeout`. */
const TIMEOUT_MARKER = 'Operation timed out';

/**
 * Clasifica el error de una consulta OCSP en la causa que publica el evento.
 *
 * Se decide por el mensaje porque `easy-ocsp` convierte cualquier fallo en un `Error` genérico:
 * - `TIMEOUT`: la petición se abortó por `timeout` (o llegó un `AbortError`/`TimeoutError` crudo).
 * - `NETWORK_ERROR`: `fetch` falló sin respuesta — DNS, conexión rechazada, TLS (como el
 *   `dh key too small` que da Node al hablar con el SAT).
 * - `OCSP_UNAVAILABLE`: todo lo demás. El SAT contestó, pero con un HTTP de error, un estado OCSP
 *   `tryLater`/`internalError` o una respuesta ilegible.
 *
 * @param error - Lo que lanzó la consulta; normalmente la `cause` de `OcspServiceUnavailableException`.
 * @returns La causa del fallo.
 *
 * @example
 * ```ts
 * classifyOcspError(new Error('Failed to send OCSP request: Operation timed out after 5000ms'));
 * // OCSP_FAILURE_TYPE_ENUM.TIMEOUT
 * ```
 */
export function classifyOcspError(error: unknown): OCSP_FAILURE_TYPE_ENUM {
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  ) {
    return OCSP_FAILURE_TYPE_ENUM.TIMEOUT;
  }

  const message = describeError(error);

  if (message.includes(TIMEOUT_MARKER)) {
    return OCSP_FAILURE_TYPE_ENUM.TIMEOUT;
  }
  if (message.startsWith(FETCH_ERROR_PREFIX)) {
    return OCSP_FAILURE_TYPE_ENUM.NETWORK_ERROR;
  }

  return OCSP_FAILURE_TYPE_ENUM.OCSP_UNAVAILABLE;
}

/**
 * Mensaje legible de cualquier cosa lanzada.
 *
 * @param error - Lo que se lanzó.
 * @returns El `message` si es un `Error`; si no, su conversión a texto.
 *
 * @example
 * ```ts
 * describeError(new Error('boom')); // 'boom'
 * describeError('boom'); // 'boom'
 * ```
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
