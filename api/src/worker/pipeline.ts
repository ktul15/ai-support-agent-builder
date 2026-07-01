import type { DocumentStatus, SourceType } from '@prisma/client';
import type { Embedder } from '@asab/shared';
import type { IngestJobData } from '../queue/index.js';
import type { ObjectStorage } from '../storage/index.js';
import { parseDocument, ParseError } from '../ingestion/parsing/index.js';
import { chunkDocument, type ChunkDraft } from '../ingestion/chunking/index.js';
import { EMBEDDING_DIMENSIONS, isRetryableEmbedError } from '../providers/index.js';
import { withRetry } from '../util/retry.js';

// Embed in batches so a transient failure re-does only one batch (not the whole
// document) and persisted batches survive a resume. The Embedder also batches
// internally; this is the retry/persist granularity.
const EMBED_BATCH_SIZE = 128;

/** Where a document's raw bytes live and how to parse them. */
export interface DocumentRef {
  storageKey: string;
  sourceType: SourceType;
}

/** Minimal port the pipeline needs to read/advance a document's lifecycle. */
export interface DocumentStatusStore {
  getStatus(documentId: string, tenantId: string): Promise<DocumentStatus | null>;
  setStatus(documentId: string, tenantId: string, status: DocumentStatus): Promise<void>;
  /**
   * Mark FAILED without clobbering a document that already reached READY (a
   * stalled-duplicate or late retry must not flip a completed doc back to
   * FAILED). Implementations guard on `status != READY`.
   */
  markFailed(documentId: string, tenantId: string, error: string): Promise<void>;
  /** Storage location + format for the parse stage (null if not visible). */
  getRef(documentId: string, tenantId: string): Promise<DocumentRef | null>;
  /** Record the parse result: page count + any non-fatal warnings. */
  setParseResult(
    documentId: string,
    tenantId: string,
    result: { pageCount: number; warnings: string[] },
  ): Promise<void>;
  /**
   * Persist a document's chunks, deduped on (tenant, assistant, content_hash):
   * an identical chunk already present (same doc on retry, or shared content) is
   * skipped, not duplicated or re-embedded. Returns how many were newly inserted.
   */
  saveChunks(
    documentId: string,
    tenantId: string,
    assistantId: string,
    chunks: ChunkDraft[],
  ): Promise<{ inserted: number; total: number }>;
  /**
   * Claim the assistant's embedding model on first ingest (invariant #4). Sets
   * assistant.embedding_model if unset; throws if it's already set to a
   * different model — the corpus can't mix vector spaces. Idempotent when equal.
   */
  ensureEmbeddingModel(tenantId: string, assistantId: string, model: string): Promise<void>;
  /** Chunks of a document still needing an embedding (embedding IS NULL). */
  getUnembeddedChunks(
    documentId: string,
    tenantId: string,
  ): Promise<{ id: string; content: string }[]>;
  /**
   * Write embedding vectors onto the given chunks (raw SQL — Unsupported column)
   * AND bump the document's updated_at, so the reconciler treats a long-running
   * embed as live (it heartbeats per batch) rather than stuck.
   */
  setChunkEmbeddings(
    tenantId: string,
    documentId: string,
    updates: { id: string; vector: number[] }[],
  ): Promise<void>;
}

export interface IngestDeps {
  store: DocumentStatusStore;
  storage: ObjectStorage;
  embedder: Embedder;
}

export interface IngestStage {
  name: string;
  /** Status set while this stage runs (and the resume checkpoint marker). */
  startStatus: DocumentStatus;
  run(job: IngestJobData, deps: IngestDeps): Promise<void>;
}

// Linear lifecycle the pipeline advances through. QUEUED/FAILED rank as 0 so a
// brand-new or retried-after-failure document restarts from the beginning.
const ORDER: DocumentStatus[] = ['UPLOADED', 'PARSING', 'EMBEDDING', 'READY'];
function rank(status: DocumentStatus): number {
  const i = ORDER.indexOf(status);
  return i < 0 ? 0 : i;
}

