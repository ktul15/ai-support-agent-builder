import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseDocument } from './index.js';
import { contentMatchesType, looksLikeText } from './sniff.js';
import { parseTxt } from './txt.js';
import { parseMarkdown } from './markdown.js';
import { htmlToBlocks } from './html-blocks.js';
import { assemble } from './assemble.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures');
const fixture = (name: string): Buffer => readFileSync(resolve(FIXTURES, name));

describe('sniff', () => {
  it('detects PDF and DOCX by magic bytes', () => {
    expect(contentMatchesType('PDF', fixture('sample.pdf'))).toBe(true);
    expect(contentMatchesType('DOCX', fixture('sample.docx'))).toBe(true);
  });
  it('accepts UTF-8 text and rejects binary', () => {
    expect(looksLikeText(Buffer.from('hello world'))).toBe(true);
    expect(looksLikeText(Buffer.from([0x00, 0x01, 0x02]))).toBe(false);
  });
  it('rejects content whose bytes do not match the declared type', () => {
    expect(contentMatchesType('PDF', Buffer.from('not a pdf'))).toBe(false);
    expect(contentMatchesType('TXT', fixture('sample.pdf'))).toBe(false); // pdf binary as txt
  });
});

describe('parseTxt / parseMarkdown', () => {
  it('splits text into paragraph blocks', () => {
    const r = parseTxt(Buffer.from('Para one.\n\nPara two.'));
    expect(r.blocks.map((b) => b.text)).toEqual(['Para one.', 'Para two.']);
    expect(r.pageCount).toBe(1);
  });
  it('extracts markdown headings with levels', () => {
    const r = parseMarkdown(Buffer.from('# Title\n\nBody text.\n\n## Sub\n\nMore.'));
    expect(r.blocks[0]).toMatchObject({ text: 'Title', heading: true, level: 1 });
    expect(r.blocks[2]).toMatchObject({ text: 'Sub', heading: true, level: 2 });
  });
});

describe('htmlToBlocks', () => {
  it('maps h1-h6 to heading blocks and p to paragraphs', () => {
    const blocks = htmlToBlocks('<h1>Big</h1><p>para &amp; text</p><h3>Small</h3>');
    expect(blocks[0]).toMatchObject({ text: 'Big', heading: true, level: 1 });
    expect(blocks[1]).toMatchObject({ text: 'para & text' });
    expect(blocks[1].heading).toBeUndefined();
    expect(blocks[2]).toMatchObject({ text: 'Small', heading: true, level: 3 });
  });
});

describe('assemble', () => {
  it('joins blocks and records char offsets that index back to the text', () => {
    const doc = assemble({
      blocks: [
        { text: 'alpha', page: 1 },
        { text: 'beta', page: 1 },
      ],
      pageCount: 1,
      warnings: [],
    });
    expect(doc.text).toBe('alpha\n\nbeta');
    for (const b of doc.blocks) {
      expect(doc.text.slice(b.charStart, b.charEnd)).toBe(b.text);
    }
  });
});

describe('parseDocument (real fixtures)', () => {
  it('parses TXT', async () => {
    const doc = await parseDocument(fixture('sample.txt'), 'TXT');
    expect(doc.text).toContain('Acme Support');
    expect(doc.pageCount).toBe(1);
  });

  it('parses Markdown with heading structure', async () => {
    const doc = await parseDocument(fixture('sample.md'), 'MD');
    expect(doc.blocks.some((b) => b.heading && b.text === 'Refund Policy')).toBe(true);
    expect(doc.blocks.some((b) => b.heading && b.level === 2 && b.text === 'Eligibility')).toBe(
      true,
    );
  });

  it('parses DOCX text', async () => {
    const doc = await parseDocument(fixture('sample.docx'), 'DOCX');
    expect(doc.text).toContain('Employee Handbook');
    expect(doc.text).toContain('Leave Policy');
    expect(doc.pageCount).toBe(1);
  });

  it('parses PDF per page', async () => {
    const doc = await parseDocument(fixture('sample.pdf'), 'PDF');
    expect(doc.text).toContain('Acme Support');
    expect(doc.pageCount).toBe(1);
    expect(doc.warnings).toEqual([]);
  });

  it('flags a low-text / scanned PDF page', async () => {
    const doc = await parseDocument(fixture('lowtext.pdf'), 'PDF');
    expect(doc.warnings.some((w) => w.includes('low text'))).toBe(true);
    expect(doc.warnings.some((w) => w.includes('scanned'))).toBe(true);
  });

  it('rejects a file whose content does not match its declared type', async () => {
    await expect(parseDocument(Buffer.from('plain text, not a pdf'), 'PDF')).rejects.toThrow(
      'does not match',
    );
  });

  it('block offsets index back to the assembled text for every format', async () => {
    for (const [name, type] of [
      ['sample.txt', 'TXT'],
      ['sample.md', 'MD'],
      ['sample.docx', 'DOCX'],
      ['sample.pdf', 'PDF'],
    ] as const) {
      const doc = await parseDocument(fixture(name), type);
      for (const b of doc.blocks) {
        expect(doc.text.slice(b.charStart, b.charEnd)).toBe(b.text);
      }
    }
  });

  it('rejects a text file with a valid head but an invalid-UTF-8 tail', async () => {
    const buf = Buffer.concat([Buffer.from('a'.repeat(9000)), Buffer.from([0xff, 0xfe])]);
    await expect(parseDocument(buf, 'TXT')).rejects.toThrow('UTF-8');
  });
});

describe('markdown / html edge cases', () => {
  it('does not treat a # inside a fenced code block as a heading', () => {
    const r = parseMarkdown(Buffer.from('# Real Heading\n\n```\n# not a heading\n```\n'));
    const headings = r.blocks.filter((b) => b.heading).map((b) => b.text);
    expect(headings).toEqual(['Real Heading']);
  });

  it('decodes numeric HTML entities', () => {
    const blocks = htmlToBlocks('<p>caf&#233; &#x2014; ok</p>');
    expect(blocks[0]!.text).toBe('café — ok');
  });
});
