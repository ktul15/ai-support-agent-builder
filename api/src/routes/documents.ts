import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { withTenant } from '../db.js';
import { requireTenant } from '../middleware/tenant-context.js';
import { tenantObjectKey, type ObjectStorage } from '../storage/index.js';
import { resolveSourceType } from '../documents/source-type.js';
import type { IngestQueue } from '../queue/index.js';

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

  return r;
}
