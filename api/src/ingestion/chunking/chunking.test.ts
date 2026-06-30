import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseDocument, type ParsedDocument } from '../parsing/index.js';
import { chunkDocument, countTokens, DEFAULT_CHUNK_OPTIONS } from './index.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures');
const fixture = (name: string): Buffer => readFileSync(resolve(FIXTURES, name));

async function largeChunks() {
  return chunkDocument(await parseDocument(fixture('largedoc.md'), 'MD'));
}

describe('chunkDocument', () => {
  it('splits a large document into multiple chunks with body within maxTokens', async () => {
    const parsed = await parseDocument(fixture('largedoc.md'), 'MD');
    const chunks = chunkDocument(parsed);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      // Body is gated on a SUM of per-block token counts; the joined text can run
      // a few separator-tokens over maxTokens (see ChunkOptions.maxTokens).
      expect(countTokens(c.text)).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxTokens + 20);
      expect(c.tokenCount).toBeGreaterThan(0);
    }
  });

  it('keeps char offsets that index back to the document text', async () => {
    const parsed = await parseDocument(fixture('largedoc.md'), 'MD');
    const chunks = chunkDocument(parsed);
    for (const c of chunks) {
      expect(parsed.text.slice(c.charStart, c.charEnd)).toBe(c.text);
    }
  });

  it('breaks on headings — sections reflect the heading path', async () => {
    const sections = new Set((await largeChunks()).map((c) => c.section));
    expect(sections.has('Refund Policy')).toBe(true);
    expect(sections.has('Refund Policy > Eligibility Criteria')).toBe(true);
    expect(sections.has('Shipping Policy > International Orders')).toBe(true);
  });

  it('prepends a [Section: ...] context header', async () => {
    const chunks = await largeChunks();
    const withSection = chunks.find((c) => c.section)!;
    expect(withSection.content.startsWith(`[Section: ${withSection.section}]`)).toBe(true);
  });

  it('overlaps consecutive chunks within the same section', async () => {
    const chunks = await largeChunks();
    let overlapFound = false;
    for (let i = 1; i < chunks.length; i++) {
      if (chunks[i]!.section === chunks[i - 1]!.section) {
        const prevTail = chunks[i - 1]!.text.slice(-30);
        if (chunks[i]!.content.includes(prevTail)) overlapFound = true;
      }
    }
    expect(overlapFound).toBe(true);
  });

  it('produces more, smaller chunks with a smaller maxTokens', async () => {
    const parsed = await parseDocument(fixture('largedoc.md'), 'MD');
    const few = chunkDocument(parsed, DEFAULT_CHUNK_OPTIONS);
    const many = chunkDocument(parsed, { minTokens: 100, maxTokens: 200, overlapTokens: 20 });
    expect(many.length).toBeGreaterThan(few.length);
    for (const c of many) expect(countTokens(c.text)).toBeLessThanOrEqual(220);
  });

  it('splits an oversized single paragraph and preserves anchors', () => {
    const big = 'This is one sentence of the document. '.repeat(300).trim();
    const parsed: ParsedDocument = {
      text: big,
      pageCount: 1,
      warnings: [],
      blocks: [{ text: big, page: 1, charStart: 0, charEnd: big.length }],
    };
    const chunks = chunkDocument(parsed, { minTokens: 100, maxTokens: 200, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(parsed.text.slice(c.charStart, c.charEnd)).toBe(c.text);
      expect(countTokens(c.text)).toBeLessThanOrEqual(220);
    }
  });

  it('handles a small single-section document', async () => {
    const parsed = await parseDocument(fixture('sample.md'), 'MD');
    const chunks = chunkDocument(parsed);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]!.section).toContain('Refund Policy');
    expect(parsed.text.slice(chunks[0]!.charStart, chunks[0]!.charEnd)).toBe(chunks[0]!.text);
  });
});
