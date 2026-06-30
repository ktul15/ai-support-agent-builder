import { getConfig } from '../config.js';
import { disconnectDb } from '../db.js';
import { createStorage } from '../storage/index.js';
import { createProviders } from '../providers/index.js';
import { createIngestWorker } from './ingest-worker.js';
import { PrismaDocumentStatusStore } from './document-store.js';
import { reconcileStuckDocuments } from './reconciler.js';

// A document untouched for this long in a non-terminal status is stuck (a live
// job advances within seconds); sweep them to FAILED on this cadence.
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const STUCK_AGE_SECONDS = 15 * 60;

// Validate env first; on misconfig print only the readable message and exit.
try {
  const config = getConfig();
  const handle = createIngestWorker({
    redisUrl: config.REDIS_URL,
    store: new PrismaDocumentStatusStore(),
    storage: createStorage(config),
    embedder: createProviders(config).embedder,
  });
  console.log('ingest worker started');

  // A sweep is a single indexed UPDATE (sub-second), so overlapping intervals
  // aren't a concern; if that ever changes, add an in-flight guard here.
  const reconcileTimer = setInterval(() => {
    void reconcileStuckDocuments(STUCK_AGE_SECONDS)
      .then((n) => {
        if (n > 0) console.log(`reconciled ${n} stuck document(s) -> FAILED`);
      })
      .catch((err) => console.error('reconcile error:', err));
  }, RECONCILE_INTERVAL_MS);

  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(reconcileTimer);
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
