/**
 * Permitted chat models and their per-model API quirks. The model is
 * per-assistant and ultimately tenant-configurable, so generation validates it
 * against this allowlist (F1 — stops a tenant pointing an assistant at an
 * arbitrary/typo/over-expensive model). Per-plan/tier gating is a separate,
 * larger concern (tracked on #53) — this is the defensive backstop.
 */
export const ALLOWED_CHAT_MODELS: ReadonlySet<string> = new Set([
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-fable-5',
]);

export function isAllowedChatModel(model: string): boolean {
  return ALLOWED_CHAT_MODELS.has(model);
}

// These models REJECT temperature/top_p/top_k with a 400 — sending the param at
// all errors the request. Omit sampling params for them (F2).
const NO_SAMPLING_PARAM_MODELS: ReadonlySet<string> = new Set([
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-fable-5',
]);

export function modelSupportsSamplingParams(model: string): boolean {
  return !NO_SAMPLING_PARAM_MODELS.has(model);
}
