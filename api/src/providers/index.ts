import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { Chat, Embedder, Reranker } from '@asab/shared';
import type { Config } from '../config.js';
import { OpenAIEmbedder, type OpenAIEmbeddingsClient } from './openai-embedder.js';
import { ClaudeChat, type AnthropicMessagesClient } from './claude-chat.js';
import { IdentityReranker } from './identity-reranker.js';

/** The AI provider set, resolved from config and injected where needed. */
export interface Providers {
  embedder: Embedder;
  chat: Chat;
  reranker: Reranker;
}

// Native width of text-embedding-3-small AND the chunk.embedding column
// (vector(1536)). If EMBEDDING_MODEL changes, this must change too — and the
// corpus must be re-embedded (vector width is fixed). Single source of truth.
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Build the concrete providers selected by config. The single place vendor SDKs
 * are constructed — everything downstream depends only on the @asab/shared
 * interfaces, so swapping a provider is a change here alone.
 *
 * Call ONCE at boot: each SDK client owns a connection pool, so this is a
 * singleton factory, not a per-request one.
 *
 * The `as unknown as` casts narrow the full SDK clients to the minimal
 * structural slices each impl actually uses (see their *Client interfaces).
 * Deferred (tracked): partial-batch embed resilience -> ingestion worker (#12/#16);
 * per-tenant/per-call model override; Cohere reranker -> #46.
 */
export function createProviders(config: Config): Providers {
  const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY }) as unknown as OpenAIEmbeddingsClient;
  const anthropic = new Anthropic({
    apiKey: config.ANTHROPIC_API_KEY,
  }) as unknown as AnthropicMessagesClient;

  return {
    embedder: new OpenAIEmbedder(openai, config.EMBEDDING_MODEL, EMBEDDING_DIMENSIONS),
    chat: new ClaudeChat(anthropic, config.CHAT_MODEL),
    reranker: new IdentityReranker(), // Cohere reranker -> issue #46
  };
}

export * from './openai-embedder.js';
export * from './claude-chat.js';
export * from './identity-reranker.js';
