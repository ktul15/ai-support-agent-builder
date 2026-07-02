import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEvalSet, CORPUS_DIR } from './eval-set.js';

// Validates the versioned fixture is well-formed so the #40 harness can trust
// it: enough cases, unique ids, every on-corpus case points at a real doc.
describe('eval set fixture', () => {
  const set = loadEvalSet();

  it('meets the size targets (>=30 on-corpus, >=10 off-corpus)', () => {
    expect(set.inCorpus.length).toBeGreaterThanOrEqual(30);
    expect(set.offCorpus.length).toBeGreaterThanOrEqual(10);
  });

  it('has globally unique case ids', () => {
    const ids = [...set.inCorpus, ...set.offCorpus].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every on-corpus case has a question, facts, and existing non-empty corpus docs', () => {
    for (const c of set.inCorpus) {
      expect(c.question.trim().length, c.id).toBeGreaterThan(0);
      expect(c.expectedFacts.length, c.id).toBeGreaterThan(0);
      expect(
        c.expectedFacts.every((f) => f.trim().length > 0),
        c.id,
      ).toBe(true);
      expect(c.expectedDocs.length, c.id).toBeGreaterThan(0);
      for (const doc of c.expectedDocs) {
        const path = join(CORPUS_DIR, doc);
        expect(existsSync(path), `${c.id} -> ${doc}`).toBe(true);
        expect(readFileSync(path, 'utf8').trim().length, `${c.id} -> ${doc} empty`).toBeGreaterThan(
          0,
        );
      }
    }
  });

  it('every off-corpus case has a question and a reason', () => {
    for (const c of set.offCorpus) {
      expect(c.question.trim().length, c.id).toBeGreaterThan(0);
      expect(c.reason.trim().length, c.id).toBeGreaterThan(0);
    }
  });

  it('on-corpus ids are ic-*, off-corpus ids are oc-*', () => {
    expect(set.inCorpus.every((c) => c.id.startsWith('ic-'))).toBe(true);
    expect(set.offCorpus.every((c) => c.id.startsWith('oc-'))).toBe(true);
  });
});
