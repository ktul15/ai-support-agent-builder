import mammoth from 'mammoth';
import type { FormatParseResult } from './types.js';
import { htmlToBlocks } from './html-blocks.js';

/**
 * DOCX: convert to HTML via mammoth (which maps Word heading styles to
 * `<h1>`..`<h6>`), then structure it. DOCX has no fixed pagination, so it's
 * treated as a single page.
 */
export async function parseDocx(bytes: Buffer): Promise<FormatParseResult> {
  const { value: html } = await mammoth.convertToHtml({ buffer: bytes });
  const blocks = htmlToBlocks(html);
  return { blocks, pageCount: 1, warnings: blocks.length ? [] : ['no extractable text'] };
}
