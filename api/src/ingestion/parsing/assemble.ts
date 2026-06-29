import type { AnchoredBlock, FormatParseResult, ParsedDocument } from './types.js';

/**
 * Concatenate parsed blocks into one normalized text (blocks joined by a blank
 * line) and record each block's char offsets into it. These offsets are the
 * anchors citations depend on (invariant #6), so chunking (#15) can carry
 * page/section/char_start/char_end straight through.
 */
export function assemble(result: FormatParseResult): ParsedDocument {
  let text = '';
  const blocks: AnchoredBlock[] = [];
  for (const block of result.blocks) {
    const trimmed = block.text.trim();
    if (!trimmed) continue;
    if (text) text += '\n\n';
    const charStart = text.length;
    text += trimmed;
    blocks.push({ ...block, text: trimmed, charStart, charEnd: text.length });
  }
  return { text, pageCount: result.pageCount, warnings: result.warnings, blocks };
}
