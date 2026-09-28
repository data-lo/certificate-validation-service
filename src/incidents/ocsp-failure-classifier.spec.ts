import { OCSP_FAILURE_TYPE_ENUM } from './incident.constants';
import { classifyOcspError, describeError } from './ocsp-failure-classifier';

/** Los mensajes son los que arma `easy-ocsp` (ver su `fetchWrapper` y `sendOCSPRequest`). */
describe('classifyOcspError', () => {
  it.each([
    [
      'timeout de easy-ocsp',
      new Error(
        'Failed to send OCSP request: Operation timed out after 5000ms',
      ),
      OCSP_FAILURE_TYPE_ENUM.TIMEOUT,
    ],
    [
      'AbortError crudo',
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
      OCSP_FAILURE_TYPE_ENUM.TIMEOUT,
    ],
    [
      'TimeoutError de AbortSignal.timeout',
      Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
      OCSP_FAILURE_TYPE_ENUM.TIMEOUT,
    ],
    [
      'DNS',
      new Error(
        'Failed to send OCSP request: fetch failed (getaddrinfo ENOTFOUND cfdi.sat.gob.mx)',
      ),
      OCSP_FAILURE_TYPE_ENUM.NETWORK_ERROR,
    ],
    [
      'TLS del SAT en Node 24',
      new Error('Failed to send OCSP request: fetch failed (dh key too small)'),
      OCSP_FAILURE_TYPE_ENUM.NETWORK_ERROR,
    ],
    [
      'HTTP de error',
      new Error('OCSP request failed with http status 503 Service Unavailable'),
      OCSP_FAILURE_TYPE_ENUM.OCSP_UNAVAILABLE,
    ],
    [
      'estado OCSP tryLater',
      new Error('OCSP server response: tryLater'),
      OCSP_FAILURE_TYPE_ENUM.OCSP_UNAVAILABLE,
    ],
    ['algo que no es Error', 'boom', OCSP_FAILURE_TYPE_ENUM.OCSP_UNAVAILABLE],
  ])('%s → %s', (_label, error, expected) => {
    expect(classifyOcspError(error)).toBe(expected);
  });
});

describe('describeError', () => {
  it('usa el message de un Error y convierte lo demás a texto', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError(42)).toBe('42');
  });
});
