import { describe, it, expect } from 'vitest';
import { createLogger } from './logger.js';
import { UsageMeter } from './usage-meter.js';

describe('createLogger', () => {
  it('emits one JSON line per event with level, time, event, and fields', () => {
    const lines: string[] = [];
    const log = createLogger(
      (l) => lines.push(l),
      () => '2026-07-02T00:00:00.000Z',
    );
    log.info('chat_request', { tenantId: 't1', grounded: true, latencyMs: 42 });
    log.error('boom', { code: 'E' });

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({
      level: 'info',
      time: '2026-07-02T00:00:00.000Z',
      event: 'chat_request',
      tenantId: 't1',
      grounded: true,
      latencyMs: 42,
    });
    expect(JSON.parse(lines[1]!).level).toBe('error');
  });
});

describe('UsageMeter', () => {
  it('accumulates deltas per tenant', () => {
    const m = new UsageMeter();
    m.record('t1', { requests: 1, inputTokens: 100, outputTokens: 20, embeddings: 1 });
    m.record('t1', { requests: 1, outputTokens: 30 });
    m.record('t2', { embeddings: 5 });

    expect(m.forTenant('t1')).toEqual({
      requests: 2,
      inputTokens: 100,
      outputTokens: 50,
      embeddings: 1,
    });
    expect(m.forTenant('t2').embeddings).toBe(5);
  });

  it('returns zeros for an unknown tenant and snapshots all tenants', () => {
    const m = new UsageMeter();
    m.record('t1', { requests: 1 });
    expect(m.forTenant('unknown')).toEqual({
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      embeddings: 0,
    });
    expect(Object.keys(m.snapshot())).toEqual(['t1']);
  });

  it('forTenant returns a copy (no external mutation of internal state)', () => {
    const m = new UsageMeter();
    m.record('t1', { requests: 1 });
    const snap = m.forTenant('t1');
    snap.requests = 999;
    expect(m.forTenant('t1').requests).toBe(1);
  });
});
