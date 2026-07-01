import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import { FakeEmbedder } from '../providers/fake-embedder.js';

vi.mock('./retrieve.js', () => ({ retrieveChunks: vi.fn() }));
const { retrieveChunks } = await import('./retrieve.js');
const mockRetrieve = retrieveChunks as unknown as Mock;

const { createRetrievalService, DEFAULT_RETRIEVAL_K, MAX_QUESTION_LENGTH } =
  await import('./retrieval-service.js');

const TENANT = '11111111-1111-1111-1111-111111111111';
const ASSISTANT = '22222222-2222-2222-2222-222222222222';

beforeEach(() => mockRetrieve.mockReset());

describe('createRetrievalService', () => {
  it('rejects an empty/whitespace question without touching retrieval', async () => {
    const svc = createRetrievalService(new FakeEmbedder());
    await expect(svc.retrieve(TENANT, { assistantId: ASSISTANT, question: '   ' })).rejects.toThrow(
      'question is required',
    );
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it('embeds the question and delegates with the default k', async () => {
    mockRetrieve.mockResolvedValue([
      { id: 'c1', content: 'x', documentId: 'd', page: 1, section: null, score: 0.9 },
    ]);
    const svc = createRetrievalService(new FakeEmbedder());
    const hits = await svc.retrieve(TENANT, {
      assistantId: ASSISTANT,
      question: 'how do refunds work?',
    });

    expect(hits).toHaveLength(1);
    expect(mockRetrieve).toHaveBeenCalledOnce();
    const [tenantArg, params] = mockRetrieve.mock.calls[0] as [string, Record<string, unknown>];
    expect(tenantArg).toBe(TENANT);
    expect(params.assistantId).toBe(ASSISTANT);
    expect(params.k).toBe(DEFAULT_RETRIEVAL_K);
    expect(params.queryEmbedding).toHaveLength(1536); // embedded by the injected embedder
    // Passes the embedder's model so retrieveChunks can assert corpus == query
    // model (invariant #4).
    expect(params.embeddingModel).toBe('fake-embedder');
  });

  it('rejects an over-long question before embedding', async () => {
    const svc = createRetrievalService(new FakeEmbedder());
    const huge = 'a'.repeat(MAX_QUESTION_LENGTH + 1);
    await expect(svc.retrieve(TENANT, { assistantId: ASSISTANT, question: huge })).rejects.toThrow(
      'exceeds',
    );
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it('passes a configurable k through', async () => {
    mockRetrieve.mockResolvedValue([]);
    const svc = createRetrievalService(new FakeEmbedder());
    await svc.retrieve(TENANT, { assistantId: ASSISTANT, question: 'q', k: 3 });
    const [, params] = mockRetrieve.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.k).toBe(3);
  });
});
