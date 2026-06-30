import { withTenant } from '../db.js';
import { EMBEDDING_DIMENSIONS } from '../providers/index.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_K = 100;
// Candidate pool the HNSW scan considers; with iterative scan it grows until k
// rows pass the (tenant, assistant) filter, so a small tenant still gets k hits.
const HNSW_EF_SEARCH = 100;
// Pin the iterative-scan ceiling (default 20000): a sparse tenant whose chunks
// sit far from the query in the global ordering needs a higher cap to still
// collect k filtered rows. Raised, not unbounded, to keep worst-case latency sane.
const HNSW_MAX_SCAN_TUPLES = 40000;

export interface ChunkHit {
  id: string;
  content: string;
  documentId: string;
  page: number | null;
  section: string | null;
  /** Cosine similarity in [-1, 1] (1 = identical). */
  score: number;
}

export interface RetrieveParams {
  assistantId: string;
  /** Query vector — MUST be from the same embedding model as the corpus. */
  queryEmbedding: number[];
  k: number;
}

/**
 * Tenant-filtered cosine ANN over an assistant's chunks. Runs under withTenant
 * so RLS already constrains tenant_id; we ALSO filter (tenant_id, assistant_id)
 * explicitly and use pgvector's iterative scan so the filter is honored DURING
 * the index scan (invariant #2: filter before the vector scan — a small tenant
 * never returns fewer than k hits because the filter dropped the global
 * neighbours). Uses the partial HNSW index (WHERE embedding IS NOT NULL).
 */
export async function retrieveChunks(
  tenantId: string,
  params: RetrieveParams,
): Promise<ChunkHit[]> {
  if (!UUID_RE.test(params.assistantId)) {
    throw new Error('retrieveChunks: assistantId must be a uuid');
  }
  if (params.queryEmbedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `retrieveChunks: query embedding has ${params.queryEmbedding.length} dims, expected ${EMBEDDING_DIMENSIONS}`,
    );
  }
  if (!params.queryEmbedding.every((v) => Number.isFinite(v))) {
    throw new Error('retrieveChunks: query embedding contains a non-finite value');
  }
  // Reject a zero-magnitude vector: cosine distance is undefined for it (pgvector
  // returns NaN), which would garble both the scores and the ORDER BY.
  if (!params.queryEmbedding.some((v) => v !== 0)) {
    throw new Error('retrieveChunks: query embedding is all zeros (no direction)');
  }
  if (!Number.isFinite(params.k)) {
    throw new Error('retrieveChunks: k must be a finite number');
  }
  const k = Math.min(Math.max(Math.floor(params.k), 1), MAX_K);
  // Bound once; bound twice below (SELECT score + ORDER BY). The ~20KB literal is
  // dwarfed by the ANN cost, so the double-bind isn't worth a CTE refactor.
  const vector = `[${params.queryEmbedding.join(',')}]`;

  return withTenant(tenantId, async (tx) => {
    // strict_order: iterative scan returns rows in exact distance order, so the
    // SQL LIMIT k is the true top-k of the filtered set (transaction-local).
    await tx.$executeRaw`SELECT set_config('hnsw.iterative_scan', 'strict_order', true)`;
    await tx.$executeRaw`SELECT set_config('hnsw.ef_search', ${String(HNSW_EF_SEARCH)}, true)`;
    await tx.$executeRaw`SELECT set_config('hnsw.max_scan_tuples', ${String(HNSW_MAX_SCAN_TUPLES)}, true)`;
    return tx.$queryRaw<ChunkHit[]>`
      SELECT id,
             content,
             document_id AS "documentId",
             page,
             section,
             1 - (embedding <=> ${vector}::vector) AS score
      FROM chunk
      WHERE tenant_id = ${tenantId}::uuid
        AND assistant_id = ${params.assistantId}::uuid
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vector}::vector
      LIMIT ${k}`;
  });
}
