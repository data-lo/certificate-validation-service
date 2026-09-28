import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { InvalidRequestException } from '../../common/exceptions/common.exceptions';
import { REVOCATION_STATUS_ENUM } from '../dto/validate-certificate-response.dto';
import {
  CertificateExpiredException,
  CertificateNotYetValidException,
  CertificateRevokedException,
  InvalidCertificateException,
  InvalidTrustChainException,
  OcspServiceUnavailableException,
} from '../exceptions/certificate.exceptions';
import { CertificateValidationService } from './certificate-validation.service';
import { OcspEvidence, OcspService } from './ocsp.service';
import { loadTrustAnchors } from './trust-anchors.provider';
import { TrustChainService } from './trust-chain.service';
import { OcspFailureEventPublisher } from '../../incidents/ocsp-failure-event.publisher';

const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'test', 'fixtures');
const leafCertificate = readFileSync(join(FIXTURES_DIR, 'leaf.cer')).toString(
  'base64',
);
const untrustedCertificate = readFileSync(
  join(FIXTURES_DIR, 'untrusted-leaf.cer'),
).toString('base64');

/**
 * La cadena de confianza se prueba de verdad contra los certificados de `test/fixtures`; sólo el
 * OCSP se sustituye, porque consultarlo sale a la red contra el SAT.
 */
