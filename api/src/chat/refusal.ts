/**
 * The single canonical refusal string (invariant #3: "emit the EXACT refusal
 * string"). Both gates use it: the pre-LLM threshold gate here (#25) and the
 * in-prompt grounding contract (#26) — so a refusal reads identically whether
 * it was caught before or during generation. Change it in ONE place.
 */
export const REFUSAL_MESSAGE =
  "I don't have enough information in the provided sources to answer that.";

export type RefusalReason = 'no_sources' | 'below_threshold';

export interface ThresholdResult {
  refuse: boolean;
  reason: RefusalReason | null;
  /** Top cosine similarity considered, or null when there were no hits. */
  topScore: number | null;
}

/**
 * Pre-LLM threshold gate (#25, invariant #3 gate 1): refuse off-corpus questions
 * BEFORE spending an LLM call. Refuses when there are no hits, or the best hit's
 * similarity is below the assistant's refusal_threshold. `topScore === threshold`
 * passes (the bar is strict `<`). `hits` must be ranked best-first.
 */
export function evaluateThreshold(
  hits: ReadonlyArray<{ score: number }>,
  threshold: number,
): ThresholdResult {
  const top = hits[0];
  if (!top) return { refuse: true, reason: 'no_sources', topScore: null };
  // A non-finite score (shouldn't happen — retrieval rejects zero vectors) is
  // treated as off-corpus rather than silently passing the gate.
  if (!Number.isFinite(top.score) || top.score < threshold) {
    return { refuse: true, reason: 'below_threshold', topScore: top.score };
  }
  return { refuse: false, reason: null, topScore: top.score };
}
