import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getCertStatus } from 'easy-ocsp';
import { X509Certificate } from 'node:crypto';

import {
  CertificateRevokedException,
  OcspServiceUnavailableException,
} from '../exceptions/certificate.exceptions';

export const DEFAULT_OCSP_URL = 'https://cfdi.sat.gob.mx/edofiel';
export const DEFAULT_OCSP_TIMEOUT_MS = 5000;

/** Evidencia de una consulta OCSP respondida. */
export interface OcspEvidence {
  status: 'good' | 'unknown';
  verifiedAt: Date;
  /** Respuesta cruda del SAT en Base64; vacía si no la incluyó. */
  ocspResponse: string;
  ocspUrl: string;
}

@Injectable()
export class OcspService {
  private readonly logger = new Logger(OcspService.name);
  private readonly ocspUrl: string;
  private readonly timeoutMs: number;

  /**
   * @param configService - Fuente de `OCSP_URL` y `OCSP_TIMEOUT_MS` (ambas opcionales).
   * @returns El servicio con la URL y el tiempo de espera resueltos.
   *
   * @example
   * ```ts
   * const service = new OcspService(configService);
   * ```
   */
  constructor(configService: ConfigService) {
    this.ocspUrl = configService.get<string>('OCSP_URL') || DEFAULT_OCSP_URL;
    this.timeoutMs =
      Number(configService.get<string>('OCSP_TIMEOUT_MS')) ||
      DEFAULT_OCSP_TIMEOUT_MS;
  }

  /**
   * Consulta al respondedor OCSP del SAT el estado de revocación del certificado.
   *
   * Migrado desde `OscpService.verifyRevokedOCSP` de `signature-server`. Dos diferencias: la
   * respuesta ya no se vuelca completa al log (sólo el estado), y del certificado revocado no se
   * registra ningún fragmento, sólo su número de serie.
   *
   * @param certificate - Certificado a consultar.
   * @param issuer - Emisor inmediato del certificado; el SAT firma la respuesta con esa AC.
   * @returns La evidencia de la consulta cuando el estado es `good` o `unknown`.
   *
   * @throws {CertificateRevokedException} Si el SAT informa que el certificado está revocado.
   * @throws {OcspServiceUnavailableException} Si la consulta falla (timeout, red, respuesta ilegible).
   *
   * @example
   * ```ts
   * const evidence = await ocspService.checkRevocation(certificate, issuer);
   * ```
   */
  async checkRevocation(
    certificate: X509Certificate,
    issuer: X509Certificate,
  ): Promise<OcspEvidence> {
    let result: Awaited<ReturnType<typeof getCertStatus>>;

    try {
      result = await getCertStatus(certificate.raw, {
        ca: issuer.raw,
        ocspUrl: this.ocspUrl,
        timeout: this.timeoutMs,
        rawResponse: true,
        enableNonce: false,
      });
    } catch (error) {
      throw new OcspServiceUnavailableException(error);
    }

    if (result.status === 'revoked') {
      this.logger.warn(
        `El SAT reporta revocado el certificado con serie ${certificate.serialNumber}`,
      );
      throw new CertificateRevokedException(
        result.revocationTime,
        result.revocationReason === undefined
          ? undefined
          : String(result.revocationReason),
      );
    }

    this.logger.log(
      `OCSP del SAT: certificado con serie ${certificate.serialNumber} en estado ${result.status}`,
    );

    return {
      status: result.status,
      verifiedAt: new Date(),
      ocspResponse: result.rawResponse
        ? Buffer.from(result.rawResponse).toString('base64')
        : '',
      ocspUrl: this.ocspUrl,
    };
  }
}
