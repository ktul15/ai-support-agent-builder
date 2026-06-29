import express, { type Express, type Request, type Response } from 'express';
import { authRouter } from './routes/auth.js';

/**
 * Build the Express app. Routes are mounted here so tests can import the app
 * without binding a port. Tenant-scoped routers mount `tenantContext` per-router
 * (issue #9); the auth router below is intentionally public (no tenant yet).
 */
export function createApp(): Express {
  const app = express();

  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'asab-api' });
  });

  // Public: signup / login mint the JWT that protected routes require.
  app.use(authRouter());

  return app;
}
