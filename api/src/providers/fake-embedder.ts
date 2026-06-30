import type { Embedder } from '@asab/shared';

/**
 * Deterministic, offline Embedder for tests and verify scripts — produces a
 * stable vector per text with the real column width, so the embedding pipeline
 * can be proven end-to-end without calling (or paying for) a provider. NOT for
 * production retrieval: the vectors are not semantically meaningful.
 */
export class FakeEmbedder implements Embedder {
  readonly model = 'fake-embedder';
  constructor(readonly dimensions = 1536) {}

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this.vectorFor(t)));
  }

  private vectorFor(text: string): number[] {
    const vec = new Array<number>(this.dimensions);
    for (let i = 0; i < this.dimensions; i++) {
      const code = text.charCodeAt(i % Math.max(text.length, 1)) || 0;
      vec[i] = ((code + i) % 97) / 97; // stable, in [0, 1)
    }
    return vec;
  }
}
