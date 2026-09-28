import { ServiceIncidentEntity } from '../entities/service-incident.entity';
import { OCSP_FAILURE_TYPE_ENUM } from '../incident.constants';

/** Zona horaria de las fechas de los correos: la del equipo operativo. */
export const EMAIL_TIME_ZONE = 'America/Mexico_City';

/** Un correo listo para enviar. */
export interface IncidentEmail {
  subject: string;
  html: string;
  text: string;
}

const ERROR_TYPE_LABELS: Record<OCSP_FAILURE_TYPE_ENUM, string> = {
  [OCSP_FAILURE_TYPE_ENUM.TIMEOUT]: 'Tiempo de espera agotado',
  [OCSP_FAILURE_TYPE_ENUM.NETWORK_ERROR]: 'Error de red o TLS',
  [OCSP_FAILURE_TYPE_ENUM.OCSP_UNAVAILABLE]: 'Respuesta de error del SAT',
};

/**
 * Formatea una fecha en la hora del equipo operativo.
 *
 * @param date - Fecha a formatear.
 * @returns La fecha con zona horaria, p. ej. "28 sept 2026, 14:05:12 CST".
 *
 * @example
 * ```ts
 * formatEmailDate(new Date('2026-09-28T20:05:12Z'));
 * ```
 */
export function formatEmailDate(date: Date): string {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: EMAIL_TIME_ZONE,
    dateStyle: 'medium',
    timeStyle: 'long',
  }).format(date);
}

/**
 * Formatea una duración en horas, minutos y segundos, omitiendo las unidades en cero a la izquierda.
 *
 * @param milliseconds - Duración; los negativos se tratan como cero.
 * @returns La duración legible, p. ej. "1 h 5 min 3 s" o "42 s".
 *
 * @example
 * ```ts
 * formatDuration(3_903_000); // '1 h 5 min 3 s'
 * ```
 */
export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} h`);
  if (hours > 0 || minutes > 0) parts.push(`${minutes} min`);
  parts.push(`${seconds} s`);

  return parts.join(' ');
}

/**
 * Correo de aviso: OCSP lleva fallando lo suficiente como para que el equipo lo sepa.
 *
 * @param incident - Incidencia abierta que alcanzó el umbral.
 * @returns Asunto y cuerpo, en HTML y texto plano.
 *
 * @example
 * ```ts
 * const email = buildIncidentAlertEmail(incident);
 * ```
 */
export function buildIncidentAlertEmail(
  incident: ServiceIncidentEntity,
): IncidentEmail {
  const rows: [string, string][] = [
    ['Servicio', incident.service],
    ['Incidencia', incident.id],
    ['Inicio', formatEmailDate(incident.startedAt)],
    ['Último fallo', formatEmailDate(incident.lastFailureAt)],
    ['Causa del último fallo', errorTypeLabel(incident.lastErrorType)],
    ['Intentos de firma afectados', String(incident.affectedAttempts)],
    ['Chequeos de salud fallidos', String(incident.failedHealthChecks)],
  ];

  return buildEmail(
    `[Incidencia] OCSP del SAT no disponible — ${incident.service}`,
    'El servicio OCSP del SAT no está respondiendo',
    'Las validaciones de certificados de e.firma no pueden comprobar la revocación. Las firmas avanzadas quedan pendientes de sellar hasta que el SAT vuelva a responder. No se enviarán más avisos por esta incidencia; recibirán un solo correo cuando se recupere.',
    rows,
  );
}

/**
 * Correo de recuperación: el único resumen de la incidencia al cerrarse.
 *
 * @param incident - Incidencia resuelta (con `resolvedAt`).
 * @returns Asunto y cuerpo, en HTML y texto plano.
 *
 * @throws {Error} Si la incidencia no tiene `resolvedAt`.
 *
 * @example
 * ```ts
 * const email = buildRecoveryAlertEmail(resolvedIncident);
 * ```
 */
export function buildRecoveryAlertEmail(
  incident: ServiceIncidentEntity,
): IncidentEmail {
  if (!incident.resolvedAt) {
    throw new Error(
      `La incidencia ${incident.id} no está resuelta: no hay recuperación que notificar`,
    );
  }

  const duration = incident.resolvedAt.getTime() - incident.startedAt.getTime();
  const rows: [string, string][] = [
    ['Servicio', incident.service],
    ['Incidencia', incident.id],
    ['Inicio', formatEmailDate(incident.startedAt)],
    ['Recuperación', formatEmailDate(incident.resolvedAt)],
    ['Duración', formatDuration(duration)],
    ['Intentos de firma afectados', String(incident.affectedAttempts)],
    ['Chequeos de salud fallidos', String(incident.failedHealthChecks)],
  ];

  return buildEmail(
    `[Recuperado] OCSP del SAT disponible — ${incident.service}`,
    'El servicio OCSP del SAT se recuperó',
    'La validación de revocación volvió a responder y la incidencia quedó cerrada. Los documentos que quedaron pendientes de sellar se completan con el reintento de sellado de signature-server.',
    rows,
  );
}

/**
 * @param type - Causa registrada, o `null`.
 * @returns Su etiqueta en español.
 *
 * @example
 * ```ts
 * errorTypeLabel(OCSP_FAILURE_TYPE_ENUM.TIMEOUT); // 'Tiempo de espera agotado'
 * ```
 */
function errorTypeLabel(type: OCSP_FAILURE_TYPE_ENUM | null): string {
  return type ? `${ERROR_TYPE_LABELS[type]} (${type})` : 'Desconocida';
}

/**
 * Arma el correo con una tabla de datos, en HTML y en texto plano.
 *
 * @param subject - Asunto.
 * @param title - Encabezado del cuerpo.
 * @param summary - Párrafo explicativo.
 * @param rows - Pares etiqueta/valor.
 * @returns El correo.
 *
 * @example
 * ```ts
 * buildEmail('Asunto', 'Título', 'Resumen', [['Servicio', 'x']]);
 * ```
 */
function buildEmail(
  subject: string,
  title: string,
  summary: string,
  rows: [string, string][],
): IncidentEmail {
  const htmlRows = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#555"><strong>${escapeHtml(
          label,
        )}</strong></td><td style="padding:4px 0">${escapeHtml(value)}</td></tr>`,
    )
    .join('');

  return {
    subject,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222"><h2 style="margin:0 0 12px">${escapeHtml(
      title,
    )}</h2><p>${escapeHtml(summary)}</p><table>${htmlRows}</table></div>`,
    text: [
      title,
      '',
      summary,
      '',
      ...rows.map(([label, value]) => `${label}: ${value}`),
    ].join('\n'),
  };
}

/**
 * @param value - Texto a insertar en HTML.
 * @returns El texto con `& < > " '` escapados.
 *
 * @example
 * ```ts
 * escapeHtml('<b>'); // '&lt;b&gt;'
 * ```
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
