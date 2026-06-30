/**
 * Placeholder grounding system prompt. Issue #26 owns the real contract
 * (answer-only-from-sources, cite-every-claim, the EXACT refusal string, no
 * outside knowledge). #23 just needs *a* system prompt to wire the stream; an
 * assistant's own `systemPrompt` overrides this when set.
 */
export const DEFAULT_GROUNDING_PROMPT =
  'You are a customer support assistant. Answer ONLY using the numbered sources ' +
  'provided in the user message. After each claim, cite the source it came from ' +
  'like [1]. If the sources do not contain the answer, say you do not know rather ' +
  'than guessing.';
