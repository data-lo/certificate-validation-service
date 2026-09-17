import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { Request, Response } from 'express';

import {
  StandardErrorHttpException,
  toErrorResponse,
} from '../errors/standard-error';

/**
 * Último punto de escritura de las respuestas de error.
 *
 * Si el error ya pasó por `ErrorResponseInterceptor`, escribe su cuerpo tal cual. Si no pasó —el
 * guard de API Key rechazó la petición o la ruta no existe, dos casos que Nest resuelve antes de
 * ejecutar interceptores— lo traduce con la misma función, así que la estructura es idéntica.
 */
@Catch()
export class ErrorResponseFilter implements ExceptionFilter {
  /**
   * Escribe la respuesta de error estándar.
   *
   * @param exception - Lo que se haya lanzado.
   * @param host - Acceso a la petición y la respuesta de Express.
   * @returns Nada; responde directamente sobre `Response`.
   *
   * @example
   * ```ts
   * app.useGlobalFilters(new ErrorResponseFilter());
   * ```
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const body =
      exception instanceof StandardErrorHttpException
        ? exception.body
        : toErrorResponse(exception, request.originalUrl ?? request.url);

    response.status(body.statusCode).json(body);
  }
}
