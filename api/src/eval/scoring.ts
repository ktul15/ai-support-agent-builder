import { REFUSAL_MESSAGE } from '../chat/refusal.js';
import type { InCorpusCase, OffCorpusCase } from './eval-set.js';

/** What the pipeline returned for one question (from the chat `done` event). */
export interface PipelineOutput {
  answer: string;
  grounded: boolean;
  citations: { title: string }[];
  /** A transport / SSE `error` frame occurred — not a real answer or refusal. */
  error?: boolean;
}

/** A refusal is the exact canonical string (invariant #3). */
export function isRefusal(answer: string): boolean {
  return answer.trim() === REFUSAL_MESSAGE;
}

/**
 * Does the answer contain this expected fact? Case-insensitive substring, but a
 * fact whose edge is a digit must not be glued to another digit — so "$5" does
 * not match "$50" and "2" does not match inside "12 oz". Keeps numeric facts
 * discriminating instead of trivially satisfied.
 */
export function factMatches(answer: string, fact: string): boolean {
  const f = fact.trim();
  if (!f) return false;
  const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = /^\d/.test(f) ? '(?<!\\d)' : '';
  const right = /\d$/.test(f) ? '(?!\\d)' : '';
  return new RegExp(`${left}${esc}${right}`, 'i').test(answer);
}

export interface InCorpusResult {
  id: string;
  /** The model answered rather than refused. */
  answered: boolean;
  /** Every expectedFact is a case-insensitive substring of the answer. */
  factsMatched: boolean;
  /** At least one citation points at one of the case's expectedDocs. */
  citationCorrect: boolean;
}

export function scoreInCorpus(c: InCorpusCase, out: PipelineOutput): InCorpusResult {
  const refused = isRefusal(out.answer);
  const factsMatched = !refused && c.expectedFacts.every((f) => factMatches(out.answer, f));
  const expected = new Set(c.expectedDocs);
  const citationCorrect = !refused && out.citations.some((cit) => expected.has(cit.title));
  return { id: c.id, answered: !refused, factsMatched, citationCorrect };
}

export interface OffCorpusResult {
  id: string;
  refused: boolean;
}

export function scoreOffCorpus(c: OffCorpusCase, out: PipelineOutput): OffCorpusResult {
  return { id: c.id, refused: isRefusal(out.answer) };
}

export interface Metrics {
  inCorpus: number;
  offCorpus: number;
  /** Fraction of on-corpus questions whose answer contained all expected facts. */
  answerAccuracy: number;
  /** Fraction of ALL on-corpus questions that cited a correct source. */
  citationAccuracy: number;
  /** Of the on-corpus questions it actually answered, the fraction citing a
   *  correct source (conditional — the metric #41 tunes citation quality on). */
  citationPrecisionAnswered: number;
  /** On-corpus questions the assistant wrongly refused. */
  falseRefusals: number;
  /** Of everything refused, the fraction that SHOULD have been (off-corpus). */
  refusalPrecision: number;
  /** Of all off-corpus questions, the fraction correctly refused. */
  refusalRecall: number;
}

export function computeMetrics(inRes: InCorpusResult[], offRes: OffCorpusResult[]): Metrics {
  const n = inRes.length;
  const m = offRes.length;
  const factsOk = inRes.filter((r) => r.factsMatched).length;
  const citeOk = inRes.filter((r) => r.citationCorrect).length;
  const answered = inRes.filter((r) => r.answered).length;
  const inRefused = inRes.filter((r) => !r.answered).length; // false refusals
  const offRefused = offRes.filter((r) => r.refused).length; // true refusals
  const tp = offRefused;
  const fp = inRefused;
  return {
    inCorpus: n,
    offCorpus: m,
    answerAccuracy: n ? factsOk / n : 0,
    citationAccuracy: n ? citeOk / n : 0,
    citationPrecisionAnswered: answered ? citeOk / answered : 0,
    falseRefusals: inRefused,
    // No refusals at all -> precision is vacuously 1 (nothing wrongly refused).
    refusalPrecision: tp + fp ? tp / (tp + fp) : 1,
    refusalRecall: m ? offRefused / m : 0,
  };
}
