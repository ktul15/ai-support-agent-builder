import { describe, expect, it } from 'vitest';
import { hashChunkContent } from './hash.js';

describe('hashChunkContent', () => {
  it('is a deterministic 64-char hex sha256', () => {
    const h = hashChunkContent('the quick brown fox');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashChunkContent('the quick brown fox')).toBe(h);
  });

  it('differs for different content (incl. section-header differences)', () => {
    expect(hashChunkContent('[Section: A]\n\nbody')).not.toBe(
      hashChunkContent('[Section: B]\n\nbody'),
    );
  });
});
