import { getConfig } from '../config.js';
import { disconnectDb } from '../db.js';
import { createStorage } from '../storage/index.js';
import { createIngestWorker } from './ingest-worker.js';
import { PrismaDocumentStatusStore } from './document-store.js';

// Validate env first; on misconfig print only the readable message and exit.
try {
  const config = getConfig();
  const handle = createIngestWorker({
    redisUrl: config.REDIS_URL,
    store: new PrismaDocumentStatusStore(),
    storage: createStorage(config),
  });
  console.log('ingest worker started');

  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      handle
        .shutdown()
        .then(() => disconnectDb())
        .then(() => process.exit(0))
        .catch((err) => {
          console.error('worker shutdown failed:', err);
          process.exit(1);
        });
    });
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
