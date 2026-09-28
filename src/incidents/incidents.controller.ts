import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ErrorResponseDto } from '../common/errors/error-response.dto';
import { ServiceIncidentEntity } from './entities/service-incident.entity';
import {
  INCIDENT_STATUS_ENUM,
  OCSP_FAILURE_TYPE_ENUM,
} from './incident.constants';
import { IncidentService } from './services/incident.service';

/** Máximo de incidencias por consulta. */
export const MAX_INCIDENTS_PAGE_SIZE = 100;

/** Una incidencia tal como la publica `GET /incidents`. */
export class ServiceIncidentDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'certificate-validation-service' })
  service: string;

  @ApiProperty({ enum: INCIDENT_STATUS_ENUM })
  status: INCIDENT_STATUS_ENUM;

  @ApiProperty({ format: 'date-time' })
  startedAt: string;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  resolvedAt: string | null;

  @ApiPropertyOptional({
    description: 'Duración en milisegundos; `null` mientras sigue abierta',
    nullable: true,
  })
  durationMs: number | null;

  @ApiProperty({ format: 'date-time' })
  lastFailureAt: string;

  @ApiPropertyOptional({ enum: OCSP_FAILURE_TYPE_ENUM, nullable: true })
  lastErrorType: OCSP_FAILURE_TYPE_ENUM | null;

  @ApiProperty({ description: 'Intentos de firma afectados' })
  affectedAttempts: number;

  @ApiProperty({ description: 'Chequeos de salud fallidos' })
  failedHealthChecks: number;

  @ApiProperty()
  incidentAlertSent: boolean;

  @ApiProperty()
  incidentAlertAttempts: number;

  @ApiProperty()
  recoveryAlertSent: boolean;

  @ApiProperty()
  recoveryAlertAttempts: number;

  @ApiPropertyOptional({ nullable: true })
  lastNotificationError: string | null;
}

/**
 * Consulta de incidencias para auditoría y monitoreo: qué caídas hubo, cuánto duraron, a cuántos
 * intentos afectaron y si los correos salieron. Protegido por la misma `x-api-key` que todo el
 * servicio.
 */
@ApiTags('incidents')
@Controller('incidents')
export class IncidentsController {
  /**
   * @param incidentService - Estado de las incidencias.
   * @returns El controlador.
   *
   * @example
   * ```ts
   * new IncidentsController(incidentService);
   * ```
   */
  constructor(private readonly incidentService: IncidentService) {}

  /**
   * Lista las incidencias más recientes del servicio.
   *
   * @param limit - Cuántas devolver (1 a `MAX_INCIDENTS_PAGE_SIZE`, 20 por defecto).
   * @returns Las incidencias, la más reciente primero.
   *
   * @throws {BadRequestException} Si `limit` no es un entero.
   *
   * @example
   * ```ts
   * // GET /api/v1/incidents?limit=5  (header x-api-key)
   * ```
   */
  @Get()
  @ApiOperation({
    summary: 'Listar incidencias de disponibilidad de OCSP',
    description:
      'Las más recientes primero, con sus contadores y el estado de los correos de aviso y recuperación.',
  })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiOkResponse({ type: ServiceIncidentDto, isArray: true })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  async findRecent(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ): Promise<ServiceIncidentDto[]> {
    const incidents = await this.incidentService.findRecent(
      Math.min(Math.max(limit, 1), MAX_INCIDENTS_PAGE_SIZE),
    );
    return incidents.map(toServiceIncidentDto);
  }
}

/**
 * @param incident - Fila de `service_incidents`.
 * @returns La incidencia con fechas en ISO-8601 y su duración.
 *
 * @example
 * ```ts
 * const dto = toServiceIncidentDto(incident);
 * ```
 */
export function toServiceIncidentDto(
  incident: ServiceIncidentEntity,
): ServiceIncidentDto {
  return {
    id: incident.id,
    service: incident.service,
    status: incident.status,
    startedAt: incident.startedAt.toISOString(),
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
    durationMs: incident.resolvedAt
      ? incident.resolvedAt.getTime() - incident.startedAt.getTime()
      : null,
    lastFailureAt: incident.lastFailureAt.toISOString(),
    lastErrorType: incident.lastErrorType,
    affectedAttempts: incident.affectedAttempts,
    failedHealthChecks: incident.failedHealthChecks,
    incidentAlertSent: incident.incidentAlertSent,
    incidentAlertAttempts: incident.incidentAlertAttempts,
    recoveryAlertSent: incident.recoveryAlertSent,
    recoveryAlertAttempts: incident.recoveryAlertAttempts,
    lastNotificationError: incident.lastNotificationError,
  };
}
