import { Module } from '@nestjs/common';

import { CertificateValidationController } from './certificate-validation.controller';
import { CertificateValidationService } from './services/certificate-validation.service';
import { OcspService } from './services/ocsp.service';
import { TrustChainService } from './services/trust-chain.service';
import { trustAnchorsProvider } from './services/trust-anchors.provider';
import { OcspFailureEventsModule } from '../incidents/ocsp-failure-events.module';

@Module({
  imports: [OcspFailureEventsModule],
  controllers: [CertificateValidationController],
  providers: [
    trustAnchorsProvider,
    TrustChainService,
    OcspService,
    CertificateValidationService,
  ],
  // El chequeo de salud de incidencias consulta OCSP con los mismos servicios que la validación.
  exports: [OcspService, TrustChainService],
})
export class CertificateValidationModule {}
