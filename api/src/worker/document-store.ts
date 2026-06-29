import type { DocumentStatus } from '@prisma/client';
import { withTenant } from '../db.js';
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
}
