import express, { type Express, type Request, type Response } from 'express';

/**
 * Build the Express app. Routes are mounted here so tests can import the app
 * without binding a port. Real middleware (auth, tenant context, rate limit)
 * arrives in Phase 1/2; this is the scaffold (issue #2).
 */
export function createApp(): Express {
  const app = express();

  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'asab-api' });
  });

  return app;
}
