import { ParseError } from './types.js';

/**
 * Decode the FULL buffer as UTF-8, throwing on any invalid byte. The sniff check
 * only samples the first 8KB, so a file with a clean text head and a binary tail
 * would otherwise be silently mojibaked (U+FFFD) into the corpus — strict
 * decoding here rejects it instead.
 */
export function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ParseError('content is not valid UTF-8 text');
  }
}
