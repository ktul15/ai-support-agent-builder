import { describe, it, expect } from 'vitest';
import { REFUSAL_MESSAGE } from '../chat/refusal.js';
import {
  isRefusal,
  factMatches,
  scoreInCorpus,
  scoreOffCorpus,
  computeMetrics,
  type InCorpusResult,
  type OffCorpusResult,
} from './scoring.js';
import type { InCorpusCase, OffCorpusCase } from './eval-set.js';

const inCase: InCorpusCase = {
  id: 'ic-01',
  question: 'How much is Standard?',
  expectedFacts: ['$24', 'Standard'],
  expectedDocs: ['plans-and-pricing.md'],
  tags: [],
};
const offCase: OffCorpusCase = { id: 'oc-01', question: 'weather?', reason: 'x', tags: [] };

describe('isRefusal', () => {
  it('matches the exact canonical string, trimmed', () => {
    expect(isRefusal(`  ${REFUSAL_MESSAGE}\n`)).toBe(true);
    expect(isRefusal('The Standard plan is $24.')).toBe(false);
  });
});

describe('factMatches', () => {
  it('matches a fact as a case-insensitive substring', () => {
    expect(factMatches('The STANDARD plan is $24/mo', '$24')).toBe(true);
    expect(factMatches('Beans from Ethiopia and Colombia', 'ethiopia')).toBe(true);
  });

  it('does not let a digit-edged fact glue onto another digit', () => {
    expect(factMatches('Shipping is $50 flat', '$5')).toBe(false); // not $50
    expect(factMatches('Shipping is $5 flat', '$5')).toBe(true);
    expect(factMatches('You get two 12 oz bags', '2')).toBe(false); // not inside 12
    expect(factMatches('You get 2 bags', '2')).toBe(true);
    expect(factMatches('Delivery in 30 days', '3')).toBe(false); // not inside 30
  });

  it('still matches multi-token facts with a leading digit', () => {
    expect(factMatches('two 12 oz bags per month', '12 oz')).toBe(true);
    expect(factMatches('save 15% annually', '15%')).toBe(true);
  });
});

describe('scoreInCorpus', () => {
  it('passes when all facts match (case-insensitive) and a citation is correct', () => {
    const r = scoreInCorpus(inCase, {
      answer: 'The standard plan costs $24 per month.',
      grounded: true,
      citations: [{ title: 'plans-and-pricing.md' }],
    });
    expect(r).toEqual({ id: 'ic-01', answered: true, factsMatched: true, citationCorrect: true });
  });

  it('fails facts when one is missing, and citation when the doc is wrong', () => {
    const r = scoreInCorpus(inCase, {
      answer: 'The standard plan is cheap.', // no $24
      grounded: true,
      citations: [{ title: 'faq.md' }],
    });
    expect(r.factsMatched).toBe(false);
    expect(r.citationCorrect).toBe(false);
  });

  it('counts a refusal as not answered (and never facts/citation matched)', () => {
    const r = scoreInCorpus(inCase, {
      answer: REFUSAL_MESSAGE,
      grounded: false,
      citations: [],
    });
    expect(r).toEqual({
      id: 'ic-01',
      answered: false,
      factsMatched: false,
      citationCorrect: false,
    });
  });
});

describe('scoreOffCorpus', () => {
  it('is refused only when the answer is the canonical refusal', () => {
    expect(
      scoreOffCorpus(offCase, { answer: REFUSAL_MESSAGE, grounded: false, citations: [] }).refused,
    ).toBe(true);
    expect(
      scoreOffCorpus(offCase, { answer: 'It is sunny.', grounded: false, citations: [] }).refused,
    ).toBe(false);
  });
});

describe('computeMetrics', () => {
  it('computes accuracy and refusal precision/recall', () => {
    const inRes: InCorpusResult[] = [
      { id: 'a', answered: true, factsMatched: true, citationCorrect: true },
      { id: 'b', answered: true, factsMatched: false, citationCorrect: true },
      { id: 'c', answered: false, factsMatched: false, citationCorrect: false }, // false refusal
      { id: 'd', answered: true, factsMatched: true, citationCorrect: false },
    ];
    const offRes: OffCorpusResult[] = [
      { id: 'x', refused: true },
      { id: 'y', refused: true },
      { id: 'z', refused: false }, // missed refusal
    ];
    const m = computeMetrics(inRes, offRes);
    expect(m.inCorpus).toBe(4);
    expect(m.offCorpus).toBe(3);
    expect(m.answerAccuracy).toBe(0.5); // 2/4
    expect(m.citationAccuracy).toBe(0.5); // 2/4 (all in-corpus)
    expect(m.citationPrecisionAnswered).toBeCloseTo(2 / 3); // 2 correct of 3 answered
    expect(m.falseRefusals).toBe(1);
    expect(m.refusalPrecision).toBeCloseTo(2 / 3); // 2 true / (2 true + 1 false refusal)
    expect(m.refusalRecall).toBeCloseTo(2 / 3); // 2 refused / 3 off-corpus
  });

  it('precision is 1 when nothing is refused', () => {
    const m = computeMetrics(
      [{ id: 'a', answered: true, factsMatched: true, citationCorrect: true }],
      [{ id: 'x', refused: false }],
    );
    expect(m.refusalPrecision).toBe(1);
    expect(m.refusalRecall).toBe(0);
  });
});
