import { randomUUID } from 'node:crypto';
import type { DocumentStatus } from '@prisma/client';
import { withTenant } from '../db.js';
import { hashChunkContent, type ChunkDraft } from '../ingestion/chunking/index.js';
import type { DocumentRef, DocumentStatusStore } from './pipeline.js';

/**
 * Document status store backed by Prisma, scoped through withTenant so every
 * read/write runs under the document's tenant RLS context — the worker runs
 * outside any request, so it must set the tenant itself (from the job payload).
 */
export class PrismaDocumentStatusStore implements DocumentStatusStore {
  getStatus(documentId: string, tenantId: string): Promise<DocumentStatus | null> {
    return withTenant(tenantId, async (tx) => {
      const doc = await tx.document.findUnique({
        where: { id: documentId },
        select: { status: true },
      });
      return doc?.status ?? null;
    });
  }

  setStatus(documentId: string, tenantId: string, status: DocumentStatus): Promise<void> {
    return withTenant(tenantId, async (tx) => {
      await tx.document.update({ where: { id: documentId }, data: { status, error: null } });
    });
  }

  markFailed(documentId: string, tenantId: string, error: string): Promise<void> {
    return withTenant(tenantId, async (tx) => {
      // updateMany (not update) so the status != READY guard is part of the WHERE:
      // a completed document is never flipped back to FAILED.
      await tx.document.updateMany({
        where: { id: documentId, status: { not: 'READY' } },
        data: { status: 'FAILED', error },
      });
    });
  }

  getRef(documentId: string, tenantId: string): Promise<DocumentRef | null> {
    return withTenant(tenantId, async (tx) => {
      const doc = await tx.document.findUnique({
        where: { id: documentId },
        select: { storageKey: true, sourceType: true },
      });
      return doc ? { storageKey: doc.storageKey, sourceType: doc.sourceType } : null;
    });
  }

  setParseResult(
    documentId: string,
    tenantId: string,
    result: { pageCount: number; warnings: string[] },
  ): Promise<void> {
    return withTenant(tenantId, async (tx) => {
      await tx.document.update({
        where: { id: documentId },
        data: { pageCount: result.pageCount, warnings: result.warnings },
      });
    });
  }

  saveChunks(
    documentId: string,
    tenantId: string,
    assistantId: string,
    chunks: ChunkDraft[],
  ): Promise<{ inserted: number; total: number }> {
    return withTenant(tenantId, async (tx) => {
      const data = chunks.map((c) => ({
        id: randomUUID(),
        tenantId,
        documentId,
        assistantId,
        content: c.content,
        tokenCount: c.tokenCount,
        page: c.page,
        section: c.section,
        charStart: c.charStart,
        charEnd: c.charEnd,
        contentHash: hashChunkContent(c.content),
      }));

      // skipDuplicates => ON CONFLICT DO NOTHING. NOTE: Prisma emits no conflict
      // target, so it swallows conflicts on EVERY unique/PK — fine while the only
      // ones are the PK (fresh uuids, never collide) and (tenant, assistant,
      // content_hash). It dedups within the batch AND against rows from prior
      // runs or other documents, leaving any existing embedding (filled by #17)
      // untouched. embedding is omitted -> NULL. If another unique is ever added
      // to chunk, switch to a targeted upsert so new rows aren't silently dropped.
      //
      // Batch to stay under Postgres's 65535 bind-parameter cap (11 params/chunk);
      // all batches share this one transaction, so the write stays atomic.
      const BATCH_SIZE = 1000;
      let inserted = 0;
      for (let i = 0; i < data.length; i += BATCH_SIZE) {
        const res = await tx.chunk.createMany({
          data: data.slice(i, i + BATCH_SIZE),
          skipDuplicates: true,
        });
        inserted += res.count;
      }
      return { inserted, total: chunks.length };
    });
  }
}
