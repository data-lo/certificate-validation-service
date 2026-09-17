import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Estado de revocación en la respuesta.
 *
 * - `GOOD`: el SAT respondió que el certificado no está revocado.
 * - `UNKNOWN`: el SAT respondió, pero no reconoce el certificado. Se acepta, como hasta ahora.
 * - `UNVERIFIED`: el SAT no respondió y la petición lo permitía (`allowUnverifiedRevocation`).
 *
 * `REVOKED` no existe aquí a propósito: un certificado revocado nunca produce un 200, produce
 * `CERTIFICATE_REVOKED`.
 */
export enum REVOCATION_STATUS_ENUM {
  GOOD = 'GOOD',
  UNKNOWN = 'UNKNOWN',
  UNVERIFIED = 'UNVERIFIED',
}

export class CertificateValidityDto {
  @ApiProperty({ example: true })
  isValid: boolean;

  @ApiProperty({ example: '2023-01-10T18:00:00.000Z', format: 'date-time' })
  notBefore: string;

  @ApiProperty({ example: '2027-01-10T18:00:00.000Z', format: 'date-time' })
  notAfter: string;

  @ApiProperty({
    description: 'Fecha contra la que se evaluó la vigencia.',
    example: '2026-09-15T12:00:00.000Z',
    format: 'date-time',
  })
  evaluatedAt: string;
}

export class TrustChainResultDto {
  @ApiProperty({ example: true })
  isValid: boolean;

  @ApiProperty({
    description:
      'Subject del emisor inmediato (la AC que firmó el certificado).',
    example:
      'CN=AC DEL SERVICIO DE ADMINISTRACION TRIBUTARIA, O=SERVICIO DE ADMINISTRACION TRIBUTARIA',
  })
  issuer: string;

  @ApiProperty({
    description:
      'Subject de la AC raíz de confianza en la que termina la cadena.',
    example: 'CN=AUTORIDAD CERTIFICADORA RAIZ, O=Banco de Mexico',
  })
  root: string;
}

export class RevocationResultDto {
  @ApiProperty({
    enum: REVOCATION_STATUS_ENUM,
    enumName: 'REVOCATION_STATUS_ENUM',
  })
  status: REVOCATION_STATUS_ENUM;

  @ApiProperty({ example: '2026-09-15T12:00:00.000Z', format: 'date-time' })
  checkedAt: string;
}

/**
 * Evidencia de la consulta OCSP. Misma forma que `OCSPEvidence` en `signature-server` y en el DTO
 * de Seal Service, para que viaje sin transformaciones hasta el sellado.
 */
export class OcspEvidenceDto {
  @ApiProperty({ enum: ['good', 'unknown'] })
  status: 'good' | 'unknown';

  @ApiProperty({ example: '2026-09-15T12:00:00.000Z', format: 'date-time' })
  verifiedAt: string;

  @ApiProperty({
    description:
      'Respuesta OCSP cruda del SAT en Base64 (firmada por el respondedor). Vacía si el SAT no la incluyó.',
  })
  ocspResponse: string;

  @ApiProperty({ example: 'https://cfdi.sat.gob.mx/edofiel' })
  ocspUrl: string;
}

export class ValidateCertificateResponseDto {
  @ApiProperty({
    description:
      'Resultado general: `true` si no hay ningún motivo de rechazo. Puede ser `true` con la ' +
      'revocación sin verificar (`revocation.status = "UNVERIFIED"`) cuando la petición lo permitió.',
    example: true,
  })
  isValid: boolean;

  @ApiProperty({
    description: 'Número de serie del certificado en hexadecimal.',
    example: '3030303031303030303030353032',
  })
  serialNumber: string;

  @ApiProperty({ type: CertificateValidityDto })
  validity: CertificateValidityDto;

  @ApiProperty({ type: TrustChainResultDto })
  trustChain: TrustChainResultDto;

  @ApiProperty({ type: RevocationResultDto })
  revocation: RevocationResultDto;

  @ApiPropertyOptional({
    type: OcspEvidenceDto,
    description: 'Presente sólo cuando el SAT respondió la consulta OCSP.',
  })
  ocspEvidence?: OcspEvidenceDto;
}
