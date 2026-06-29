import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const INGEST_QUEUE_NAME = 'ingest';

/** Payload the ingestion worker (#13) needs to run the pipeline for one doc. */
export interface IngestJobData {
  documentId: string;
  tenantId: string;
  assistantId: string;
}

/**
 * Producer-side queue abstraction. Feature code depends on this, not on BullMQ —
 * so the upload route is unit-testable with a fake and the worker (#13) owns the
 * consumer.
 */
export interface IngestQueue {
  enqueue(data: IngestJobData): Promise<void>;
  close(): Promise<void>;
}

/** BullMQ-backed ingest queue. */
export class BullIngestQueue implements IngestQueue {
  private readonly connection: Redis;
  private readonly queue: Queue<IngestJobData>;

  constructor(redisUrl: string) {
    // maxRetriesPerRequest: null is required by BullMQ. lazyConnect so merely
    // constructing the app (tests, boot) doesn't open a Redis socket — the
    // connection opens on the first enqueue.
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    this.queue = new Queue<IngestJobData>(INGEST_QUEUE_NAME, { connection: this.connection });
  }

  async enqueue(data: IngestJobData): Promise<void> {
    // jobId = documentId makes enqueue idempotent: re-enqueuing the same document
    // (retry, double-submit) collapses to one job instead of duplicating work.
    await this.queue.add('ingest', data, {
      jobId: data.documentId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
