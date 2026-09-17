import { Injectable } from '@nestjs/common';
import { X509Certificate } from 'node:crypto';

import { InvalidRequestException } from '../../common/exceptions/common.exceptions';
import { ValidateCertificateRequestDto } from '../dto/validate-certificate-request.dto';
import {
  OcspEvidenceDto,
  REVOCATION_STATUS_ENUM,
  ValidateCertificateResponseDto,
} from '../dto/validate-certificate-response.dto';
import {
  CertificateExpiredException,
  CertificateNotYetValidException,
  InvalidCertificateException,
  OcspServiceUnavailableException,
} from '../exceptions/certificate.exceptions';
import { OcspEvidence, OcspService } from './ocsp.service';
import { TrustChainService, oneLine } from './trust-chain.service';

/**
 * Tolerancia para una `referenceDate` "en el futuro": absorbe la diferencia de reloj entre el
 * consumidor y este servicio sin permitir evaluar la vigencia contra una fecha que no ha llegado.
 */
const REFERENCE_DATE_CLOCK_SKEW_MS = 5 * 60 * 1000;

@Injectable()
export class CertificateValidationService {
  /**
   * @param trustChainService - Validación de la cadena contra el almacén del SAT.
   * @param ocspService - Consulta de revocación al respondedor del SAT.
   * @returns El servicio listo para validar certificados.
   *
   * @example
   * ```ts
   * const service = new CertificateValidationService(trustChainService, ocspService);
   * ```
   */
  constructor(
    private readonly trustChainService: TrustChainService,
    private readonly ocspService: OcspService,
  ) {}

  /**
   * Valida un certificado de e.firma: formato, vigencia, cadena de confianza y revocación.
   *
   * **El orden es parte del contrato.** Se detiene en la primera comprobación que falla, de la
   * más barata a la más cara: sin cadena válida no hay emisor contra el que consultar OCSP, y no
   * tiene sentido salir a la red por un certificado que ya se sabe vencido.
   *
   * **Sobre OCSP caído.** Por defecto es un error (`OCSP_SERVICE_UNAVAILABLE`). Con
   * `allowUnverifiedRevocation` se responde 200 con la revocación `UNVERIFIED` y sin evidencia: es
   * lo que necesita `signature-server` para permitir la firma cuando el SAT no contesta y dejar el
   * documento pendiente de sellado. Un certificado REVOCADO siempre es un error: eso es una
   * respuesta del SAT, no su ausencia.
   *
   * @param request - Certificado en Base64 y opciones de la validación.
   * @returns El resultado detallado; `isValid` es `true` siempre que no se lanzó ninguna excepción.
   *
   * @throws {InvalidRequestException} Si `referenceDate` está en el futuro.
   * @throws {InvalidCertificateException} Si el contenido no es un certificado X.509 legible.
   * @throws {CertificateExpiredException} Si la fecha de referencia es posterior a su vigencia.
   * @throws {CertificateNotYetValidException} Si la fecha de referencia es anterior a su vigencia.
   * @throws {InvalidTrustChainException} Si no encadena a una AC de confianza del SAT.
   * @throws {CertificateRevokedException} Si el SAT lo reporta revocado.
   * @throws {OcspServiceUnavailableException} Si el SAT no responde y la petición no lo permite.
   *
   * @example
   * ```ts
   * const result = await service.validate({
   *   certificate: cerBuffer.toString('base64'),
   *   allowUnverifiedRevocation: true,
   * });
   * ```
   */
  async validate(
    request: ValidateCertificateRequestDto,
  ): Promise<ValidateCertificateResponseDto> {
    const evaluatedAt = this.resolveReferenceDate(request.referenceDate);
    const certificate = this.parseCertificate(request.certificate);
    const notBefore = new Date(certificate.validFrom);
    const notAfter = new Date(certificate.validTo);

    if (evaluatedAt < notBefore) {
      throw new CertificateNotYetValidException(notBefore);
    }
    if (evaluatedAt > notAfter) {
      throw new CertificateExpiredException(notAfter);
    }

    const chain = this.trustChainService.validate(certificate);
    const checkedAt = new Date();
    const evidence = await this.checkRevocation(
      certificate,
      chain.issuer,
      request.allowUnverifiedRevocation ?? false,
    );

    return {
      isValid: true,
      serialNumber: certificate.serialNumber,
      validity: {
        isValid: true,
        notBefore: notBefore.toISOString(),
        notAfter: notAfter.toISOString(),
        evaluatedAt: evaluatedAt.toISOString(),
      },
      trustChain: {
        isValid: true,
        issuer: oneLine(chain.issuer.subject),
        root: oneLine(chain.root.subject),
      },
      revocation: {
        status: evidence
          ? evidence.status === 'good'
            ? REVOCATION_STATUS_ENUM.GOOD
            : REVOCATION_STATUS_ENUM.UNKNOWN
          : REVOCATION_STATUS_ENUM.UNVERIFIED,
        checkedAt: (evidence?.verifiedAt ?? checkedAt).toISOString(),
      },
      ...(evidence && { ocspEvidence: toOcspEvidenceDto(evidence) }),
    };
  }

  private resolveReferenceDate(referenceDate?: string): Date {
    const now = new Date();

    if (!referenceDate) {
      return now;
    }

    const parsed = new Date(referenceDate);

    if (parsed.getTime() > now.getTime() + REFERENCE_DATE_CLOCK_SKEW_MS) {
      throw new InvalidRequestException(
        `referenceDate en el futuro: ${parsed.toISOString()}`,
      );
    }

    return parsed;
  }

  private parseCertificate(certificateBase64: string): X509Certificate {
    try {
      return new X509Certificate(Buffer.from(certificateBase64, 'base64'));
    } catch (error) {
      throw new InvalidCertificateException(error);
    }
  }

  /**
   * Devuelve `null` sólo cuando el SAT no respondió y la petición lo permite; cualquier otro fallo
   * (incluido el certificado revocado) se propaga.
   */
  private async checkRevocation(
    certificate: X509Certificate,
    issuer: X509Certificate,
    allowUnverified: boolean,
  ): Promise<OcspEvidence | null> {
    try {
      return await this.ocspService.checkRevocation(certificate, issuer);
    } catch (error) {
      if (allowUnverified && error instanceof OcspServiceUnavailableException) {
        return null;
      }
      throw error;
    }
  }
}

function toOcspEvidenceDto(evidence: OcspEvidence): OcspEvidenceDto {
  return {
    status: evidence.status,
    verifiedAt: evidence.verifiedAt.toISOString(),
    ocspResponse: evidence.ocspResponse,
    ocspUrl: evidence.ocspUrl,
  };
}