const parseStage: IngestStage = {
  name: 'parse',
  startStatus: 'PARSING',
  async run(job, deps) {
    const ref = await deps.store.getRef(job.documentId, job.tenantId);
    if (!ref) throw new Error(`document not found: ${job.documentId}`);
    // Download the raw bytes (rejects if the object is missing) and parse them.
    // parseDocument validates the content matches the declared type, so a
    // spoofed/corrupt file fails here and the document ends FAILED.
    const bytes = await deps.storage.get(ref.storageKey);
    const parsed = await parseDocument(bytes, ref.sourceType);
    // No extractable text (e.g. a scanned/image-only PDF) is a failure, not a
    // silently-READY empty document the assistant can never answer from.
    if (parsed.text.trim().length === 0) {
      throw new ParseError('no extractable text — document may be scanned or image-only');
    }
    await deps.store.setParseResult(job.documentId, job.tenantId, {
      pageCount: parsed.pageCount,
      warnings: parsed.warnings,
    });

    // Structure-aware chunking, then persist deduped on content_hash. #17 embeds
    // the rows whose embedding is still NULL.
    const chunks = chunkDocument(parsed);
    // A document with text but no chunkable body (e.g. headings only) has nothing
    // to retrieve — fail it rather than let it reach READY empty.
    if (chunks.length === 0) {
      throw new ParseError('no chunkable content in document');
    }
    const { inserted, total } = await deps.store.saveChunks(
      job.documentId,
      job.tenantId,
      job.assistantId,
      chunks,
    );
    console.log(
      `document ${job.documentId}: ${parsed.pageCount} page(s), ${total} chunk(s), ${inserted} new`,
    );
  },
};

const embedStage: IngestStage = {
  name: 'embed',
  startStatus: 'EMBEDDING',
  async run(job, deps) {
    if (deps.embedder.dimensions !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `embedder dimensions ${deps.embedder.dimensions} != column width ${EMBEDDING_DIMENSIONS}`,
      );
    }
    // Only embed chunks that don't have a vector yet — so a retry/resume embeds
    // just the remainder, and re-running a fully-embedded doc is a no-op.
    const pending = await deps.store.getUnembeddedChunks(job.documentId, job.tenantId);
    if (pending.length === 0) return;

    // Claim/verify the corpus embedding model BEFORE spending embed calls, so a
    // model change without re-embedding fails this document loudly (invariant #4).
    await deps.store.ensureEmbeddingModel(job.tenantId, job.assistantId, deps.embedder.model);

    for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
      const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
      const vectors = await withRetry(() => deps.embedder.embed(batch.map((c) => c.content)), {
        attempts: 4,
        baseDelayMs: 500,
        shouldRetry: isRetryableEmbedError,
      });
      if (vectors.length !== batch.length) {
        throw new Error(`embedder returned ${vectors.length} vectors for ${batch.length} chunks`);
      }

      const updates = batch.map((chunk, j) => {
        const vector = vectors[j]!;
        if (vector.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(`embedding has ${vector.length} dims, expected ${EMBEDDING_DIMENSIONS}`);
        }
        if (!vector.every((v) => Number.isFinite(v))) {
          throw new Error('embedding contains a non-finite value');
        }
        return { id: chunk.id, vector };
      });
      // Persist each batch as it completes (also heartbeats the document), so a
      // later failure resumes from the remainder and the reconciler doesn't fail
      // a long-running embed mid-flight.
      await deps.store.setChunkEmbeddings(job.tenantId, job.documentId, updates);
    }
  },
};

export const DEFAULT_STAGES: IngestStage[] = [parseStage, embedStage];

/**
 * Run the ingestion pipeline for one document. Idempotent and resumable: the
 * document's status is the checkpoint, so a retried job skips stages already
 * finished and re-runs only the unfinished one. A stage that throws leaves the
 * partial status in place so the next attempt resumes from there; the worker
 * only marks FAILED once retries are exhausted.
 *
 * CONCURRENCY CONTRACT: status is a read-once-then-write checkpoint with no row
 * lock, so it is NOT a mutual-exclusion mechanism. With worker concurrency > 1,
 * two executions of the SAME document can overlap (e.g. a stage that blocks past
 * BullMQ's lockDuration is re-delivered). Therefore stages MUST be idempotent
 * (content_hash dedup, upserts) and SHOULD be short / renew the lock — this is
 * the downstream issues' (#14-#17) responsibility. The skeleton provides no
 * second line of defense at the status layer.
 */
export async function runIngestion(
  job: IngestJobData,
  deps: IngestDeps,
  stages: IngestStage[] = DEFAULT_STAGES,
): Promise<void> {
  const current = await deps.store.getStatus(job.documentId, job.tenantId);
  if (current === null) throw new Error(`document not found: ${job.documentId}`);
  let curRank = rank(current);

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]!;
    // The status that means "this stage is finished" is the next stage's start
    // (or READY for the last stage).
    const doneStatus = stages[i + 1]?.startStatus ?? 'READY';
    if (curRank >= rank(doneStatus)) continue; // already finished — skip (resume)

    if (curRank < rank(stage.startStatus)) {
      await deps.store.setStatus(job.documentId, job.tenantId, stage.startStatus);
      curRank = rank(stage.startStatus);
    }
    await stage.run(job, deps);
    await deps.store.setStatus(job.documentId, job.tenantId, doneStatus);
    curRank = rank(doneStatus);
  }

  if (curRank < rank('READY')) {
    await deps.store.setStatus(job.documentId, job.tenantId, 'READY');
  }
}
