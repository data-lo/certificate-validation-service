import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

import { InvalidApiKeyException } from '../common/exceptions/common.exceptions';

/** Header en el que los consumidores envían la clave. */
export const API_KEY_HEADER = 'x-api-key';

/**
 * Protege todos los endpoints exigiendo el header `x-api-key` igual a la variable `API_KEY`.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly expectedDigest: Buffer;

  /**
   * Lee `API_KEY` una sola vez al construirse.
   *
   * @param configService - Fuente de las variables de entorno.
   * @returns El guard listo para registrarse.
   *
   * @throws {Error} Si `API_KEY` no está configurada o está vacía: sin clave el servicio no debe
   * arrancar, porque quedaría rechazando todo sin que nadie supiera por qué.
   *
   * @example
   * ```ts
   * app.useGlobalGuards(new ApiKeyGuard(app.get(ConfigService)));
   * ```
   */
  constructor(configService: ConfigService) {
    const apiKey = configService.get<string>('API_KEY');

    if (!apiKey?.trim()) {
      throw new Error(
        'Falta la variable API_KEY: el servicio no arranca sin una clave para x-api-key',
      );
    }

    this.expectedDigest = digest(apiKey);
  }

  /**
   * Compara la clave recibida con la configurada en tiempo constante.
   *
   * Se comparan los SHA-256 de ambas y no las cadenas: `timingSafeEqual` exige longitudes iguales,
   * y comparar primero la longitud filtraría cuánto mide la clave. La clave recibida nunca se
   * registra, ni siquiera cuando es incorrecta.
   *
   * @param context - Contexto de la petición HTTP.
   * @returns `true` cuando la clave coincide.
   *
   * @throws {InvalidApiKeyException} Si el header falta, viene repetido o no coincide.
   *
   * @example
   * ```ts
   * guard.canActivate(context); // true o lanza InvalidApiKeyException
   * ```
   */
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const received = request.headers[API_KEY_HEADER];

    if (typeof received !== 'string' || received.length === 0) {
      throw new InvalidApiKeyException(`Header ${API_KEY_HEADER} ausente`);
    }

    if (!timingSafeEqual(digest(received), this.expectedDigest)) {
      throw new InvalidApiKeyException(
        `Header ${API_KEY_HEADER} no coincide con API_KEY`,
      );
    }

    return true;
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
