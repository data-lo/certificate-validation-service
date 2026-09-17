import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable, catchError, throwError } from 'rxjs';

import {
  StandardErrorHttpException,
  toErrorResponse,
} from '../errors/standard-error';

/**
 * Interceptor global que convierte cualquier error del endpoint en la estructura estándar.
 *
 * Envuelve los pipes y el handler, así que cubre los errores de validación del DTO, las
 * excepciones de dominio y cualquier fallo inesperado. Lo que ocurre ANTES de los interceptores
 * —el guard de API Key y las rutas inexistentes— lo cubre `ErrorResponseFilter` con la misma
 * traducción, para que ninguna respuesta de error se salga del formato.
 */
@Injectable()
export class ErrorResponseInterceptor implements NestInterceptor {
  /**
   * Deja pasar la respuesta y, si el flujo falla, relanza el error ya traducido.
   *
   * El error original se registra en el log dentro de `toErrorResponse`; lo que sigue su camino
   * hacia el filtro es sólo la versión segura de exponer.
   *
   * @param context - Contexto de la petición HTTP en curso.
   * @param next - Siguiente eslabón (pipes + handler).
   * @returns El flujo de la respuesta, con los errores sustituidos por `StandardErrorHttpException`.
   *
   * @example
   * ```ts
   * app.useGlobalInterceptors(new ErrorResponseInterceptor());
   * ```
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();

    return next
      .handle()
      .pipe(
        catchError((error: unknown) =>
          throwError(() =>
            error instanceof StandardErrorHttpException
              ? error
              : new StandardErrorHttpException(
                  toErrorResponse(error, request.originalUrl ?? request.url),
                ),
          ),
        ),
      );
  }
}
