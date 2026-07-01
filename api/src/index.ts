import { getConfig } from './config.js';
import { createApp, buildDeps } from './app.js';
import { disconnectDb } from './db.js';

// Validate env first — on misconfig, print only the readable message (no stack)
// and exit non-zero, so operators see the aggregated error, not framework noise.
try {
  const config = getConfig();
  const deps = buildDeps();
  const app = createApp(deps);
  const server = app.listen(config.PORT, () => {
    console.log(`asab-api listening on http://localhost:${config.PORT}`);
  });

  // The entrypoint owns lifecycle: stop accepting connections, then drain the
  // queue's Redis connection and the DB pool, so a rolling restart leaks nothing.
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      server.close(() => {
        void Promise.allSettled([
          deps.queue.close(),
          deps.rateLimiter.close(),
          disconnectDb(),
        ]).finally(() => process.exit(0));
      });
    });
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
