import type { DocumentStatus, SourceType } from '@prisma/client';
import type { IngestJobData } from '../queue/index.js';
import type { ObjectStorage } from '../storage/index.js';
import { parseDocument, ParseError } from '../ingestion/parsing/index.js';

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
}

export interface IngestDeps {
  store: DocumentStatusStore;
  storage: ObjectStorage;
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
    // #15 (chunk) consumes `parsed` here.
  },
};

const embedStage: IngestStage = {
  name: 'embed',
  startStatus: 'EMBEDDING',
  run() {
    // #16 (dedup) + #17 (embedding) land here. Skeleton no-op.
    return Promise.resolve();
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
