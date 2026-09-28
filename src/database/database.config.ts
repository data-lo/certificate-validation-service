import { join } from 'node:path';
import { DataSourceOptions } from 'typeorm';

import { OcspFailureEventEntity } from '../incidents/entities/ocsp-failure-event.entity';
import { ServiceIncidentEntity } from '../incidents/entities/service-incident.entity';

/** Base de datos por defecto: una propia del servicio dentro del Postgres local de Signature. */
export const DEFAULT_DB_NAME = 'certificate_validation_db';

/**
 * Opciones de conexión a Postgres, compartidas por la aplicación y por el CLI de migraciones.
 *
 * Las migraciones se aplican solas al arrancar (`migrationsRun`) y `synchronize` queda apagado:
 * el esquema sólo cambia por migración.
 *
 * @param env - Variables de entorno (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`).
 * @returns Las opciones de TypeORM.
 *
 * @example
 * ```ts
 * const dataSource = new DataSource(buildDatabaseOptions(process.env));
 * ```
 */
export function buildDatabaseOptions(
  env: Record<string, string | undefined>,
): DataSourceOptions {
  return {
    type: 'postgres',
    host: env.DB_HOST || 'localhost',
    port: Number(env.DB_PORT) || 5432,
    username: env.DB_USER || 'postgres',
    password: env.DB_PASSWORD,
    database: env.DB_NAME || DEFAULT_DB_NAME,
    entities: [ServiceIncidentEntity, OcspFailureEventEntity],
    // Sólo la extensión de lo que se está ejecutando: compilado, `dist/` también trae los `.d.ts`
    // (`declaration: true`) y un glob `*.{ts,js}` los cargaría como migraciones.
    migrations: [
      join(
        __dirname,
        'migrations',
        `*${__filename.endsWith('.ts') ? '.ts' : '.js'}`,
      ),
    ],
    migrationsRun: true,
    synchronize: false,
  };
}
