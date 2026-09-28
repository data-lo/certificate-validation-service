import { Logger } from '@nestjs/common';
import { Kafka } from 'kafkajs';

import { OCSP_VALIDATION_FAILED_TOPIC } from './incident.constants';

/** Topics que el servicio publica y consume. */
export const SERVICE_TOPICS = [OCSP_VALIDATION_FAILED_TOPIC];

/**
 * Crea los topics del servicio si no existen, antes de arrancar el consumer.
 *
 * **Por qué hace falta.** Con un topic inexistente, la suscripción del consumer de Nest recibe
 * `UNKNOWN_TOPIC_OR_PARTITION` y el error escapa sin capturar: el proceso se cae en el primer
 * arranque contra un Kafka nuevo (se reprodujo en local). `allowAutoTopicCreation` no alcanza,
 * porque la metadata se pide antes de que el broker termine de crearlo.
 *
 * Es idempotente: `createTopics` responde `false` si ya existen. Un fallo aquí no detiene el
 * arranque —se registra y se deja que el consumer lo intente—, para no hacer depender la
 * validación de certificados de que Kafka acepte operaciones de administración.
 *
 * @param brokers - Brokers de Kafka.
 * @param clientId - Identificador del cliente de administración.
 * @returns Nada.
 *
 * @example
 * ```ts
 * await ensureKafkaTopics(['localhost:9094'], 'certificate-validation-service');
 * ```
 */
export async function ensureKafkaTopics(
  brokers: string[],
  clientId: string,
): Promise<void> {
  const logger = new Logger('KafkaTopics');
  const admin = new Kafka({
    clientId: `${clientId}-admin`,
    brokers,
    retry: { retries: 3 },
  }).admin();

  try {
    await admin.connect();
    const created = await admin.createTopics({
      topics: SERVICE_TOPICS.map((topic) => ({ topic })),
      waitForLeaders: true,
    });
    logger.log(
      created
        ? `Topics creados: ${SERVICE_TOPICS.join(', ')}`
        : `Topics ya existentes: ${SERVICE_TOPICS.join(', ')}`,
    );
  } catch (error) {
    logger.error(
      `No se pudieron asegurar los topics ${SERVICE_TOPICS.join(', ')}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}
