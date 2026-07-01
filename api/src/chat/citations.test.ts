import { describe, expect, it } from 'vitest';
import type { AssembledSource } from './prompt-assembly.js';
import { citedMarkers, buildCitations } from './citations.js';

function source(over: Partial<AssembledSource>): AssembledSource {
  return {
    marker: 1,
    chunkId: 'c',
    documentId: 'd1',
    title: 'Doc',
    page: 1,
    section: 'S',
    charStart: 0,
    charEnd: 10,
    content: 'body text',
    score: 0.9,
    ...over,
  };
}

const sources = [
  source({ marker: 1, documentId: 'da', title: 'Refunds', charStart: 5, charEnd: 20 }),
  source({ marker: 2, documentId: 'db', title: 'Shipping' }),
  source({ marker: 3, documentId: 'dc', title: 'Returns' }),
];

describe('citedMarkers', () => {
  it('extracts the distinct source numbers cited', () => {
    expect(citedMarkers('Refunds take 30 days [1], see also [3].')).toEqual(new Set([1, 3]));
  });
  it('dedupes repeated markers', () => {
    expect(citedMarkers('[2] and again [2]')).toEqual(new Set([2]));
  });
  it('is empty when nothing is cited', () => {
    expect(citedMarkers('no citations here')).toEqual(new Set());
  });
  it('parses adjacent and multi-digit markers, ignores malformed ones', () => {
    // [1][12] adjacent + two-digit; [1a] and [1.5] are not valid markers.
    expect(citedMarkers('see [1][12], not [1a] or [1.5]')).toEqual(new Set([1, 12]));
  });
});

describe('buildCitations', () => {
  it('returns only the sources the answer cited, in marker order', () => {
    const cites = buildCitations('per [3] then [1]', sources);
    expect(cites.map((c) => c.marker)).toEqual([1, 3]); // marker order, not citation order
    expect(cites.map((c) => c.document_id)).toEqual(['da', 'dc']);
  });

  it('maps the full wire shape incl. char offsets and a snippet', () => {
    const [c] = buildCitations('[1]', sources);
    expect(c).toEqual({
      marker: 1,
      document_id: 'da',
      title: 'Refunds',
      page: 1,
      section: 'S',
      char_start: 5,
      char_end: 20,
      snippet: 'body text',
    });
  });

  it('drops a hallucinated marker with no matching source', () => {
    expect(buildCitations('see [9]', sources)).toEqual([]);
  });

  it('returns nothing when the answer cites nothing', () => {
    expect(buildCitations('an uncited answer', sources)).toEqual([]);
  });

  it('truncates the snippet to 300 chars', () => {
    const big = buildCitations('[1]', [source({ marker: 1, content: 'x'.repeat(500) })]);
    expect(big[0]!.snippet.length).toBe(300);
  });
});
