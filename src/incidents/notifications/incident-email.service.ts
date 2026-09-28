import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sgMail from '@sendgrid/mail';

import { describeError } from '../ocsp-failure-classifier';
import { IncidentEmail } from './incident-email.templates';

/** Esperas entre intentos de un mismo envío, dentro de una sola ejecución. */
export const EMAIL_RETRY_DELAYS_MS = [1000, 3000];

/**
 * Faltan `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL` o `INCIDENT_ALERT_RECIPIENTS`: los correos no
 * pueden salir. No se reintenta dentro de la ejecución porque no se va a arreglar solo.
 */
export class IncidentEmailNotConfiguredError extends Error {
  /**
   * @param missing - Variables de entorno que faltan.
   * @returns El error.
   *
   * @example
   * ```ts
   * throw new IncidentEmailNotConfiguredError(['SENDGRID_API_KEY']);
   * ```
   */
  constructor(missing: string[]) {
    super(
      `Correos de incidencias deshabilitados: faltan ${missing.join(', ')}`,
    );
    this.name = 'IncidentEmailNotConfiguredError';
  }
}

/**
 * Envía los correos de incidencias al equipo operativo por SendGrid.
 *
 * **Sin configuración, el servicio arranca igual.** La validación de certificados no puede caerse
 * porque falte la llave de correo; en cambio se avisa al arrancar y cada envío falla con
 * `IncidentEmailNotConfiguredError`, que queda contado en la incidencia.
 */
@Injectable()
export class IncidentEmailService {
  private readonly logger = new Logger(IncidentEmailService.name);
  private readonly from: string | undefined;
  private readonly recipients: string[];
  private readonly missingConfig: string[];

  /**
   * @param configService - Fuente de `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL` e
   *   `INCIDENT_ALERT_RECIPIENTS` (lista separada por comas).
   * @returns El servicio.
   *
   * @example
   * ```ts
   * const emails = new IncidentEmailService(configService);
   * ```
   */
  constructor(configService: ConfigService) {
    const apiKey = configService.get<string>('SENDGRID_API_KEY');
    this.from = configService.get<string>('SENDGRID_FROM_EMAIL');
    this.recipients = (
      configService.get<string>('INCIDENT_ALERT_RECIPIENTS') ?? ''
    )
      .split(',')
      .map((email) => email.trim())
      .filter(Boolean);

    this.missingConfig = [
      !apiKey && 'SENDGRID_API_KEY',
      !this.from && 'SENDGRID_FROM_EMAIL',
      this.recipients.length === 0 && 'INCIDENT_ALERT_RECIPIENTS',
    ].filter((name): name is string => Boolean(name));

    if (apiKey) {
      sgMail.setApiKey(apiKey);
    }

    if (this.missingConfig.length > 0) {
      this.logger.error(
        new IncidentEmailNotConfiguredError(this.missingConfig).message,
      );
    } else {
      this.logger.log(
        `Correos de incidencias hacia ${this.recipients.length} destinatario(s)`,
      );
    }
  }

  /**
   * Envía un correo a todo el equipo operativo, con reintentos acotados.
   *
   * Intenta una vez más por cada espera de `EMAIL_RETRY_DELAYS_MS`. Si todos fallan, lanza el
   * último error; quien llama lo cuenta en la incidencia y el siguiente ciclo del cron lo vuelve a
   * intentar, hasta `MAX_NOTIFICATION_ATTEMPTS`.
   *
   * @param email - Correo a enviar.
   * @param reference - Texto para el log (p. ej. el id de la incidencia).
   * @returns Nada.
   *
   * @throws {IncidentEmailNotConfiguredError} Si falta configuración de correo.
   * @throws {Error} El error de SendGrid del último intento.
   *
   * @example
   * ```ts
   * await emails.send(buildRecoveryAlertEmail(incident), `incidencia ${incident.id}`);
   * ```
   */
  async send(email: IncidentEmail, reference: string): Promise<void> {
    if (this.missingConfig.length > 0) {
      throw new IncidentEmailNotConfiguredError(this.missingConfig);
    }

    const attempts = EMAIL_RETRY_DELAYS_MS.length + 1;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await sgMail.send({
          to: this.recipients,
          from: this.from as string,
          subject: email.subject,
          html: email.html,
          text: email.text,
        });
        this.logger.log(
          `Correo "${email.subject}" enviado (${reference}, intento ${attempt})`,
        );
        return;
      } catch (error) {
        this.logger.warn(
          `Falló el envío de "${email.subject}" (${reference}, intento ${attempt} de ${attempts}): ${describeError(
            error,
          )}`,
        );

        if (attempt === attempts) {
          throw error;
        }
        await sleep(EMAIL_RETRY_DELAYS_MS[attempt - 1]);
      }
    }
  }
}

/**
 * @param milliseconds - Espera.
 * @returns Una promesa que se resuelve pasado ese tiempo.
 *
 * @example
 * ```ts
 * await sleep(1000);
 * ```
 */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
