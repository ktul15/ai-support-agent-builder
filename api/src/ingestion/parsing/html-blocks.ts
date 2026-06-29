import type { RawBlock } from './types.js';

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

function decodeCodePoint(value: number): string {
  return value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '';
}

/** Strip tags, decode named + numeric entities, and collapse whitespace. */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => decodeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => decodeCodePoint(Number(dec)))
    .replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&nbsp;/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Turn flow HTML (as produced by mammoth for DOCX) into ordered blocks:
 * `<h1>`..`<h6>` become heading blocks with their level, `<p>` become
 * paragraphs. Single page (DOCX has no fixed pagination).
 *
 * Regex-based on purpose: the input is mammoth's own well-formed, flat output
 * (no nesting/unclosed tags), so a full HTML parser would be overkill. If the
 * producer ever changes, revisit. No nested quantifiers → no ReDoS.
 */
export function htmlToBlocks(html: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  const re = /<(h[1-6]|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const tag = match[1]!.toLowerCase();
    const text = stripTags(match[2]!);
    if (!text) continue;
    if (tag[0] === 'h') {
      blocks.push({ text, page: 1, heading: true, level: Number(tag[1]) });
    } else {
      blocks.push({ text, page: 1 });
    }
  }
  return blocks;
}
