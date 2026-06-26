import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('app', () => {
  it('exposes a health endpoint', async () => {
    const app = createApp();
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
