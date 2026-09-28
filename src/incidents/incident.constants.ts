/** Nombre con el que este servicio se registra en `service_incidents` y en los eventos. */
export const MONITORED_SERVICE = 'certificate-validation-service';

/**
 * Identificador de LA incidencia del servicio: sólo puede haber una abierta a la vez.
 *
 * Es también la llave del lock distribuido en Redis que serializa el chequeo de salud y el envío
 * de correos entre réplicas: quien la tiene es el único que puede cerrar la incidencia o avisar
 * de ella.
 */
export const INCIDENT_KEY = `${MONITORED_SERVICE}:incident`;

/** Topic de Kafka de los fallos de validación OCSP. */
export const OCSP_VALIDATION_FAILED_TOPIC =
  'certificate-validation.ocsp-validation-failed';

/** Tipo de evento que viaja en `OCSP_VALIDATION_FAILED_TOPIC`. */
export const OCSP_VALIDATION_FAILED_EVENT = 'OCSP_VALIDATION_FAILED';

/** Token de inyección del cliente de Kafka que publica los eventos. */
export const KAFKA_CLIENT = 'KAFKA_CLIENT';

/** Fallos (intentos afectados + chequeos fallidos) a partir de los que se avisa al equipo. */
export const DEFAULT_INCIDENT_ALERT_THRESHOLD = 3;

/** Intentos de envío de cada correo, sumando todas las ejecuciones del cron, antes de rendirse. */
export const MAX_NOTIFICATION_ATTEMPTS = 10;

/**
 * Espera mínima entre dos intentos de un mismo correo. Un poco menos que el periodo del cron: se
 * reintenta a lo sumo una vez por ciclo, aunque el consumer despache tras cada evento. Sin esto,
 * una ráfaga de fallos con SendGrid caído agotaba los intentos en segundos.
 */
export const NOTIFICATION_RETRY_INTERVAL_MS = 4 * 60 * 1000;

/** Estado de una incidencia. */
export enum INCIDENT_STATUS_ENUM {
  OPEN = 'OPEN',
  RESOLVED = 'RESOLVED',
}

/** Causa del fallo de una consulta OCSP. */
export enum OCSP_FAILURE_TYPE_ENUM {
  /** El SAT no respondió dentro de `OCSP_TIMEOUT_MS`. */
  TIMEOUT = 'TIMEOUT',
  /** No se pudo establecer la conexión: DNS, conexión rechazada, TLS. */
  NETWORK_ERROR = 'NETWORK_ERROR',
  /** El SAT respondió, pero con un error HTTP o una respuesta OCSP inutilizable. */
  OCSP_UNAVAILABLE = 'OCSP_UNAVAILABLE',
}
