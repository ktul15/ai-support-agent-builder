import { describe, expect, it } from 'vitest';
import { statusLabel, isTerminalStatus, stepIndex, INGEST_STEPS } from './documents.js';

describe('ingest status helpers', () => {
  it('labels each known status and passes through unknown', () => {
    expect(statusLabel('PARSING')).toBe('Parsing…');
    expect(statusLabel('READY')).toBe('Ready');
    expect(statusLabel('WEIRD')).toBe('WEIRD');
  });

  it('treats only READY/FAILED as terminal', () => {
    expect(isTerminalStatus('READY')).toBe(true);
    expect(isTerminalStatus('FAILED')).toBe(true);
    expect(isTerminalStatus('EMBEDDING')).toBe(false);
    expect(isTerminalStatus('UPLOADED')).toBe(false);
  });

  it('orders happy-path steps and returns -1 off-path', () => {
    expect(stepIndex('UPLOADED')).toBe(0);
    expect(stepIndex('READY')).toBe(INGEST_STEPS.length - 1);
    expect(stepIndex('FAILED')).toBe(-1);
    expect(stepIndex('nope')).toBe(-1);
  });
});
