import { Module } from '@nestjs/common';

import { CertificateValidationController } from './certificate-validation.controller';
import { CertificateValidationService } from './services/certificate-validation.service';
import { OcspService } from './services/ocsp.service';
import { TrustChainService } from './services/trust-chain.service';
import { trustAnchorsProvider } from './services/trust-anchors.provider';

@Module({
  controllers: [CertificateValidationController],
  providers: [
    trustAnchorsProvider,
    TrustChainService,
    OcspService,
    CertificateValidationService,
  ],
})
export class CertificateValidationModule {}
