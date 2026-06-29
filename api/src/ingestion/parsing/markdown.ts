import type { FormatParseResult, RawBlock } from './types.js';
import { decodeUtf8 } from './decode.js';

/**
 * Markdown: one page. ATX headings (`#`..`######`) become heading blocks with
 * their level; runs of non-blank lines become paragraph blocks. (A deliberately
 * small structurer — enough for the heading-aware chunking #15 needs, without a
 * full Markdown AST dependency.)
 */
export function parseMarkdown(bytes: Buffer): FormatParseResult {
  const lines = decodeUtf8(bytes).replace(/\r\n?/g, '\n').split('\n');
  const blocks: RawBlock[] = [];
  let buffer: string[] = [];
  let inFence = false;

  const flush = (): void => {
    const text = buffer
      .join(' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
    if (text) blocks.push({ text, page: 1 });
    buffer = [];
  };

  for (const line of lines) {
    // Track fenced code blocks (``` or ~~~) so a '#' inside code isn't a heading.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      buffer.push(line.trim());
      continue;
    }
    const heading = inFence ? null : /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ text: heading[2]!.trim(), page: 1, heading: true, level: heading[1]!.length });
    } else if (!inFence && line.trim() === '') {
      flush();
    } else {
      buffer.push(line.trim());
    }
  }
  flush();

  return { blocks, pageCount: 1, warnings: blocks.length ? [] : ['no text content'] };
}
