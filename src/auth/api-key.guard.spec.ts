import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { InvalidApiKeyException } from '../common/exceptions/common.exceptions';
import { ApiKeyGuard } from './api-key.guard';

function configWith(apiKey: string | undefined): ConfigService {
  return { get: () => apiKey } as unknown as ConfigService;
}

function contextWith(headers: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

describe('ApiKeyGuard', () => {
  it.each([undefined, '', '   '])(
    'no se construye si API_KEY es %p',
    (apiKey) => {
      expect(() => new ApiKeyGuard(configWith(apiKey))).toThrow(/API_KEY/);
    },
  );

  const guard = new ApiKeyGuard(configWith('clave-correcta'));

  it('acepta la clave correcta', () => {
    expect(
      guard.canActivate(contextWith({ 'x-api-key': 'clave-correcta' })),
    ).toBe(true);
  });

  it.each([
    ['ausente', {}],
    ['vacía', { 'x-api-key': '' }],
    ['incorrecta', { 'x-api-key': 'clave-incorrecta' }],
    ['prefijo de la correcta', { 'x-api-key': 'clave' }],
    ['repetida', { 'x-api-key': ['clave-correcta', 'clave-correcta'] }],
  ])('rechaza la clave %s', (_, headers) => {
    expect(() => guard.canActivate(contextWith(headers))).toThrow(
      InvalidApiKeyException,
    );
  });
});
