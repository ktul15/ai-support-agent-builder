import type { AnchoredBlock, ParsedDocument } from '../parsing/index.js';
import { type ChunkDraft, type ChunkOptions, DEFAULT_CHUNK_OPTIONS } from './types.js';
import { countTokens, takeLastTokens } from './tokenizer.js';

interface HeadingRef {
  level: number;
  text: string;
}

function sectionPath(stack: HeadingRef[]): string | null {
  return stack.length ? stack.map((h) => h.text).join(' > ') : null;
}

function contextHeader(section: string | null): string {
  return section ? `[Section: ${section}]\n\n` : '';
}

/** Pop headings at the same or deeper level, then push the new one. */
function updateHeadings(stack: HeadingRef[], level: number, text: string): void {
  while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
  stack.push({ level, text });
}

/**
 * Split an oversized paragraph into sub-blocks no larger than maxTokens, on
 * sentence boundaries, preserving char offsets (slices of the original block, so
 * the offset->text invariant still holds). A lone sentence over the limit is
 * emitted whole rather than cut mid-word.
 */
function splitOversizedBlock(block: AnchoredBlock, maxTokens: number): AnchoredBlock[] {
  const sentences: { start: number; end: number }[] = [];
  const re = /[.!?]+(?:\s+|$)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(block.text)) !== null) {
    const end = match.index + match[0].length;
    // Guard is defensive: a regex-matched segment always contains a terminator
    // so it can't be whitespace-only today — but keep it so a future regex
    // change can't silently advance `last` past dropped chars (offset safety).
    if (block.text.slice(last, end).trim()) sentences.push({ start: last, end });
    last = end;
  }
  if (last < block.text.length && block.text.slice(last).trim()) {
    sentences.push({ start: last, end: block.text.length });
  }

  const subs: AnchoredBlock[] = [];
  let curStart: number | null = null;
  let curEnd = 0;
  let curTokens = 0;
  const push = (): void => {
    if (curStart === null) return;
    subs.push({
      text: block.text.slice(curStart, curEnd),
      page: block.page,
      charStart: block.charStart + curStart,
      charEnd: block.charStart + curEnd,
    });
    curStart = null;
    curTokens = 0;
  };
  for (const s of sentences) {
    const t = countTokens(block.text.slice(s.start, s.end));
    if (curStart !== null && curTokens + t > maxTokens) push();
    if (curStart === null) curStart = s.start;
    curEnd = s.end;
    curTokens += t;
  }
  push();
  return subs.length ? subs : [block];
}

/**
 * Structure-aware chunking. Accumulates consecutive paragraph blocks up to
 * `maxTokens`, breaks on every heading (so a chunk never straddles a section),
 * prepends a `[Section: ...]` context header, and re-prepends the previous
 * chunk's tail (`overlapTokens`) within the same section for retrieval recall.
 * Each chunk carries page + section + char offsets straight from the parsed
 * blocks, so citations anchor exactly.
 */
export function chunkDocument(
  parsed: ParsedDocument,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): ChunkDraft[] {
  const { maxTokens, overlapTokens } = options;
  const chunks: ChunkDraft[] = [];
  const headings: HeadingRef[] = [];

  let body: AnchoredBlock[] = [];
  let bodyTokens = 0;
  let overlap = '';

  const flush = (): void => {
    if (body.length === 0) return;
    const section = sectionPath(headings);
    const text = body.map((b) => b.text).join('\n\n');
    const prefix = overlap ? `${overlap}\n\n` : '';
    const content = contextHeader(section) + prefix + text;
    chunks.push({
      content,
      text,
      page: body[0]!.page,
      section,
      charStart: body[0]!.charStart,
      charEnd: body[body.length - 1]!.charEnd,
      tokenCount: countTokens(content),
    });
    overlap = takeLastTokens(text, overlapTokens);
    body = [];
    bodyTokens = 0;
  };

  for (const block of parsed.blocks) {
    if (block.heading) {
      flush();
      overlap = ''; // new section — don't bleed the previous section's tail in
      updateHeadings(headings, block.level ?? 1, block.text);
      continue;
    }

    if (block.text.trim() === '') continue; // defensive: never emit an empty body block

    const blockTokens = countTokens(block.text);
    if (blockTokens > maxTokens) {
      flush();
      overlap = '';
      for (const sub of splitOversizedBlock(block, maxTokens)) {
        body = [sub];
        bodyTokens = countTokens(sub.text);
        flush();
      }
      continue;
    }

    if (bodyTokens + blockTokens > maxTokens) flush();
    body.push(block);
    bodyTokens += blockTokens;
  }
  flush();

  return chunks;
}
