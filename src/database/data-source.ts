import 'reflect-metadata';
import { DataSource } from 'typeorm';

import { buildDatabaseOptions } from './database.config';

/**
 * Data source del CLI de TypeORM (`npm run migration:run`, `migration:revert`).
 *
 * El CLI no carga `.env` por su cuenta: se le pasa con `node --env-file=.env` en los scripts.
 */
export default new DataSource(buildDatabaseOptions(process.env));
