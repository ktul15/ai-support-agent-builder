import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { withTenant } from '../db.js';
import { requireTenant } from '../middleware/tenant-context.js';
import { tenantObjectKey, type ObjectStorage } from '../storage/index.js';
import { resolveSourceType } from '../documents/source-type.js';
import {
  toStatusView,
  sanitizeDocumentError,
  isTerminalStatus,
} from '../documents/document-status.js';
import type { IngestQueue } from '../queue/index.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Fields the status views need (never storage_key / internal columns).
const STATUS_SELECT = {
  id: true,
  title: true,
  sourceType: true,
  status: true,
  pageCount: true,
  warnings: true,
  error: true,
  updatedAt: true,
} as const;

export interface UploadDeps {
  storage: ObjectStorage;
  queue: IngestQueue;
  maxBytes: number;
}

const bodySchema = z.object({ assistantId: z.string().uuid() });

const MAX_TITLE_LENGTH = 255;

/** Raised by the multer fileFilter to reject an unsupported type pre-buffering. */
class UnsupportedTypeError extends Error {}

/** Run multer and translate its errors into clean HTTP responses. */
function runMulter(mw: RequestHandler): RequestHandler {
  return (req, res, next) => {
    mw(req, res, (err: unknown) => {
      if (!err) {
        next();
        return;
      }
      if (err instanceof UnsupportedTypeError) {
        res.status(415).json({ error: 'unsupported file type' });
        return;
      }
      if (err instanceof multer.MulterError) {
        // Only an over-large file is 413; field/part flooding and unexpected
        // files are malformed requests (400).
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        res
          .status(status)
          .json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'file too large' : 'invalid upload' });
        return;
      }
      res.status(400).json({ error: 'invalid upload' });
    });
  };
}

/**
 * Document upload: multipart file -> object storage -> document row (UPLOADED)
 * -> enqueued ingest job. Behind `authMiddleware` (tenantContext): the tenant
 * comes only from the verified JWT, and the assistant must belong to that tenant
 * (checked under RLS) or the upload is rejected before anything is stored.
 */
