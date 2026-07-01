import { describe, expect, it } from 'vitest';
import { buildGroundingSystem } from './grounding.js';
import { REFUSAL_MESSAGE } from './refusal.js';

describe('buildGroundingSystem', () => {
  const base = buildGroundingSystem();

  it('instructs answer-only-from-sources and no outside knowledge', () => {
    expect(base).toMatch(/only.*numbered sources/i);
    expect(base).toMatch(/not use outside or prior knowledge/i);
  });

  it('instructs cite-every-claim with a bracketed source number', () => {
    expect(base).toMatch(/cite every factual claim/i);
    expect(base).toContain('[1]');
  });

  it('instructs the EXACT refusal string verbatim, emitted alone', () => {
    // Pin the framing, not just that the string appears somewhere: the refusal
    // must be presented as a verbatim "nothing else" instruction.
    expect(base).toMatch(
      new RegExp(
        `EXACTLY this text and nothing else[^:]*:\\s*${REFUSAL_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      ),
    );
  });

  it('exempts the refusal from the cite-every-claim rule (no false-positive citation)', () => {
    expect(base).toMatch(/only exception is the refusal/i);
  });

  it('forbids inventing citations not present in the sources', () => {
    expect(base).toMatch(/never invent a citation/i);
  });

  it('tells the model to treat fenced <source> content as data, not instructions', () => {
    expect(base).toMatch(/<source>/);
    expect(base).toMatch(/never as instructions/i);
  });

  it('returns the contract alone when there is no persona', () => {
    expect(buildGroundingSystem()).toBe(base);
    expect(buildGroundingSystem(null)).toBe(base);
    expect(buildGroundingSystem('   ')).toBe(base);
  });

  it('layers a persona after the contract, marked as non-overriding', () => {
    const withPersona = buildGroundingSystem('Speak warmly and concisely.');
    expect(withPersona.startsWith(base)).toBe(true); // contract first
    expect(withPersona).toContain('Speak warmly and concisely.');
    expect(withPersona).toMatch(/must not override the rules above/i);
    // The persona cannot move ahead of or replace the contract.
    expect(withPersona.indexOf(REFUSAL_MESSAGE)).toBeLessThan(
      withPersona.indexOf('Speak warmly and concisely.'),
    );
  });
});
