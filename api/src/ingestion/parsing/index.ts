import type { SourceType } from '@prisma/client';
import { type ParsedDocument, ParseError } from './types.js';
import { contentMatchesType } from './sniff.js';
import { assemble } from './assemble.js';
import { parseTxt } from './txt.js';
import { parseMarkdown } from './markdown.js';
import { parseDocx } from './docx.js';
import { parsePdf } from './pdf.js';

export type { ParsedDocument, AnchoredBlock, RawBlock } from './types.js';
export { ParseError } from './types.js';
export { contentMatchesType } from './sniff.js';

/**
 * Parse raw document bytes into normalized, structured text. Validates the
 * content matches its declared type first (rejects spoofed extensions), then
 * dispatches to the per-format parser and assembles char-anchored blocks.
 */
export async function parseDocument(
  bytes: Buffer,
  sourceType: SourceType,
): Promise<ParsedDocument> {
  if (!contentMatchesType(sourceType, bytes)) {
    throw new ParseError(`content does not match declared type: ${sourceType}`);
  }

  switch (sourceType) {
    case 'TXT':
      return assemble(parseTxt(bytes));
    case 'MD':
      return assemble(parseMarkdown(bytes));
    case 'DOCX':
      return assemble(await parseDocx(bytes));
    case 'PDF':
      return assemble(await parsePdf(bytes));
    default:
      throw new ParseError(`unsupported source type: ${String(sourceType)}`);
  }
}