export function documentsRouter(deps: UploadDeps, authMiddleware: RequestHandler): Router {
  const r = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    // Bound EVERY dimension, not just file size: busboy buffers fields in memory
    // too, so leaving fields/parts at their Infinity defaults lets a tiny file +
    // tens of thousands of text fields OOM the process around the size cap.
    limits: {
      fileSize: deps.maxBytes,
      files: 1,
      fields: 4,
      parts: 6,
      fieldSize: 64 * 1024,
      fieldNameSize: 100,
    },
    // Reject an unsupported type at the part header, BEFORE its bytes are
    // buffered into RAM (cheap rejection; avoids memory amplification).
    fileFilter: (_req, file, cb) => {
      if (resolveSourceType(file.originalname) === null) {
        cb(new UnsupportedTypeError());
        return;
      }
      cb(null, true);
    },
  });

  r.post('/documents', authMiddleware, runMulter(upload.single('file')), (req, res) => {
    const tenant = requireTenant(req);

    const body = bodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'assistantId (uuid) is required' });
      return;
    }
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'file is required' });
      return;
    }
    const sourceType = resolveSourceType(file.originalname);
    if (!sourceType) {
      res.status(415).json({ error: 'unsupported file type' });
      return;
    }

    const { assistantId } = body.data;
    const documentId = randomUUID();
    const storageKey = tenantObjectKey(tenant.tenantId, documentId);

    void (async () => {
      // 1. The assistant must exist within this tenant (RLS-scoped) — verified
      //    BEFORE storing anything, so an invalid target wastes no storage.
      const assistantOk = await withTenant(tenant.tenantId, (tx) =>
        tx.assistant.findUnique({
          where: { id_tenantId: { id: assistantId, tenantId: tenant.tenantId } },
          select: { id: true },
        }),
      );
      if (!assistantOk) {
        res.status(404).json({ error: 'assistant not found' });
        return;
      }

      // 2. Store the raw bytes, then 3. record the row, then 4. enqueue.
      await deps.storage.put({ key: storageKey, body: file.buffer, contentType: file.mimetype });

      await withTenant(tenant.tenantId, (tx) =>
        tx.document.create({
          data: {
            id: documentId,
            tenantId: tenant.tenantId,
            assistantId,
            title: file.originalname.slice(0, MAX_TITLE_LENGTH),
            sourceType,
            storageKey,
            status: 'UPLOADED',
          },
        }),
      );

      await deps.queue.enqueue({ documentId, tenantId: tenant.tenantId, assistantId });

      res.status(201).json({ documentId, status: 'UPLOADED' });
    })().catch((err) => {
      console.error('document upload error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    });
  });

  // List a tenant+assistant's documents with their ingestion status + chunk count.
  r.get('/documents', authMiddleware, (req, res) => {
    const tenant = requireTenant(req);
    const assistantId = z.string().uuid().safeParse(req.query.assistantId);
    if (!assistantId.success) {
      res.status(400).json({ error: 'assistantId (uuid) query param is required' });
      return;
    }
    // Bounded page size so a tenant with very many documents can't return an
    // unbounded payload (cursor pagination can come later if needed).
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    withTenant(tenant.tenantId, (tx) =>
      tx.document.findMany({
        where: { assistantId: assistantId.data },
        select: { ...STATUS_SELECT, _count: { select: { chunks: true } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
    )
      .then((docs) => res.json({ documents: docs.map((d) => toStatusView(d, d._count.chunks)) }))
      .catch((err) => {
        console.error('list documents error:', err);
        res.status(500).json({ error: 'internal error' });
      });
  });

  // Single document's current ingestion status.
  r.get('/documents/:id', authMiddleware, (req, res) => {
    const tenant = requireTenant(req);
    const id = req.params.id;
    if (!id || !UUID_RE.test(id)) {
      res.status(400).json({ error: 'invalid document id' });
      return;
    }
    withTenant(tenant.tenantId, async (tx) => {
      const doc = await tx.document.findUnique({ where: { id }, select: STATUS_SELECT });
      if (!doc) return null;
      const chunkCount = await tx.chunk.count({ where: { documentId: id } });
      return toStatusView(doc, chunkCount);
    })
      .then((view) =>
        view ? res.json(view) : res.status(404).json({ error: 'document not found' }),
      )
      .catch((err) => {
        console.error('get document error:', err);
        res.status(500).json({ error: 'internal error' });
      });
  });

  // Live ingestion progress over SSE: emits a `status` event whenever the
  // document's status changes, then a `done` event at READY/FAILED. Poll-based
  // (no pub/sub bus); compression is not mounted on this app, so writes flush.
  r.get('/documents/:id/events', authMiddleware, (req, res) => {
    const tenant = requireTenant(req);
    const id = req.params.id;
    if (!id || !UUID_RE.test(id)) {
      res.status(400).json({ error: 'invalid document id' });
      return;
    }

    void (async () => {
      const exists = await withTenant(tenant.tenantId, (tx) =>
        tx.document.findUnique({ where: { id }, select: { id: true } }),
      );
      if (!exists) {
        res.status(404).json({ error: 'document not found' });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();

      let closed = false;
      let ticking = false;
      let lastStatus = '';
      let ticksSinceWrite = 0;

      const end = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        clearTimeout(maxTimer);
        res.end();
      };
      const safeWrite = (chunk: string): void => {
        if (!closed) res.write(chunk);
      };

      const interval = setInterval(() => void tick(), 1000);
      // Hard cap: emit a terminal `timeout` event so the client knows the stream
      // ended without a result (and can re-poll) rather than dropping silently.
      const maxTimer = setTimeout(
        () => {
          safeWrite(`event: timeout\ndata: {}\n\n`);
          end();
        },
        5 * 60 * 1000,
      );
      req.on('close', end);
      res.on('error', end); // a socket reset racing a write shouldn't go unhandled

      const tick = async (): Promise<void> => {
        if (closed || ticking) return; // don't stack overlapping DB queries
        ticking = true;
        try {
          const snap = await withTenant(tenant.tenantId, async (tx) => {
            const doc = await tx.document.findUnique({
              where: { id },
              select: { status: true, pageCount: true, warnings: true, error: true },
            });
            if (!doc) return null;
            const chunkCount = await tx.chunk.count({ where: { documentId: id } });
            return { doc, chunkCount };
          });
          if (closed) return;
          if (!snap) {
            safeWrite(`event: error\ndata: ${JSON.stringify({ error: 'document not found' })}\n\n`);
            end();
            return;
          }
          if (snap.doc.status !== lastStatus) {
            lastStatus = snap.doc.status;
            ticksSinceWrite = 0;
            safeWrite(
              `event: status\ndata: ${JSON.stringify({
                status: snap.doc.status,
                pageCount: snap.doc.pageCount,
                chunkCount: snap.chunkCount,
                warnings: snap.doc.warnings,
                error: sanitizeDocumentError(snap.doc.error, snap.doc.status),
              })}\n\n`,
            );
            if (isTerminalStatus(snap.doc.status)) {
              safeWrite(`event: done\ndata: {}\n\n`);
              end();
            }
          } else if (++ticksSinceWrite % 15 === 0) {
            safeWrite(`:\n\n`); // keep-alive comment so idle streams aren't dropped
          }
        } catch (err) {
          console.error('document events error:', err);
          end();
        } finally {
          ticking = false;
        }
      };
      void tick();
    })().catch((err) => {
      console.error('document events setup error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    });
  });

  return r;
}
