import { describe, expect, it } from 'vitest';
import { evaluateThreshold } from './refusal.js';

const hit = (score: number) => ({ score });

describe('evaluateThreshold', () => {
  it('refuses with no_sources when there are no hits', () => {
    expect(evaluateThreshold([], 0.35)).toEqual({
      refuse: true,
      reason: 'no_sources',
      topScore: null,
    });
  });

  it('refuses with below_threshold when the top score is under the bar', () => {
    expect(evaluateThreshold([hit(0.2), hit(0.1)], 0.35)).toEqual({
      refuse: true,
      reason: 'below_threshold',
      topScore: 0.2,
    });
  });

  it('passes when the top score clears the bar', () => {
    expect(evaluateThreshold([hit(0.9), hit(0.4)], 0.35)).toEqual({
      refuse: false,
      reason: null,
      topScore: 0.9,
    });
  });

  it('passes at exactly the threshold (strict < bar)', () => {
    expect(evaluateThreshold([hit(0.35)], 0.35).refuse).toBe(false);
  });

  it('uses only the top (best-first) score, ignoring weaker hits', () => {
    expect(evaluateThreshold([hit(0.9), hit(0.01)], 0.35).refuse).toBe(false);
  });

  it('refuses a non-finite score rather than passing it', () => {
    expect(evaluateThreshold([hit(NaN)], 0.35).reason).toBe('below_threshold');
  });
});
