import { getEncoding, type Tiktoken } from 'js-tiktoken';

// cl100k_base is the tokenizer for text-embedding-3-* (our embed model), so token
// counts here match what the embedder will actually bill/limit. Loaded lazily and
// reused (the rank table is non-trivial to build).
let encoder: Tiktoken | undefined;
function enc(): Tiktoken {
  return (encoder ??= getEncoding('cl100k_base'));
}

export function countTokens(text: string): number {
  return enc().encode(text).length;
}

/** The last `n` tokens of `text`, decoded back to a string (for chunk overlap). */
export function takeLastTokens(text: string, n: number): string {
  if (n <= 0) return '';
  const tokens = enc().encode(text);
  if (tokens.length <= n) return text;
  // The slice may start mid-character (a non-ASCII char can span tokens), so
  // decode emits a leading U+FFFD — drop it so the overlap reads cleanly.
  return enc()
    .decode(tokens.slice(tokens.length - n))
    .replace(/^�+/, '');
}
