import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBase64,
  IsBoolean,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Tamaño máximo del certificado en Base64.
 *
 * Un `.cer` de e.firma pesa ~2 KB; el límite de 256 KB replica el de `signature-server`
 * (`MAX_EFIRMA_FILE_SIZE_BYTES`) con el sobrecosto de Base64 (4/3), para no rechazar aquí nada que
 * aquel acepte.
 */
export const MAX_CERTIFICATE_BASE64_LENGTH =
  Math.ceil((256 * 1024 * 4) / 3) + 4;

export class ValidateCertificateRequestDto {
  @ApiProperty({
    description:
      'Certificado a validar (.cer) codificado en Base64. Se acepta tanto DER como PEM.',
    example: 'MIIGSzCCBDOgAwIBAgIUMDAwMDEwMDAwMDA1MDI...',
  })
  @IsString()
  @IsNotEmpty()
  @IsBase64()
  @MaxLength(MAX_CERTIFICATE_BASE64_LENGTH)
  certificate: string;

  @ApiPropertyOptional({
    description:
      'Fecha contra la que se evalúa la vigencia (ISO 8601). Por defecto, el momento de la ' +
      'petición. Sirve para completar la evidencia de una firma ya hecha: se comprueba que el ' +
      'certificado estaba vigente al firmar, aunque haya vencido después. No puede estar en el futuro.',
    example: '2026-09-15T12:00:00.000Z',
    format: 'date-time',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  referenceDate?: string;

  @ApiPropertyOptional({
    description:
      'Si es `true`, que el respondedor OCSP del SAT no conteste NO es un error: se responde 200 ' +
      'con `revocation.status = "UNVERIFIED"` y sin `ocspEvidence`. Si es `false` (por defecto), ' +
      'se responde 503 `OCSP_SERVICE_UNAVAILABLE`. Un certificado REVOCADO es un error siempre.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  allowUnverifiedRevocation?: boolean;
}
