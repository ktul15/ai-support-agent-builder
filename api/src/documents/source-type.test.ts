import { describe, expect, it } from 'vitest';
import { resolveSourceType } from './source-type.js';

describe('resolveSourceType', () => {
  it('maps allowed extensions (case-insensitive)', () => {
    expect(resolveSourceType('report.pdf')).toBe('PDF');
    expect(resolveSourceType('REPORT.PDF')).toBe('PDF');
    expect(resolveSourceType('contract.docx')).toBe('DOCX');
    expect(resolveSourceType('notes.md')).toBe('MD');
    expect(resolveSourceType('readme.markdown')).toBe('MD');
    expect(resolveSourceType('log.txt')).toBe('TXT');
  });

  it('returns null for disallowed or missing extensions', () => {
    expect(resolveSourceType('malware.exe')).toBeNull();
    expect(resolveSourceType('image.png')).toBeNull();
    expect(resolveSourceType('noextension')).toBeNull();
    expect(resolveSourceType('.pdf'.slice(0, 0))).toBeNull(); // empty
  });
});