describe('CertificateValidationService', () => {
  const evidence: OcspEvidence = {
    status: 'good',
    verifiedAt: new Date('2026-09-17T18:00:00.000Z'),
    ocspResponse: 'b2NzcA==',
    ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
  };
  let checkRevocation: jest.Mock;
  let publish: jest.Mock;
  let service: CertificateValidationService;

  beforeEach(() => {
    checkRevocation = jest.fn().mockResolvedValue(evidence);
    publish = jest.fn().mockResolvedValue(null);
    service = new CertificateValidationService(
      new TrustChainService(
        loadTrustAnchors(join(FIXTURES_DIR, 'trust-anchors')),
      ),
      { checkRevocation } as unknown as OcspService,
      { publish } as unknown as OcspFailureEventPublisher,
    );
  });

  afterEach(() => jest.useRealTimers());

  it('devuelve vigencia, cadena, revocación y evidencia de un certificado válido', async () => {
    const result = await service.validate({ certificate: leafCertificate });

    expect(result.isValid).toBe(true);
    expect(result.validity.isValid).toBe(true);
    expect(result.trustChain).toEqual({
      isValid: true,
      issuer: 'C=MX, O=Signature Test, CN=Test Intermediate CA',
      root: 'C=MX, O=Signature Test, CN=Test Root CA',
    });
    expect(result.revocation).toEqual({
      status: REVOCATION_STATUS_ENUM.GOOD,
      checkedAt: '2026-09-17T18:00:00.000Z',
    });
    expect(result.ocspEvidence).toEqual({
      status: 'good',
      verifiedAt: '2026-09-17T18:00:00.000Z',
      ocspResponse: 'b2NzcA==',
      ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
    });
  });

  it('consulta OCSP con el emisor INMEDIATO, no con la raíz', async () => {
    await service.validate({ certificate: leafCertificate });

    const [, issuer] = checkRevocation.mock.calls[0];
    expect(issuer.subject).toContain('CN=Test Intermediate CA');
  });

  it('reporta UNKNOWN cuando el SAT no reconoce el certificado', async () => {
    checkRevocation.mockResolvedValue({ ...evidence, status: 'unknown' });

    const result = await service.validate({ certificate: leafCertificate });

    expect(result.revocation.status).toBe(REVOCATION_STATUS_ENUM.UNKNOWN);
  });

  it('rechaza con InvalidCertificateException lo que no es un certificado', async () => {
    await expect(
      service.validate({ certificate: Buffer.from('no').toString('base64') }),
    ).rejects.toBeInstanceOf(InvalidCertificateException);
  });

  it('rechaza con CertificateExpiredException un certificado vencido', async () => {
    jest.useFakeTimers({ now: new Date('2130-01-01T00:00:00.000Z') });

    await expect(
      service.validate({ certificate: leafCertificate }),
    ).rejects.toBeInstanceOf(CertificateExpiredException);
    expect(checkRevocation).not.toHaveBeenCalled();
  });

  it('rechaza con CertificateNotYetValidException una fecha anterior a su vigencia', async () => {
    await expect(
      service.validate({
        certificate: leafCertificate,
        referenceDate: '2020-01-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(CertificateNotYetValidException);
  });

  it('evalúa la vigencia contra referenceDate cuando se envía', async () => {
    jest.useFakeTimers({ now: new Date('2130-01-01T00:00:00.000Z') });

    const result = await service.validate({
      certificate: leafCertificate,
      referenceDate: '2100-01-01T00:00:00.000Z',
    });

    expect(result.validity.evaluatedAt).toBe('2100-01-01T00:00:00.000Z');
  });

  it('rechaza una referenceDate en el futuro', async () => {
    await expect(
      service.validate({
        certificate: leafCertificate,
        referenceDate: '2100-01-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(InvalidRequestException);
  });

  it('rechaza con InvalidTrustChainException un certificado de una raíz ajena', async () => {
    await expect(
      service.validate({ certificate: untrustedCertificate }),
    ).rejects.toBeInstanceOf(InvalidTrustChainException);
    expect(checkRevocation).not.toHaveBeenCalled();
  });

  it('propaga CertificateRevokedException aunque se permita la revocación sin verificar', async () => {
    checkRevocation.mockRejectedValue(new CertificateRevokedException());

    await expect(
      service.validate({
        certificate: leafCertificate,
        allowUnverifiedRevocation: true,
      }),
    ).rejects.toBeInstanceOf(CertificateRevokedException);
  });

  it('propaga OcspServiceUnavailableException por defecto', async () => {
    checkRevocation.mockRejectedValue(new OcspServiceUnavailableException());

    await expect(
      service.validate({ certificate: leafCertificate }),
    ).rejects.toBeInstanceOf(OcspServiceUnavailableException);
  });

  it('responde UNVERIFIED y sin evidencia si el SAT no responde y la petición lo permite', async () => {
    checkRevocation.mockRejectedValue(new OcspServiceUnavailableException());

    const result = await service.validate({
      certificate: leafCertificate,
      allowUnverifiedRevocation: true,
    });

    expect(result.isValid).toBe(true);
    expect(result.revocation.status).toBe(REVOCATION_STATUS_ENUM.UNVERIFIED);
    expect(result).not.toHaveProperty('ocspEvidence');
  });

  describe('publicación del fallo OCSP', () => {
    it.each([false, true])(
      'publica el fallo con la causa y el contexto del intento (allowUnverifiedRevocation=%s)',
      async (allowUnverifiedRevocation) => {
        const cause = new Error(
          'Failed to send OCSP request: Operation timed out after 5000ms',
        );
        checkRevocation.mockRejectedValue(
          new OcspServiceUnavailableException(cause),
        );

        await service
          .validate({
            certificate: leafCertificate,
            allowUnverifiedRevocation,
            signingRequestId: 'doc-1',
            userId: 'user-1',
          })
          .catch(() => undefined);

        expect(publish).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenCalledWith(cause, {
          certificateSerial: expect.any(String),
          signingRequestId: 'doc-1',
          userId: 'user-1',
        });
      },
    );

    /** Revocado es una respuesta del SAT, no una caída: no cuenta para ninguna incidencia. */
    it('no publica nada si el certificado está revocado', async () => {
      checkRevocation.mockRejectedValue(new CertificateRevokedException());

      await expect(
        service.validate({ certificate: leafCertificate }),
      ).rejects.toBeInstanceOf(CertificateRevokedException);
      expect(publish).not.toHaveBeenCalled();
    });

    it('no publica nada si OCSP respondió', async () => {
      await service.validate({ certificate: leafCertificate });

      expect(publish).not.toHaveBeenCalled();
    });

    /** Kafka caído no puede tumbar la validación: la respuesta no espera a la publicación. */
    it('responde aunque la publicación nunca termine', async () => {
      publish.mockReturnValue(new Promise(() => undefined));
      checkRevocation.mockRejectedValue(new OcspServiceUnavailableException());

      const result = await service.validate({
        certificate: leafCertificate,
        allowUnverifiedRevocation: true,
      });

      expect(result.revocation.status).toBe(REVOCATION_STATUS_ENUM.UNVERIFIED);
    });
  });
});
