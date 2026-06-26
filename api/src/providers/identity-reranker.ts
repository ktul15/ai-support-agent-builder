import type { Reranker, RerankResult } from '@asab/shared';

/**
 * Default reranker: a no-op that preserves the retrieval order. Real
 * cross-encoder reranking (Cohere) lands in issue #46; until then the order
 * produced by vector retrieval stands, so this keeps the pipeline complete
 * without a second provider dependency.
 */
export class IdentityReranker implements Reranker {
  readonly model = 'identity';

  async rerank(_query: string, documents: string[], topK?: number): Promise<RerankResult[]> {
    const limit = topK === undefined ? documents.length : Math.min(topK, documents.length);
    // Scores are ORDINAL ONLY (position-normalized, descending) — they preserve
    // input order for uniform sorting but are NOT comparable across calls and
    // must not be used with an absolute relevance threshold.
    return Array.from({ length: limit }, (_, index) => ({
      index,
      score: 1 - index / documents.length,
    }));
  }
}
