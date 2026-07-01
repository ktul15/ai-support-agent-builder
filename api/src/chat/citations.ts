import type { AssembledSource } from './prompt-assembly.js';

/**
 * A citation on the final stream event — the wire shape the mobile client maps
 * to a tappable source view. snake_case to match the SSE payload's `latency_ms`
 * and the API spec. Char offsets (from ingestion, carried through #21) anchor
 * the highlight in the original document.
 */
export interface Citation {
  marker: number;
  document_id: string;
  title: string;
  page: number | null;
  section: string | null;
  char_start: number | null;
  char_end: number | null;
  snippet: string;
}

const SNIPPET_MAX = 300;
const MARKER_RE = /\[(\d+)\]/g;

/** The distinct source numbers the answer text cited, e.g. "…[1]…[3]" -> {1,3}. */
export function citedMarkers(answer: string): Set<number> {
  const markers = new Set<number>();
  for (const match of answer.matchAll(MARKER_RE)) {
    markers.add(Number(match[1]));
  }
  return markers;
}

/**
 * Map an answer's citation markers to the assembled sources they reference
 * (#24, invariant #6). Only markers the answer ACTUALLY cited are returned, in
 * marker order; a marker with no matching source (a hallucinated number) is
 * dropped rather than fabricated into a citation.
 */
export function buildCitations(answer: string, sources: readonly AssembledSource[]): Citation[] {
  const cited = citedMarkers(answer);
  return sources
    .filter((s) => cited.has(s.marker))
    .map((s) => ({
      marker: s.marker,
      document_id: s.documentId,
      title: s.title,
      page: s.page,
      section: s.section,
      char_start: s.charStart,
      char_end: s.charEnd,
      snippet: s.content.slice(0, SNIPPET_MAX),
    }));
}
