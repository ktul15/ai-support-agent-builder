import express, { type Express, type Request, type Response } from 'express';
import { getConfig } from './config.js';
import { authRouter } from './routes/auth.js';
import { documentsRouter } from './routes/documents.js';
import { tenantContext } from './middleware/tenant-context.js';
import { createStorage } from './storage/index.js';
import { createIngestQueue } from './queue/index.js';
import type { ObjectStorage } from './storage/index.js';
import type { IngestQueue } from './queue/index.js';

/** External collaborators the app needs. Injected so tests can pass fakes. */
export interface AppDeps {
  storage: ObjectStorage;
  queue: IngestQueue;
  maxBytes: number;
}

/** Build real deps from config. The entrypoint owns these so it can close them. */
export function buildDeps(): AppDeps {
  const config = getConfig();
  return {
    storage: createStorage(config),
    queue: createIngestQueue(config),
    maxBytes: config.UPLOAD_MAX_BYTES,
  };
}

/**
 * Build the Express app. Routes are mounted here so tests can import the app
 * without binding a port. Tenant-scoped routers mount `tenantContext` per-router
 * (issue #9); the auth router is intentionally public (no tenant yet).
 *
 * `deps` is injectable so tests supply fakes; omit it and real deps are built
 * from config (which also makes config a boot-time requirement).
 */
export function createApp(deps: AppDeps = buildDeps()): Express {
  const app = express();

  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'asab-api' });
  });

  // Public: signup / login mint the JWT that protected routes require.
  app.use(authRouter());

  // Protected: upload guarded by tenantContext (tenant from the verified JWT).
  app.use(documentsRouter(deps, tenantContext));

  return app;
}
