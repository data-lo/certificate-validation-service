import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CertificateValidationModule } from '../certificate-validation/certificate-validation.module';
import { DistributedLockService } from '../common/redis/distributed-lock.service';
import { OcspValidationFailedConsumer } from './consumers/ocsp-validation-failed.consumer';
import { OcspFailureEventEntity } from './entities/ocsp-failure-event.entity';
import { ServiceIncidentEntity } from './entities/service-incident.entity';
import { IncidentsController } from './incidents.controller';
import { OcspIncidentMonitorJob } from './jobs/ocsp-incident-monitor.job';
import { IncidentEmailService } from './notifications/incident-email.service';
import { IncidentNotifier } from './notifications/incident-notifier.service';
import { IncidentMonitorService } from './services/incident-monitor.service';
import { IncidentService } from './services/incident.service';
import { OcspHealthCheckService } from './services/ocsp-health-check.service';

/**
 * Incidencias de disponibilidad de OCSP: consumer de Kafka, estado en Postgres, cron de salud y
 * correos al equipo operativo.
 *
 * La publicación de eventos no vive aquí sino en `OcspFailureEventsModule`, que es lo único que
 * necesita la validación de certificados.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ServiceIncidentEntity, OcspFailureEventEntity]),
    CertificateValidationModule,
  ],
  controllers: [IncidentsController, OcspValidationFailedConsumer],
  providers: [
    DistributedLockService,
    IncidentService,
    IncidentEmailService,
    IncidentNotifier,
    OcspHealthCheckService,
    IncidentMonitorService,
    OcspIncidentMonitorJob,
  ],
})
export class IncidentsModule {}
