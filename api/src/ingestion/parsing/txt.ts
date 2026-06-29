import type { FormatParseResult } from './types.js';
import { decodeUtf8 } from './decode.js';

/** Plain text: one page, paragraphs split on blank lines, whitespace collapsed. */
export function parseTxt(bytes: Buffer): FormatParseResult {
  const text = decodeUtf8(bytes).replace(/\r\n?/g, '\n');
  const blocks = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .map((t) => ({ text: t, page: 1 }));
  return { blocks, pageCount: 1, warnings: blocks.length ? [] : ['no text content'] };
}
