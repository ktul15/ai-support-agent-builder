import type { Embedder } from '@asab/shared';

/**
 * Minimal structural slice of the OpenAI client we depend on. Lets tests inject
 * a fake without pulling the whole SDK, and keeps this impl swappable.
 */
export interface OpenAIEmbeddingsClient {
  embeddings: {
    create(args: {
      model: string;
      input: string[];
      dimensions?: number;
    }): Promise<{ data: Array<{ index: number; embedding: number[] }> }>;
  };
}

// OpenAI accepts large batches; 96 keeps requests well within limits and memory.
const DEFAULT_BATCH_SIZE = 96;

export class OpenAIEmbedder implements Embedder {
  constructor(
    private readonly client: OpenAIEmbeddingsClient,
    readonly model: string,
    readonly dimensions: number,
    private readonly batchSize: number = DEFAULT_BATCH_SIZE,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const res = await this.client.embeddings.create({
        model: this.model,
        input: batch,
        dimensions: this.dimensions,
      });
      // OpenAI does not guarantee data is returned in input order — sort by index
      // before mapping, or vectors get misattributed to the wrong text.
      const ordered = [...res.data].sort((a, b) => a.index - b.index);
      vectors.push(...ordered.map((d) => d.embedding));
    }
    return vectors;
  }
}
