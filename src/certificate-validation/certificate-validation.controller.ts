import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { ErrorResponseDto } from '../common/errors/error-response.dto';
import { ValidateCertificateRequestDto } from './dto/validate-certificate-request.dto';
import { ValidateCertificateResponseDto } from './dto/validate-certificate-response.dto';
import { CertificateValidationService } from './services/certificate-validation.service';

@ApiTags('certificates')
@Controller('certificates')
export class CertificateValidationController {
  /**
   * @param certificateValidationService - Orquestador de la validación.
   * @returns El controlador.
   *
   * @example
   * ```ts
   * new CertificateValidationController(certificateValidationService);
   * ```
   */
  constructor(
    private readonly certificateValidationService: CertificateValidationService,
  ) {}

  /**
   * Valida vigencia, cadena de confianza y revocación de un certificado de e.firma.
   *
   * 200 y no 201: no crea ningún recurso, sólo evalúa.
   *
   * @param request - Cuerpo ya validado contra `ValidateCertificateRequestDto`.
   * @returns El resultado detallado de la validación.
   *
   * @throws {InvalidCertificateException} Certificado ilegible (400 `INVALID_CERTIFICATE`).
   * @throws {CertificateExpiredException} Certificado vencido (422 `CERTIFICATE_EXPIRED`).
   * @throws {CertificateNotYetValidException} Aún no vigente (422 `CERTIFICATE_NOT_YET_VALID`).
   * @throws {InvalidTrustChainException} Cadena inválida (422 `INVALID_TRUST_CHAIN`).
   * @throws {CertificateRevokedException} Revocado (422 `CERTIFICATE_REVOKED`).
   * @throws {OcspServiceUnavailableException} SAT sin responder (503 `OCSP_SERVICE_UNAVAILABLE`).
   *
   * @example
   * ```ts
   * // POST /api/v1/certificates/validate  (header x-api-key)
   * // { "certificate": "MIIG...", "allowUnverifiedRevocation": true }
   * ```
   */
  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Validar un certificado de e.firma',
    description:
      'Comprueba, en este orden, formato, vigencia, cadena de confianza del SAT y estado de ' +
      'revocación vía OCSP. Se detiene en la primera comprobación que falla. Los errores siguen ' +
      'siempre la estructura `ErrorResponseDto`; distinguirlos por el campo `code`.',
  })
  @ApiOkResponse({ type: ValidateCertificateResponseDto })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: '`INVALID_REQUEST` o `INVALID_CERTIFICATE`.',
  })
  @ApiUnauthorizedResponse({
    type: ErrorResponseDto,
    description: '`INVALID_API_KEY`.',
  })
  @ApiUnprocessableEntityResponse({
    type: ErrorResponseDto,
    description:
      '`CERTIFICATE_EXPIRED`, `CERTIFICATE_NOT_YET_VALID`, `INVALID_TRUST_CHAIN` o `CERTIFICATE_REVOKED`.',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorResponseDto,
    description: '`OCSP_SERVICE_UNAVAILABLE`.',
  })
  @ApiInternalServerErrorResponse({
    type: ErrorResponseDto,
    description: '`CERTIFICATE_VALIDATION_ERROR`.',
  })
  validate(
    @Body() request: ValidateCertificateRequestDto,
  ): Promise<ValidateCertificateResponseDto> {
    return this.certificateValidationService.validate(request);
  }
}
