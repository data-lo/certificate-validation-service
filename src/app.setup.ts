import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ApiKeyGuard } from './auth/api-key.guard';
import { ErrorResponseFilter } from './common/filters/error-response.filter';
import { ErrorResponseInterceptor } from './common/interceptors/error-response.interceptor';
import { InvalidRequestException } from './common/exceptions/common.exceptions';

/** Prefijo de todas las rutas: el endpoint queda en `/api/v1/certificates/validate`. */
export const GLOBAL_PREFIX = 'api/v1';

/**
 * Aplica la configuración global de la aplicación: prefijo, API Key, validación y errores.
 *
 * Vive fuera de `main.ts` para que las pruebas e2e levanten exactamente la misma aplicación que
 * producción, en vez de una copia que se desincronice.
 *
 * @param app - Aplicación Nest ya creada.
 * @returns Nada; muta la aplicación recibida.
 *
 * @throws {Error} Si `API_KEY` no está configurada (lo lanza `ApiKeyGuard`).
 *
 * @example
 * ```ts
 * const app = await NestFactory.create(AppModule);
 * configureApp(app);
 * ```
 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix(GLOBAL_PREFIX);
  app.useGlobalGuards(new ApiKeyGuard(app.get(ConfigService)));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // Las restricciones que fallaron van al log; al consumidor, sólo `INVALID_REQUEST`.
      exceptionFactory: (errors) =>
        new InvalidRequestException(
          errors
            .flatMap((error) => Object.values(error.constraints ?? {}))
            .join('; '),
        ),
    }),
  );
  app.useGlobalInterceptors(new ErrorResponseInterceptor());
  app.useGlobalFilters(new ErrorResponseFilter());
}
