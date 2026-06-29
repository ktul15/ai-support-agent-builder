import type { Config } from '../config.js';
import { BullIngestQueue, type IngestQueue } from './ingest-queue.js';

export { INGEST_QUEUE_NAME, BullIngestQueue } from './ingest-queue.js';
export type { IngestQueue, IngestJobData } from './ingest-queue.js';

/** Build the ingest queue from config. */
export function createIngestQueue(config: Config): IngestQueue {
  return new BullIngestQueue(config.REDIS_URL);
}
