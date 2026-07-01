import { describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from './app.js';
import { MemoryStorage } from './storage/memory-storage.js';

// Fake deps so createApp doesn't reach for config / Redis / S3 in unit tests.
// Everything past storage/queue is inert — the /health test never routes to the
// chat/document handlers — but AppDeps requires them, so supply fakes (rather
// than lie with a partial cast that tsc can't catch in test files).
const testDeps: AppDeps = {
  storage: new MemoryStorage(),
  queue: { enqueue: () => Promise.resolve(), close: () => Promise.resolve() },
  maxBytes: 1024 * 1024,
  retrieval: { retrieve: () => Promise.resolve([]) },
  generation: {
    stream: async function* () {
      /* no events */
    },
  },
  rateLimiter: { consume: () => Promise.resolve({ allowed: true, retryAfterSec: 0 }) },
  limits: { contextTokenBudget: 2000, maxOutputTokens: 2048 },
};

describe('app', () => {
  it('exposes a health endpoint', async () => {
    const app = createApp(testDeps);
    // Bind to an ephemeral port, hit /health, assert the contract.
    const server = app.listen(0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok', service: 'asab-api' });
    } finally {
      server.close();
    }
  });
});
