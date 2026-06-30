/**
 * Whether an embedding error is worth retrying: transient (429 / 5xx / network)
 * yes, permanent (4xx auth/validation) no — re-embedding can't fix a bad key or
 * an invalid request. Shared by the ingestion worker and the retrieval service.
 *
 * Lives in a leaf module with NO provider-SDK imports, so the (latency-sensitive)
 * chat path can reuse it without transitively loading the OpenAI/Anthropic SDKs.
 */
export function isRetryableEmbedError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === undefined) return true;
  return status === 429 || status >= 500;
}
