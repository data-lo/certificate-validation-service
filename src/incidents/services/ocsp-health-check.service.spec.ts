import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CertificateRevokedException,
  OcspServiceUnavailableException,
} from '../../certificate-validation/exceptions/certificate.exceptions';
import { OcspService } from '../../certificate-validation/services/ocsp.service';
import { loadTrustAnchors } from '../../certificate-validation/services/trust-anchors.provider';
import { TrustChainService } from '../../certificate-validation/services/trust-chain.service';
import { OCSP_FAILURE_TYPE_ENUM } from '../incident.constants';
import { OcspHealthCheckService } from './ocsp-health-check.service';

const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'test', 'fixtures');
const leafCertificate = readFileSync(join(FIXTURES_DIR, 'leaf.cer')).toString(
  'base64',
);

function build(
  env: Record<string, string>,
  checkRevocation: jest.Mock = jest.fn(),
): OcspHealthCheckService {
  return new OcspHealthCheckService(
    { get: (key: string) => env[key] } as unknown as ConfigService,
    { checkRevocation } as unknown as OcspService,
    new TrustChainService(
      loadTrustAnchors(join(FIXTURES_DIR, 'trust-anchors')),
    ),
  );
}

describe('OcspHealthCheckService', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('sin certificado de sonda: alcance del respondedor', () => {
    it('responder con cualquier HTTP menor a 500 es estar sano', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 400 }));

      await expect(
        build({ OCSP_URL: 'https://ocsp.test' }).check(),
      ).resolves.toEqual({ healthy: true });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://ocsp.test',
        expect.objectContaining({
          method: 'POST',
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it('un 5xx es OCSP_UNAVAILABLE', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

      await expect(build({}).check()).resolves.toMatchObject({
        healthy: false,
        errorType: OCSP_FAILURE_TYPE_ENUM.OCSP_UNAVAILABLE,
      });
    });

    it('un timeout es TIMEOUT', async () => {
      fetchMock.mockRejectedValue(
        Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
      );

      await expect(build({}).check()).resolves.toMatchObject({
        healthy: false,
        errorType: OCSP_FAILURE_TYPE_ENUM.TIMEOUT,
      });
    });

    it('un fallo de red es NETWORK_ERROR, con la causa en el mensaje', async () => {
      fetchMock.mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), {
          cause: new Error('dh key too small'),
        }),
      );

      await expect(build({}).check()).resolves.toEqual({
        healthy: false,
        errorType: OCSP_FAILURE_TYPE_ENUM.NETWORK_ERROR,
        errorMessage:
          'Failed to send OCSP request: fetch failed (dh key too small)',
      });
    });
  });

  describe('con certificado de sonda: consulta OCSP real', () => {
    it('consulta con el certificado y su emisor, sin tocar el endpoint a mano', async () => {
      const checkRevocation = jest.fn().mockResolvedValue({});

      await expect(
        build(
          { OCSP_HEALTH_CHECK_CERTIFICATE: leafCertificate },
          checkRevocation,
        ).check(),
      ).resolves.toEqual({ healthy: true });
      const [, issuer] = checkRevocation.mock.calls[0];
      expect(issuer.subject).toContain('CN=Test Intermediate CA');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('un revocado también prueba que el SAT responde', async () => {
      const checkRevocation = jest
        .fn()
        .mockRejectedValue(new CertificateRevokedException());

      await expect(
        build(
          { OCSP_HEALTH_CHECK_CERTIFICATE: leafCertificate },
          checkRevocation,
        ).check(),
      ).resolves.toEqual({ healthy: true });
    });

    it('clasifica la causa de OcspServiceUnavailableException', async () => {
      const checkRevocation = jest
        .fn()
        .mockRejectedValue(
          new OcspServiceUnavailableException(
            new Error(
              'Failed to send OCSP request: Operation timed out after 5000ms',
            ),
          ),
        );

      await expect(
        build(
          { OCSP_HEALTH_CHECK_CERTIFICATE: leafCertificate },
          checkRevocation,
        ).check(),
      ).resolves.toMatchObject({
        healthy: false,
        errorType: OCSP_FAILURE_TYPE_ENUM.TIMEOUT,
      });
    });

    it('un certificado de sonda inválido cae al chequeo por alcance', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
      const checkRevocation = jest.fn();

      await build(
        { OCSP_HEALTH_CHECK_CERTIFICATE: 'bm8tZXMtdW4tY2VydGlmaWNhZG8=' },
        checkRevocation,
      ).check();

      expect(checkRevocation).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalled();
    });

    /** Una sonda vencida haría fallar cada chequeo y la incidencia no se cerraría nunca. */
    it('una sonda vencida cae al chequeo por alcance', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
      const checkRevocation = jest.fn();
      const service = build(
        { OCSP_HEALTH_CHECK_CERTIFICATE: leafCertificate },
        checkRevocation,
      );
      jest.useFakeTimers({ now: new Date('2130-01-01T00:00:00Z') });

      await expect(service.check()).resolves.toEqual({ healthy: true });
      jest.useRealTimers();

      expect(checkRevocation).not.toHaveBeenCalled();
    });
  });
});
