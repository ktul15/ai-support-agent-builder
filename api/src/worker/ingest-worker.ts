import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { INGEST_QUEUE_NAME, type IngestJobData } from '../queue/index.js';
import type { ObjectStorage } from '../storage/index.js';
import { runIngestion, type DocumentStatusStore } from './pipeline.js';

const MAX_ERROR_LENGTH = 2000;

export interface IngestWorkerDeps {
  redisUrl: string;
  store: DocumentStatusStore;
  storage: ObjectStorage;
  concurrency?: number;
}

export interface IngestWorkerHandle {
  worker: Worker<IngestJobData>;
  shutdown(): Promise<void>;
}

/**
 * Create the ingestion worker: consumes the ingest queue and runs the pipeline
 * per job. A document is marked FAILED only after BullMQ exhausts the job's
 * retries — intermediate failures keep the partial status so the retry resumes.
 */
export function createIngestWorker(deps: IngestWorkerDeps): IngestWorkerHandle {
  const connection = new Redis(deps.redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker<IngestJobData>(
    INGEST_QUEUE_NAME,
    (job) => runIngestion(job.data, { store: deps.store, storage: deps.storage }),
    { connection, concurrency: deps.concurrency ?? 4 },
  );

  // Without an 'error' listener BullMQ's EventEmitter errors (e.g. a Redis blip)
  // become uncaught and crash the worker process.
  worker.on('error', (err) => {
    console.error('ingest worker error:', err);
  });

  worker.on('failed', (job, err) => {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= attempts) {
      void deps.store
        .markFailed(job.data.documentId, job.data.tenantId, err.message.slice(0, MAX_ERROR_LENGTH))
        .catch((e) => console.error('failed to mark document FAILED:', e));
    }
  });

  worker.on('completed', (job) => {
    console.log(`ingest job ${job.id} completed`);
  });

  return {
    worker,
    shutdown: async () => {
      await worker.close();
      await connection.quit();
    },
  };
}
