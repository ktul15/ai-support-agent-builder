import type { ChunkHit } from '../retrieval/retrieve.js';
import { countTokens, truncateToTokens } from '../ingestion/chunking/index.js';

/** A retrieved chunk promoted to a numbered prompt source (marker -> chunk). */
export interface AssembledSource {
  marker: number;
  chunkId: string;
  documentId: string;
  title: string;
  page: number | null;
  section: string | null;
  charStart: number | null;
  charEnd: number | null;
  content: string;
  score: number;
}

export interface AssembledContext {
  /** marker -> source mapping, used by #24 to build the citations payload. */
  sources: AssembledSource[];
  /** The numbered "[n] …" sources block to inject into the grounded prompt. */
  text: string;
  /**
   * Token count of `text` per cl100k_base — an APPROXIMATION of the Claude prompt
   * size (Claude tokenizes differently, ~±20-30%). Fine for sizing the sources
   * block; generation budget/cost accounting (#22/#28) should apply a safety
   * margin or Claude's own token count rather than treat this as exact.
   */
  totalTokens: number;
}

export interface AssembleOptions {
  /** Max numbered sources (acceptance: top-5). */
  maxSources: number;
  /** Hard-ish token budget for the sources block (soft, sum-based). */
  tokenBudget: number;
}

export const DEFAULT_ASSEMBLE_OPTIONS: AssembleOptions = { maxSources: 5, tokenBudget: 2000 };

type SourceHeader = Pick<AssembledSource, 'marker' | 'title' | 'page' | 'section'>;

// title/section are tenant-controlled (and often third-party-authored): collapse
// whitespace and drop quotes so they can't inject a newline + a fake "[n]" marker
// or terminate the quoted field and break the header structure.
function headerField(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/"/g, '').trim();
}

function headerLine(s: SourceHeader): string {
  const loc = [
    s.page != null ? `page ${s.page}` : null,
    s.section ? `section "${headerField(s.section)}"` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return `[${s.marker}] "${headerField(s.title)}"${loc ? ` — ${loc}` : ''}`;
}

// Fence chunk content in a <source> tag so the model treats any "[n]" markers or
// imperatives inside it as DATA, not structure/instructions. Neutralize the
// delimiter in the content so tenant text can't escape the fence (the grounding
// prompt #26 reinforces this boundary).
function fencedContent(content: string): string {
  const safe = content.replace(/<(\/?)source>/gi, '[$1source]');
  return `<source>\n${safe}\n</source>`;
}

function entryText(s: SourceHeader, content: string): string {
  return `${headerLine(s)}\n${fencedContent(content)}`;
}

/**
 * Assemble retrieved chunks into a numbered sources block for the grounded
 * prompt. Deterministic ordering (score desc, then document/offset/id) so the
 * same hits always produce the same prompt; capped at `maxSources` and trimmed
 * to `tokenBudget`. Returns the marker->source mapping for the citations payload
 * (#24); the grounding system prompt + question wrap this (#22/#26).
 */
export function assembleContext(
  hits: ChunkHit[],
  options: AssembleOptions = DEFAULT_ASSEMBLE_OPTIONS,
): AssembledContext {
  const { maxSources, tokenBudget } = options;

  const ordered = [...hits].sort(
    (a, b) =>
      b.score - a.score ||
      a.documentId.localeCompare(b.documentId) ||
      (a.charStart ?? 0) - (b.charStart ?? 0) ||
      a.id.localeCompare(b.id),
  );

  const sources: AssembledSource[] = [];
  let usedTokens = 0;

  for (const hit of ordered) {
    if (sources.length >= maxSources) break;
    const marker = sources.length + 1;
    const head: SourceHeader = { marker, title: hit.title, page: hit.page, section: hit.section };
    let content = hit.content;
    let entryTokens = countTokens(entryText(head, content));

    if (usedTokens + entryTokens > tokenBudget) {
      if (sources.length > 0) break; // budget spent — keep what fits, deterministically
      // First source alone exceeds the budget: include it, truncated to fit.
      const headerTokens = countTokens(entryText(head, ''));
      content = truncateToTokens(hit.content, Math.max(tokenBudget - headerTokens, 1));
      entryTokens = countTokens(entryText(head, content));
    }

    sources.push({
      marker,
      chunkId: hit.id,
      documentId: hit.documentId,
      title: hit.title,
      page: hit.page,
      section: hit.section,
      charStart: hit.charStart,
      charEnd: hit.charEnd,
      content,
      score: hit.score,
    });
    usedTokens += entryTokens;
  }

  const text = sources.map((s) => entryText(s, s.content)).join('\n\n');
  return { sources, text, totalTokens: countTokens(text) };
}
