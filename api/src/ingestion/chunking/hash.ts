import { createHash } from 'node:crypto';

/**
 * Stable content hash for a chunk. Hashes the exact `content` that gets embedded
 * (context header + overlap + body), so two chunks dedup only when they would
 * produce the identical embedding. Backs the (tenant, assistant, content_hash)
 * unique constraint, which makes re-ingestion idempotent and skips re-embedding
 * identical chunks.
 */
export function hashChunkContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
