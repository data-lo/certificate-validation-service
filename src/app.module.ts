import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { CertificateValidationModule } from './certificate-validation/certificate-validation.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CertificateValidationModule,
  ],
})
export class AppModule {}
