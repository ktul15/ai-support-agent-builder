/**
 * Swappable AI provider contracts. All feature code depends on these interfaces,
 * never on a vendor SDK directly — so providers can be swapped via config.
 * Concrete implementations live in the API (`api/src/providers`).
 */

// --- Embeddings ---------------------------------------------------------------

export interface Embedder {
  /** Embedding model id (must match what the corpus was embedded with). */
  readonly model: string;
  /**
   * Vector width this embedder produces. Must equal the pgvector column width;
   * changing the model/dimensions means re-embedding the corpus.
   */
  readonly dimensions: number;
  /**
   * Embed a batch of texts. Returns one vector per input, in the same order.
   * Implementations should batch large inputs internally.
   */
  embed(texts: string[]): Promise<number[][]>;
}

// --- Chat (streaming) ---------------------------------------------------------

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  /** System prompt — the grounding contract for RAG answers. */
  system?: string;
  messages: ChatMessage[];
  /**
   * Override the provider's default model (e.g. per-assistant selection).
   * Implementations MUST honor this when set, else per-assistant model
   * selection silently serves the wrong (possibly wrong-cost) model.
   */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Cancels the upstream call when the client disconnects (stops token billing). */
  signal?: AbortSignal;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Why generation stopped. Lets callers tell a complete answer from a truncated/declined one. */
export type ChatStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'refusal' | 'tool_use';

/**
 * One event in a streamed completion: incremental `text`, a terminal `done`, or
 * a terminal `error` (mutually exclusive with `done`). A stream yields exactly
 * one terminal event.
 */
export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; usage?: ChatUsage; stopReason?: ChatStopReason }
  | { type: 'error'; message: string; retryable: boolean };

export interface Chat {
  /** Chat model id. */
  readonly model: string;
  /** Stream a completion token-by-token, ending with a single `done` event. */
  stream(req: ChatRequest): AsyncIterable<ChatStreamEvent>;
}

// --- Reranker -----------------------------------------------------------------

export interface RerankResult {
  /** Index into the original `documents` array. */
  index: number;
  /** Relevance score; results are returned sorted by descending score. */
  score: number;
}

export interface Reranker {
  /** Reranker model id. */
  readonly model: string;
  /**
   * Reorder `documents` by relevance to `query`, most relevant first.
   * Returns at most `topK` results (all if omitted).
   */
  rerank(query: string, documents: string[], topK?: number): Promise<RerankResult[]>;
}
