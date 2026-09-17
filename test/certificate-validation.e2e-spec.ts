import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import {
  CertificateRevokedException,
  OcspServiceUnavailableException,
} from '../src/certificate-validation/exceptions/certificate.exceptions';
import { OcspService } from '../src/certificate-validation/services/ocsp.service';
import {
  TRUST_ANCHORS,
  loadTrustAnchors,
} from '../src/certificate-validation/services/trust-anchors.provider';

const API_KEY = 'e2e-certificate-validation-key';
const PATH = '/api/v1/certificates/validate';
const FIXTURES_DIR = join(__dirname, 'fixtures');
const leafCertificate = readFileSync(join(FIXTURES_DIR, 'leaf.cer')).toString(
  'base64',
);
const untrustedCertificate = readFileSync(
  join(FIXTURES_DIR, 'untrusted-leaf.cer'),
).toString('base64');

/**
 * Levanta la aplicación con la MISMA configuración global que producción (`configureApp`), y
 * sustituye sólo el almacén de confianza (por los certificados de prueba) y el OCSP (que saldría a
 * la red contra el SAT).
 */
describe('POST /api/v1/certificates/validate (e2e)', () => {
  let app: INestApplication;
  const checkRevocation = jest.fn();
  let loggedErrors: string[];

  beforeAll(async () => {
    process.env.API_KEY = API_KEY;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TRUST_ANCHORS)
      .useValue(loadTrustAnchors(join(FIXTURES_DIR, 'trust-anchors')))
      .overrideProvider(OcspService)
      .useValue({ checkRevocation })
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    loggedErrors = [];
    checkRevocation.mockReset().mockResolvedValue({
      status: 'good',
      verifiedAt: new Date('2026-09-17T18:00:00.000Z'),
      ocspResponse: 'b2NzcA==',
      ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
    });
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((message: string, stack?: string) => {
        loggedErrors.push(`${message}\n${stack ?? ''}`);
      });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const post = () =>
    request(app.getHttpServer()).post(PATH).set('x-api-key', API_KEY);

  function expectStandardError(
    body: Record<string, unknown>,
    statusCode: number,
    code: string,
    path = PATH,
  ) {
    expect(Object.keys(body).sort()).toEqual(
      ['code', 'message', 'path', 'statusCode', 'timestamp'].sort(),
    );
    expect(body).toMatchObject({ statusCode, code, path });
    expect(new Date(body.timestamp as string).toISOString()).toBe(
      body.timestamp,
    );
  }

  it('responde 200 con el resultado completo de un certificado válido', async () => {
    const response = await post()
      .send({ certificate: leafCertificate })
      .expect(200);

    expect(response.body).toMatchObject({
      isValid: true,
      validity: { isValid: true },
      trustChain: { isValid: true },
      revocation: { status: 'GOOD' },
      ocspEvidence: { status: 'good', ocspResponse: 'b2NzcA==' },
    });
  });

  describe('API Key', () => {
    it('rechaza sin header x-api-key', async () => {
      const response = await request(app.getHttpServer())
        .post(PATH)
        .send({ certificate: leafCertificate })
        .expect(401);

      expectStandardError(response.body, 401, 'INVALID_API_KEY');
      expect(checkRevocation).not.toHaveBeenCalled();
    });

    it('rechaza una API Key incorrecta', async () => {
      const response = await request(app.getHttpServer())
        .post(PATH)
        .set('x-api-key', 'otra-clave')
        .send({ certificate: leafCertificate })
        .expect(401);

      expectStandardError(response.body, 401, 'INVALID_API_KEY');
    });
  });

  it('responde RESOURCE_NOT_FOUND con la estructura estándar en una ruta inexistente', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/nope')
      .set('x-api-key', API_KEY);

    expect(response.status).toBe(404);
    expectStandardError(
      response.body,
      404,
      'RESOURCE_NOT_FOUND',
      '/api/v1/nope',
    );
  });

  describe('DTO', () => {
    it.each([
      ['sin certificado', {}],
      ['certificado que no es Base64', { certificate: 'no es base64!' }],
      ['campo desconocido', { certificate: leafCertificate, extra: true }],
      [
        'referenceDate mal formada',
        { certificate: leafCertificate, referenceDate: 'ayer' },
      ],
      [
        'allowUnverifiedRevocation no booleano',
        { certificate: leafCertificate, allowUnverifiedRevocation: 'yes' },
      ],
    ])('responde INVALID_REQUEST con %s', async (_, body) => {
      const response = await post().send(body).expect(400);

      expectStandardError(response.body, 400, 'INVALID_REQUEST');
    });

    it('responde INVALID_REQUEST con un JSON ilegible, sin exponer el error del parser', async () => {
      const response = await post()
        .set('content-type', 'application/json')
        .send('{"certificate":')
        .expect(400);

      expectStandardError(response.body, 400, 'INVALID_REQUEST');
      expect(JSON.stringify(response.body)).not.toMatch(/JSON|Unexpected/);
    });
  });

  it.each([
    [
      'INVALID_CERTIFICATE',
      400,
      { certificate: Buffer.from('no es un certificado').toString('base64') },
    ],
    [
      'CERTIFICATE_NOT_YET_VALID',
      422,
      { certificate: leafCertificate, referenceDate: '2020-01-01T00:00:00Z' },
    ],
    ['INVALID_TRUST_CHAIN', 422, { certificate: untrustedCertificate }],
  ])('responde %s', async (code, status, body) => {
    const response = await post().send(body).expect(status);

    expectStandardError(response.body, status, code);
  });

  it('responde CERTIFICATE_REVOKED', async () => {
    checkRevocation.mockRejectedValue(
      new CertificateRevokedException(new Date(), 'keyCompromise'),
    );

    const response = await post()
      .send({ certificate: leafCertificate })
      .expect(422);

    expectStandardError(response.body, 422, 'CERTIFICATE_REVOKED');
    expect(response.body.message).not.toContain('keyCompromise');
  });

  it('responde OCSP_SERVICE_UNAVAILABLE si el SAT no contesta', async () => {
    checkRevocation.mockRejectedValue(
      new OcspServiceUnavailableException(new Error('ETIMEDOUT 200.57.3.1')),
    );

    const response = await post()
      .send({ certificate: leafCertificate })
      .expect(503);

    expectStandardError(response.body, 503, 'OCSP_SERVICE_UNAVAILABLE');
    expect(JSON.stringify(response.body)).not.toContain('ETIMEDOUT');
    expect(loggedErrors.join()).toContain('ETIMEDOUT 200.57.3.1');
  });

  it('responde 200 sin evidencia si el SAT no contesta y la petición lo permite', async () => {
    checkRevocation.mockRejectedValue(new OcspServiceUnavailableException());

    const response = await post()
      .send({ certificate: leafCertificate, allowUnverifiedRevocation: true })
      .expect(200);

    expect(response.body.revocation.status).toBe('UNVERIFIED');
    expect(response.body).not.toHaveProperty('ocspEvidence');
  });

  it('responde CERTIFICATE_VALIDATION_ERROR ante un fallo inesperado, sin stack ni mensaje interno', async () => {
    checkRevocation.mockRejectedValue(
      new TypeError('Cannot read properties of undefined (reading secret)'),
    );

    const response = await post()
      .send({ certificate: leafCertificate })
      .expect(500);

    expectStandardError(response.body, 500, 'CERTIFICATE_VALIDATION_ERROR');
    expect(JSON.stringify(response.body)).not.toMatch(/secret|TypeError|at /);
    expect(loggedErrors.join()).toContain('TypeError');
  });
});
