import { ApiProperty } from '@nestjs/swagger';

import { ERROR_CODE_ENUM } from './error-code.enum';

/**
 * Estructura única con la que el servicio responde CUALQUIER error, conocido o no.
 */
export class ErrorResponseDto {
  @ApiProperty({ example: 400, description: 'Código HTTP de la respuesta.' })
  statusCode: number;

  @ApiProperty({
    enum: ERROR_CODE_ENUM,
    enumName: 'ERROR_CODE_ENUM',
    example: ERROR_CODE_ENUM.INVALID_CERTIFICATE,
    description:
      'Código estable del error. Es el campo que el consumidor debe usar para decidir.',
  })
  code: ERROR_CODE_ENUM;

  @ApiProperty({
    example: 'El certificado proporcionado no es válido',
    description:
      'Mensaje en español para personas. Nunca incluye detalles técnicos.',
  })
  message: string;

  @ApiProperty({ example: '2026-09-15T12:00:00.000Z', format: 'date-time' })
  timestamp: string;

  @ApiProperty({ example: '/api/v1/certificates/validate' })
  path: string;
}
