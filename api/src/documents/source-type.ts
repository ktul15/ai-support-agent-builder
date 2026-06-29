import type { SourceType } from '@prisma/client';

// Allowlist: only these document types are ingestible. Keyed by lowercased file
// extension — the authoritative signal (a browser-supplied MIME type is easily
// spoofed and inconsistent across clients).
const EXT_TO_SOURCE: Record<string, SourceType> = {
  pdf: 'PDF',
  docx: 'DOCX',
  md: 'MD',
  markdown: 'MD',
  txt: 'TXT',
};

/** Map a filename to its SourceType, or null if the extension isn't allowed. */
export function resolveSourceType(filename: string): SourceType | null {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXT_TO_SOURCE[ext] ?? null;
}
