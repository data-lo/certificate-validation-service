import { Logger, Provider } from '@nestjs/common';
import { X509Certificate } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Token de inyección de los certificados de confianza (AC raíz e intermedias del SAT). */
export const TRUST_ANCHORS = Symbol('TRUST_ANCHORS');

/**
 * Directorio por defecto: `trust-anchors/` junto al código compilado.
 *
 * Se resuelve desde `__dirname` y no desde `process.cwd()` —como hacía `EfirmaService`— para que
 * el servicio encuentre sus certificados sin importar desde qué carpeta se arranque. `nest build`
 * copia `src/trust-anchors` a `dist/trust-anchors` (ver `nest-cli.json`); en las pruebas con
 * ts-jest el mismo camino relativo apunta a `src/trust-anchors`.
 */
export const DEFAULT_TRUST_ANCHORS_DIR = join(
  __dirname,
  '..',
  '..',
  'trust-anchors',
);

const logger = new Logger('TrustAnchors');

/**
 * Carga todos los `.cer`/`.crt` de un directorio como certificados X.509.
 *
 * Acepta DER y PEM indistintamente, que es como vienen mezclados los que publica el SAT.
 *
 * @param directory - Carpeta de la que leer los certificados.
 * @returns Los certificados cargados, en el orden en que los lista el sistema de archivos.
 *
 * @throws {Error} Si la carpeta no existe, si no contiene ningún certificado o si alguno no es
 * legible: arrancar con un almacén incompleto rechazaría firmas válidas sin explicación.
 *
 * @example
 * ```ts
 * const anchors = loadTrustAnchors(DEFAULT_TRUST_ANCHORS_DIR);
 * ```
 */
export function loadTrustAnchors(directory: string): X509Certificate[] {
  const fileNames = readdirSync(directory).filter((fileName) =>
    /\.(cer|crt)$/i.test(fileName),
  );

  if (fileNames.length === 0) {
    throw new Error(`No hay certificados de confianza en ${directory}`);
  }

  const anchors = fileNames.map((fileName) => {
    try {
      return new X509Certificate(readFileSync(join(directory, fileName)));
    } catch (error) {
      logger.error(
        `No se pudo cargar ${fileName}: ${(error as Error).message}`,
      );
      throw error;
    }
  });

  logger.log(`Cargados ${anchors.length} certificados de confianza`);
  return anchors;
}

/** Provider que carga el almacén de confianza una sola vez al arrancar. */
export const trustAnchorsProvider: Provider = {
  provide: TRUST_ANCHORS,
  useFactory: () => loadTrustAnchors(DEFAULT_TRUST_ANCHORS_DIR),
};
