import type { DocumentStatus, SourceType } from '@prisma/client';

/** The ingestion status shape returned to the admin UI (no internal detail). */
export interface DocumentStatusView {
  id: string;
  title: string;
  sourceType: SourceType;
  status: DocumentStatus;
  pageCount: number | null;
  chunkCount: number;
  warnings: string[];
  /** A user-safe message when FAILED; null otherwise. Never the raw error. */
  error: string | null;
  updatedAt: string;
}

// Map known internal error text to a readable, leak-free message. The raw error
// (which can carry storage keys, hostnames, or signed-URL fragments from S3 /
// provider failures) is NEVER returned to a client.
const FRIENDLY_ERRORS: { match: string; message: string }[] = [
  {
    match: 'no extractable text',
    message: 'No readable text was found — the document may be scanned or image-only.',
  },
  { match: 'no chunkable content', message: 'No usable content was found in the document.' },
  { match: 'does not match declared type', message: "The file's contents did not match its type." },
  { match: 'not valid utf-8', message: 'The file is not valid UTF-8 text.' },
];

const GENERIC_ERROR = 'Ingestion failed. Please try re-uploading the document.';

/** Sanitize a stored document error into a user-safe message (null unless FAILED). */
export function sanitizeDocumentError(raw: string | null, status: DocumentStatus): string | null {
  if (status !== 'FAILED') return null;
  if (!raw) return GENERIC_ERROR;
  const lower = raw.toLowerCase();
  for (const { match, message } of FRIENDLY_ERRORS) {
    if (lower.includes(match)) return message;
  }
  return GENERIC_ERROR;
}

interface DocumentRow {
  id: string;
  title: string;
  sourceType: SourceType;
  status: DocumentStatus;
  pageCount: number | null;
  warnings: string[];
  error: string | null;
  updatedAt: Date;
}

/** Build the client-facing status view from a document row + its chunk count. */
export function toStatusView(doc: DocumentRow, chunkCount: number): DocumentStatusView {
  return {
    id: doc.id,
    title: doc.title,
    sourceType: doc.sourceType,
    status: doc.status,
    pageCount: doc.pageCount,
    chunkCount,
    warnings: doc.warnings,
    error: sanitizeDocumentError(doc.error, doc.status),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** Terminal statuses end a progress stream. */
export function isTerminalStatus(status: DocumentStatus): boolean {
  return status === 'READY' || status === 'FAILED';
}
