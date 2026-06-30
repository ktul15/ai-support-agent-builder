import { describe, expect, it } from 'vitest';
import { retrieveChunks } from './retrieve.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const ASSISTANT = '22222222-2222-2222-2222-222222222222';
const goodVector = new Array<number>(1536).fill(0.1);

// These reject in validation BEFORE any DB access, so they run without infra.
describe('retrieveChunks validation', () => {
  it('rejects a non-uuid assistantId', async () => {
    await expect(
      retrieveChunks(TENANT, { assistantId: 'nope', queryEmbedding: goodVector, k: 5 }),
    ).rejects.toThrow('uuid');
  });

  it('rejects a wrong-dimension query embedding', async () => {
    await expect(
      retrieveChunks(TENANT, { assistantId: ASSISTANT, queryEmbedding: [1, 2, 3], k: 5 }),
    ).rejects.toThrow('dims');
  });

  it('rejects a non-finite query embedding value', async () => {
    const bad = [...goodVector];
    bad[0] = NaN;
    await expect(
      retrieveChunks(TENANT, { assistantId: ASSISTANT, queryEmbedding: bad, k: 5 }),
    ).rejects.toThrow('non-finite');
  });

  it('rejects an all-zeros query embedding (no direction for cosine)', async () => {
    const zeros = new Array<number>(1536).fill(0);
    await expect(
      retrieveChunks(TENANT, { assistantId: ASSISTANT, queryEmbedding: zeros, k: 5 }),
    ).rejects.toThrow('all zeros');
  });

  it('rejects a non-finite k', async () => {
    await expect(
      retrieveChunks(TENANT, { assistantId: ASSISTANT, queryEmbedding: goodVector, k: NaN }),
    ).rejects.toThrow('finite');
  });
});
