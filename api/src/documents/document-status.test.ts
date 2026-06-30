import { describe, expect, it } from 'vitest';
import { sanitizeDocumentError, isTerminalStatus, toStatusView } from './document-status.js';

describe('sanitizeDocumentError', () => {
  it('returns null when the document is not FAILED', () => {
    expect(sanitizeDocumentError('some internal error', 'READY')).toBeNull();
    expect(sanitizeDocumentError(null, 'PARSING')).toBeNull();
  });

  it('maps known errors to friendly messages', () => {
    expect(sanitizeDocumentError('no extractable text — scanned', 'FAILED')).toContain('scanned');
    expect(sanitizeDocumentError('no chunkable content in document', 'FAILED')).toContain(
      'No usable content',
    );
  });

  it('never leaks raw internal detail — unknown errors collapse to a generic message', () => {
    const raw = 'NoSuchKey: tenants/abc/def/original at https://minio.internal:9000/asab-uploads';
    const out = sanitizeDocumentError(raw, 'FAILED');
    expect(out).not.toContain('minio.internal');
    expect(out).not.toContain('tenants/');
    expect(out).toBe('Ingestion failed. Please try re-uploading the document.');
  });

  it('gives a generic message when FAILED with no stored error', () => {
    expect(sanitizeDocumentError(null, 'FAILED')).toBe(
      'Ingestion failed. Please try re-uploading the document.',
    );
  });
});

describe('isTerminalStatus', () => {
  it('treats READY and FAILED as terminal', () => {
    expect(isTerminalStatus('READY')).toBe(true);
    expect(isTerminalStatus('FAILED')).toBe(true);
    expect(isTerminalStatus('PARSING')).toBe(false);
    expect(isTerminalStatus('UPLOADED')).toBe(false);
  });
});

describe('toStatusView', () => {
  it('shapes a row + chunk count, sanitizing the error', () => {
    const view = toStatusView(
      {
        id: 'd1',
        title: 'Doc',
        sourceType: 'PDF',
        status: 'READY',
        pageCount: 3,
        warnings: ['page 2: low text (possibly scanned)'],
        error: 'internal noise',
        updatedAt: new Date('2026-06-30T00:00:00Z'),
      },
      7,
    );
    expect(view).toMatchObject({
      id: 'd1',
      status: 'READY',
      pageCount: 3,
      chunkCount: 7,
      error: null, // not FAILED -> no error surfaced
      updatedAt: '2026-06-30T00:00:00.000Z',
    });
    expect(view.warnings).toHaveLength(1);
  });
});
