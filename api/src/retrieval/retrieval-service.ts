import type { Embedder } from '@asab/shared';
import { isRetryableEmbedError } from '../providers/embed-errors.js';
import { withRetry } from '../util/retry.js';
import { retrieveChunks, type ChunkHit } from './retrieve.js';

/** Default number of candidate chunks to fetch when k isn't specified. */
export const DEFAULT_RETRIEVAL_K = 8;

// Bound the question before embedding: well under the embed model's token limit,
// so an oversized blob is rejected here with a clear error instead of a wasted
// provider round-trip + opaque 400.
export const MAX_QUESTION_LENGTH = 4000;

export interface RetrievalQuery {
  assistantId: string;
  question: string;
  /** Number of candidates to return (defaults to DEFAULT_RETRIEVAL_K). */
  k?: number;
}

export interface RetrievalService {
  retrieve(tenantId: string, query: RetrievalQuery): Promise<ChunkHit[]>;
}

/**
 * Embed the user's question and fetch the top-k matching chunks. The embedder is
 * injected — and is the SAME one that embedded the corpus — so query and corpus
 * share the model and vector space (invariant #4; retrieveChunks also pins the
 * dimension). The chat path (#22/#23) calls this.
 */
export function createRetrievalService(embedder: Embedder): RetrievalService {
  return {
    async retrieve(tenantId, query) {
      const question = query.question.trim();
      if (!question) throw new Error('retrieve: question is required');
      if (question.length > MAX_QUESTION_LENGTH) {
        throw new Error(`retrieve: question exceeds ${MAX_QUESTION_LENGTH} characters`);
      }

      const [embedding] = await withRetry(() => embedder.embed([question]), {
        attempts: 3,
        baseDelayMs: 200,
        shouldRetry: isRetryableEmbedError,
      });
      if (!embedding) throw new Error('retrieve: embedder returned no vector');

      return retrieveChunks(tenantId, {
        assistantId: query.assistantId,
        queryEmbedding: embedding,
        embeddingModel: embedder.model,
        k: query.k ?? DEFAULT_RETRIEVAL_K,
      });
    },
  };
}
