import type { SourceType } from '@prisma/client';

/** True if the bytes look like UTF-8 text (no NUL byte, decodes cleanly). */
export function looksLikeText(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) return false; // a NUL byte means binary
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

/**
 * Magic-byte check that the content matches the declared SourceType (defense in
 * depth: #12 validates only the extension, which is spoofable). A binary renamed
 * `.pdf`, or a PDF mislabeled `.txt`, is rejected here before parsing.
 */
export function contentMatchesType(sourceType: SourceType, bytes: Buffer): boolean {
  switch (sourceType) {
    case 'PDF':
      return bytes.subarray(0, 5).toString('latin1') === '%PDF-';
    case 'DOCX':
      // DOCX is a ZIP (OOXML). Local-file-header / empty-archive / spanned magic.
      return (
        bytes[0] === 0x50 &&
        bytes[1] === 0x4b &&
        (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
      );
    case 'MD':
    case 'TXT':
      return looksLikeText(bytes);
    default:
      return false;
  }
}
