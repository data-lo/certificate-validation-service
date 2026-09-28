import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { X509Certificate } from 'node:crypto';

import {
  CertificateRevokedException,
  OcspServiceUnavailableException,
} from '../../certificate-validation/exceptions/certificate.exceptions';
import {
  DEFAULT_OCSP_TIMEOUT_MS,
  DEFAULT_OCSP_URL,
  OcspService,
} from '../../certificate-validation/services/ocsp.service';
import { TrustChainService } from '../../certificate-validation/services/trust-chain.service';
import { OCSP_FAILURE_TYPE_ENUM } from '../incident.constants';
import { classifyOcspError, describeError } from '../ocsp-failure-classifier';

/** Resultado de un chequeo de salud. */
export type OcspHealthCheckResult =
  | { healthy: true }
  | {
      healthy: false;
      errorType: OCSP_FAILURE_TYPE_ENUM;
      errorMessage: string;
    };

/** Certificado de sonda ya validado contra la cadena del SAT. */
interface ProbeCertificate {
  certificate: X509Certificate;
  issuer: X509Certificate;
}

/**
 * Chequeo de salud ligero y con timeout contra el respondedor OCSP del SAT.
 *
 * Tiene dos modos, según haya o no `OCSP_HEALTH_CHECK_CERTIFICATE`:
 *
 * - **Con certificado de sonda** (recomendado): una consulta OCSP real, con los mismos servicios
 *   que la validación. Cualquier respuesta del SAT —`good`, `unknown` o incluso `revoked`— prueba
 *   que el servicio contesta. Sirve cualquier `.cer` vigente emitido por el SAT (son públicos).
 * - **Sin él**: un `POST` vacío a `OCSP_URL`. Una respuesta HTTP menor a 500 prueba que el
 *   respondedor está arriba y alcanzable (con TLS incluido), aunque no que responda bien a una
 *   consulta de verdad.
 */
@Injectable()
export class OcspHealthCheckService {
  private readonly logger = new Logger(OcspHealthCheckService.name);
  private readonly ocspUrl: string;
  private readonly timeoutMs: number;
  private readonly probe: ProbeCertificate | null;

  /**
   * @param configService - Fuente de `OCSP_URL`, `OCSP_HEALTH_CHECK_TIMEOUT_MS` (o
   *   `OCSP_TIMEOUT_MS`) y `OCSP_HEALTH_CHECK_CERTIFICATE` (Base64, opcional).
   * @param ocspService - Consulta OCSP de la validación.
   * @param trustChainService - Resuelve el emisor del certificado de sonda.
   * @returns El servicio. Si el certificado de sonda es inválido, lo registra y usa el modo sin él.
   *
   * @example
   * ```ts
   * const healthCheck = new OcspHealthCheckService(configService, ocspService, trustChainService);
   * ```
   */
  constructor(
    configService: ConfigService,
    private readonly ocspService: OcspService,
    trustChainService: TrustChainService,
  ) {
    this.ocspUrl = configService.get<string>('OCSP_URL') || DEFAULT_OCSP_URL;
    this.timeoutMs =
      Number(configService.get<string>('OCSP_HEALTH_CHECK_TIMEOUT_MS')) ||
      Number(configService.get<string>('OCSP_TIMEOUT_MS')) ||
      DEFAULT_OCSP_TIMEOUT_MS;
    this.probe = this.loadProbe(
      configService.get<string>('OCSP_HEALTH_CHECK_CERTIFICATE'),
      trustChainService,
    );
  }

  /**
   * Comprueba si el respondedor OCSP del SAT contesta.
   *
   * @returns `healthy: true`, o la causa del fallo clasificada igual que en los eventos.
   *
   * @example
   * ```ts
   * const result = await healthCheck.check();
   * if (!result.healthy) logger.warn(result.errorType);
   * ```
   */
  async check(): Promise<OcspHealthCheckResult> {
    // Una sonda vencida haría fallar cada chequeo con "already expired" y la incidencia no se
    // cerraría nunca: vencida, se cae al chequeo por alcance.
    const probe =
      this.probe && new Date(this.probe.certificate.validTo) > new Date()
        ? this.probe
        : null;
    if (this.probe && !probe) {
      this.logger.error(
        `El certificado de sonda ${this.probe.certificate.serialNumber} está vencido; se usa el chequeo por alcance. Actualiza OCSP_HEALTH_CHECK_CERTIFICATE.`,
      );
    }

    try {
      if (probe) {
        await this.ocspService.checkRevocation(probe.certificate, probe.issuer);
      } else {
        await this.probeEndpoint();
      }
      return { healthy: true };
    } catch (error) {
      if (error instanceof CertificateRevokedException) {
        // El SAT contestó: el certificado de sonda está revocado, pero el servicio funciona.
        return { healthy: true };
      }

      const cause =
        error instanceof OcspServiceUnavailableException
          ? (error.cause ?? error)
          : error;

      return {
        healthy: false,
        errorType: classifyOcspError(cause),
        errorMessage: describeError(cause),
      };
    }
  }

  /**
   * `POST` vacío al respondedor, con timeout.
   *
   * Los errores de `fetch` se reenvuelven con el mismo prefijo que usa `easy-ocsp`, para que
   * `classifyOcspError` los clasifique igual que los de una consulta real.
   *
   * @returns Nada si respondió con un estado HTTP menor a 500.
   *
   * @throws {Error} Si no hubo respuesta a tiempo, falló la red o el SAT respondió 5xx.
   *
   * @example
   * ```ts
   * await this.probeEndpoint();
   * ```
   */
  private async probeEndpoint(): Promise<void> {
    let response: Response;

    try {
      response = await fetch(this.ocspUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/ocsp-request' },
        body: new Uint8Array(0),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError')
      ) {
        throw new Error(
          `Failed to send OCSP request: Operation timed out after ${this.timeoutMs}ms`,
        );
      }
      const { cause: underlying } = error as { cause?: unknown };
      const cause =
        underlying instanceof Error ? ` (${underlying.message})` : '';
      throw new Error(
        `Failed to send OCSP request: ${describeError(error)}${cause}`,
      );
    }

    if (response.status >= 500) {
      throw new Error(
        `OCSP request failed with http status ${response.status} ${response.statusText}`,
      );
    }
  }

  /**
   * Carga y valida el certificado de sonda.
   *
   * @param base64 - `.cer` en Base64, o nada.
   * @param trustChainService - Resuelve su emisor.
   * @returns El certificado con su emisor, o `null` si no hay o no es válido.
   *
   * @example
   * ```ts
   * const probe = this.loadProbe(process.env.OCSP_HEALTH_CHECK_CERTIFICATE, trustChainService);
   * ```
   */
  private loadProbe(
    base64: string | undefined,
    trustChainService: TrustChainService,
  ): ProbeCertificate | null {
    if (!base64) {
      this.logger.log(
        `Chequeo de salud OCSP por alcance de ${this.ocspUrl} (sin OCSP_HEALTH_CHECK_CERTIFICATE)`,
      );
      return null;
    }

    try {
      const certificate = new X509Certificate(Buffer.from(base64, 'base64'));
      const { issuer } = trustChainService.validate(certificate);
      this.logger.log(
        `Chequeo de salud OCSP con el certificado de sonda ${certificate.serialNumber}`,
      );
      return { certificate, issuer };
    } catch (error) {
      this.logger.error(
        `OCSP_HEALTH_CHECK_CERTIFICATE no es un certificado válido del SAT; se usa el chequeo por alcance: ${describeError(
          error,
        )}`,
      );
      return null;
    }
  }
}
