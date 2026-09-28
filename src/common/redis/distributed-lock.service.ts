import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

/**
 * Libera el lock sólo si sigue siendo de quien lo tomó. Sin la comparación, una réplica cuyo lock
 * ya expiró borraría el que acaba de tomar otra.
 */
const RELEASE_IF_OWNER_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/** Cada cuánto se reintenta tomar un lock ocupado cuando se pidió esperar. */
export const LOCK_POLL_INTERVAL_MS = 250;

/** Resultado de `runExclusive`. */
export type ExclusiveRunResult<T> =
  { acquired: true; result: T } | { acquired: false };

/**
 * Lock distribuido sobre Redis (`SET key token NX PX ttl`), para que entre varias réplicas sólo
 * una ejecute a la vez el trabajo que no debe repetirse.
 *
 * Es un lock de una sola instancia de Redis, no Redlock: basta para que el chequeo y los correos
 * no se dupliquen en operación normal. Lo que de verdad no puede duplicarse (cerrar la incidencia,
 * marcar un correo como enviado) además se protege en la base con `UPDATE ... WHERE status = 'OPEN'`.
 */
@Injectable()
export class DistributedLockService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DistributedLockService.name);
  private client: Redis;

  /**
   * @param configService - Fuente de `REDIS_HOST`, `REDIS_PORT` y `REDIS_PASSWORD`.
   * @returns El servicio; se conecta en `onModuleInit`.
   *
   * @example
   * ```ts
   * const locks = new DistributedLockService(configService);
   * ```
   */
  constructor(private readonly configService: ConfigService) {}

  /**
   * Abre la conexión con Redis.
   *
   * `lazyConnect` + `maxRetriesPerRequest` acotan cuánto espera un comando si Redis está caído:
   * el lock falla rápido (y el trabajo se salta) en vez de colgar el cron.
   *
   * @returns Nada.
   *
   * @example
   * ```ts
   * locks.onModuleInit();
   * ```
   */
  onModuleInit(): void {
    this.client = new Redis({
      host: this.configService.get<string>('REDIS_HOST') || 'localhost',
      port: Number(this.configService.get<string>('REDIS_PORT')) || 6379,
      password: this.configService.get<string>('REDIS_PASSWORD') || undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    });
    this.client.on('error', (error: Error) =>
      this.logger.error(`Error de conexión con Redis: ${error.message}`),
    );
  }

  /**
   * Ejecuta `task` sólo si logra tomar el lock.
   *
   * Sin `waitMs`, si otra réplica tiene el lock no espera y responde `acquired: false`. Con
   * `waitMs`, reintenta cada `LOCK_POLL_INTERVAL_MS` hasta ese plazo: lo usa el cron, que ya
   * reclamó su ciclo y no debe perderlo porque el consumer esté enviando un correo en ese momento.
   *
   * @param key - Llave del lock.
   * @param ttlMs - Vida máxima del lock; debe cubrir con holgura lo que tarda `task`.
   * @param task - Trabajo exclusivo.
   * @param options.waitMs - Cuánto esperar a que se libere, en milisegundos (0 por defecto).
   * @returns `{ acquired: false }` si no se obtuvo el lock; si no, el resultado de `task`.
   *
   * @throws {Error} Lo que lance `task`, o el error de Redis al tomar el lock.
   *
   * @example
   * ```ts
   * const run = await locks.runExclusive(INCIDENT_KEY, 240_000, () => monitor.runCycle());
   * if (!run.acquired) logger.debug('Otra réplica tiene el lock');
   * ```
   */
  async runExclusive<T>(
    key: string,
    ttlMs: number,
    task: () => Promise<T>,
    options: { waitMs?: number } = {},
  ): Promise<ExclusiveRunResult<T>> {
    const token = randomUUID();
    const deadline = Date.now() + (options.waitMs ?? 0);

    while ((await this.client.set(key, token, 'PX', ttlMs, 'NX')) !== 'OK') {
      if (Date.now() >= deadline) {
        return { acquired: false };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, LOCK_POLL_INTERVAL_MS),
      );
    }

    try {
      return { acquired: true, result: await task() };
    } finally {
      await this.release(key, token);
    }
  }

  /**
   * Reclama una llave una sola vez entre todas las réplicas, sin liberarla: expira sola.
   *
   * Es lo que hace que un trabajo periódico corra UNA vez por periodo. Un lock que se libera al
   * terminar no basta: si la primera réplica termina en milisegundos, la segunda —cuyo cron se
   * disparó en el mismo segundo— lo encuentra libre y repite el trabajo (se reprodujo en local).
   *
   * @param key - Llave a reclamar, p. ej. la del periodo del cron.
   * @param ttlMs - Cuánto dura el reclamo.
   * @returns `true` si esta réplica la reclamó; `false` si otra ya lo había hecho.
   *
   * @throws {Error} Si Redis no responde.
   *
   * @example
   * ```ts
   * if (await locks.claimOnce(`${INCIDENT_KEY}:cycle:${slot}`, 600_000)) await runCycle();
   * ```
   */
  async claimOnce(key: string, ttlMs: number): Promise<boolean> {
    const claimed = await this.client.set(key, randomUUID(), 'PX', ttlMs, 'NX');
    return claimed === 'OK';
  }

  /**
   * Cierra la conexión con Redis.
   *
   * @returns Nada.
   *
   * @example
   * ```ts
   * await locks.onModuleDestroy();
   * ```
   */
  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }

  /**
   * Suelta el lock si sigue siendo nuestro. Un fallo aquí sólo se registra: el lock expira solo.
   *
   * @param key - Llave del lock.
   * @param token - Token con el que se tomó.
   * @returns Nada.
   *
   * @example
   * ```ts
   * await this.release(INCIDENT_KEY, token);
   * ```
   */
  private async release(key: string, token: string): Promise<void> {
    try {
      await this.client.eval(RELEASE_IF_OWNER_SCRIPT, 1, key, token);
    } catch (error) {
      this.logger.warn(
        `No se pudo liberar el lock ${key}; expirará solo: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
