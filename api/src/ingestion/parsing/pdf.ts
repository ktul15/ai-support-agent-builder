import type { FormatParseResult, RawBlock } from './types.js';

// A page with fewer than this many extracted characters is treated as low-text
// (likely a scanned image with no text layer) and flagged for review.
const LOW_TEXT_MIN_CHARS = 10;
// Bound work for pathological/huge PDFs (full bomb-guard is deferred to #13's
// follow-up); pages past this are not parsed and the document is flagged.
const MAX_PAGES = 2000;

// Minimal shape of the bits of pdfjs we use (its subpath import isn't strongly
// typed here, so we pin a narrow contract instead of leaking `any`).
interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}
interface PdfPage {
  getTextContent(): Promise<{ items: Array<PdfTextItem | object> }>;
}
interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}
interface PdfModule {
  getDocument(src: { data: Uint8Array; isEvalSupported?: boolean; useSystemFonts?: boolean }): {
    promise: Promise<PdfDocument>;
  };
}

/**
 * PDF: extract text per page (so page numbers anchor citations) via pdfjs.
 * Pages with almost no extractable text are flagged as possibly scanned; a
 * document where every page is low-text is flagged as image-only.
 */
export async function parsePdf(bytes: Buffer): Promise<FormatParseResult> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfModule;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  const blocks: RawBlock[] = [];
  const warnings: string[] = [];
  let lowTextPages = 0;

  const pagesToScan = Math.min(doc.numPages, MAX_PAGES);
  if (doc.numPages > MAX_PAGES) {
    warnings.push(`document has ${doc.numPages} pages; only the first ${MAX_PAGES} were parsed`);
  }

  try {
    for (let page = 1; page <= pagesToScan; page++) {
      const content = await (await doc.getPage(page)).getTextContent();
      // Reconstruct lines from pdfjs items: items already carry their own
      // spacing, so concatenate within a line and break on hasEOL (joining with
      // ' ' would both split words across items and double existing spaces).
      const lines: string[] = [];
      let line = '';
      for (const it of content.items) {
        if (!('str' in it)) continue;
        const item = it as PdfTextItem;
        line += item.str ?? '';
        if (item.hasEOL) {
          lines.push(line);
          line = '';
        }
      }
      if (line) lines.push(line);
      const text = lines
        .map((l) => l.replace(/[ \t]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n')
        .trim();

      if (text.length < LOW_TEXT_MIN_CHARS) {
        lowTextPages++;
        warnings.push(`page ${page}: low text (possibly scanned)`);
        if (!text) continue; // nothing to add for an empty page
      }
      blocks.push({ text, page });
    }
  } finally {
    await doc.destroy();
  }

  if (pagesToScan > 0 && lowTextPages === pagesToScan) {
    warnings.push('all pages are low-text — document may be scanned/image-only');
  }

  return { blocks, pageCount: doc.numPages, warnings };
}
