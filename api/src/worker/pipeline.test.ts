import { describe, expect, it } from 'vitest';
import type { DocumentStatus } from '@prisma/client';
import {
  runIngestion,
  type DocumentStatusStore,
  type IngestStage,
  type IngestDeps,
} from './pipeline.js';
import { MemoryStorage } from '../storage/memory-storage.js';
import { FakeEmbedder } from '../providers/fake-embedder.js';

// Real uuids so the default parse stage's tenantObjectKey() validation passes
// and the storage existence check is what actually fails.
const JOB = {
  documentId: '11111111-1111-1111-1111-111111111111',
  tenantId: '22222222-2222-2222-2222-222222222222',
  assistantId: '33333333-3333-3333-3333-333333333333',
};

class FakeStore implements DocumentStatusStore {
  history: DocumentStatus[] = [];
  constructor(private status: DocumentStatus | null) {}
  getStatus(): Promise<DocumentStatus | null> {
    return Promise.resolve(this.status);
  }
  setStatus(_d: string, _t: string, status: DocumentStatus): Promise<void> {
    this.status = status;
    this.history.push(status);
    return Promise.resolve();
  }
  markFailed(_d: string, _t: string): Promise<void> {
    // Guarded in the real store; the pipeline never calls this (the worker does).
    if (this.status !== 'READY') {
      this.status = 'FAILED';
      this.history.push('FAILED');
    }
    return Promise.resolve();
  }
  getRef(): Promise<{ storageKey: string; sourceType: 'TXT' }> {
    return Promise.resolve({ storageKey: 'some-key', sourceType: 'TXT' });
  }
  setParseResult(): Promise<void> {
    return Promise.resolve();
  }
  saveChunks(
    _d: string,
    _t: string,
    _a: string,
    chunks: unknown[],
  ): Promise<{ inserted: number; total: number }> {
    return Promise.resolve({ inserted: chunks.length, total: chunks.length });
  }
  pending: { id: string; content: string }[] = [];
  embedded: { id: string; vector: number[] }[] = [];
  getUnembeddedChunks(): Promise<{ id: string; content: string }[]> {
    return Promise.resolve(this.pending);
  }
  embeddingModel: string | null = null;
  ensureEmbeddingModel(_t: string, _a: string, model: string): Promise<void> {
    if (this.embeddingModel === null) this.embeddingModel = model;
    else if (this.embeddingModel !== model) {
      return Promise.reject(
        new Error(`ensureEmbeddingModel: mismatch ${this.embeddingModel} vs ${model}`),
      );
    }
    return Promise.resolve();
  }
  embedBatches = 0;
  setChunkEmbeddings(
    _t: string,
    _d: string,
    updates: { id: string; vector: number[] }[],
  ): Promise<void> {
    this.embedBatches++;
    this.embedded.push(...updates);
    this.pending = this.pending.filter((p) => !updates.some((u) => u.id === p.id));
    return Promise.resolve();
  }
}

// Two spy stages mirroring the real shape (PARSING then EMBEDDING).
function spyStages(ran: string[], failOn?: string): IngestStage[] {
  return [
    {
      name: 'a',
      startStatus: 'PARSING',
      run: () => {
        ran.push('a');
        if (failOn === 'a') return Promise.reject(new Error('boom a'));
        return Promise.resolve();
      },
    },
    {
      name: 'b',
      startStatus: 'EMBEDDING',
      run: () => {
        ran.push('b');
        return Promise.resolve();
      },
    },
  ];
}

function deps(store: DocumentStatusStore, embedder = new FakeEmbedder()): IngestDeps {
  return { store, storage: new MemoryStorage(), embedder };
}

describe('runIngestion', () => {
  it('runs all stages in order from UPLOADED and ends READY', async () => {
    const store = new FakeStore('UPLOADED');
    const ran: string[] = [];
    await runIngestion(JOB, deps(store), spyStages(ran));
    expect(ran).toEqual(['a', 'b']);
    expect(store.history).toEqual(['PARSING', 'EMBEDDING', 'READY']);
  });

  it('is idempotent: a READY document re-runs nothing', async () => {
    const store = new FakeStore('READY');
    const ran: string[] = [];
    await runIngestion(JOB, deps(store), spyStages(ran));
    expect(ran).toEqual([]);
    expect(store.history).toEqual([]);
  });

  it('resumes from EMBEDDING (only the last stage runs)', async () => {
    const store = new FakeStore('EMBEDDING');
    const ran: string[] = [];
    await runIngestion(JOB, deps(store), spyStages(ran));
    expect(ran).toEqual(['b']);
    expect(store.history).toEqual(['READY']);
  });

  it('re-runs the unfinished stage when crashed mid-PARSING', async () => {
    const store = new FakeStore('PARSING');
    const ran: string[] = [];
    await runIngestion(JOB, deps(store), spyStages(ran));
    expect(ran).toEqual(['a', 'b']);
    expect(store.history).toEqual(['EMBEDDING', 'READY']);
  });

  it('leaves the partial status in place when a stage throws', async () => {
    const store = new FakeStore('UPLOADED');
    const ran: string[] = [];
    await expect(runIngestion(JOB, deps(store), spyStages(ran, 'a'))).rejects.toThrow('boom a');
    expect(ran).toEqual(['a']);
    expect(store.history).toEqual(['PARSING']); // never advanced to EMBEDDING/READY
  });

  it('throws when the document does not exist', async () => {
    const store = new FakeStore(null);
    await expect(runIngestion(JOB, deps(store), spyStages([]))).rejects.toThrow(
      'document not found',
    );
  });

  it('default parse stage fails when the raw object is missing', async () => {
    const store = new FakeStore('UPLOADED');
    // MemoryStorage is empty -> storage.get rejects -> parse throws.
    await expect(runIngestion(JOB, deps(store))).rejects.toThrow('object not found');
    expect(store.history).toEqual(['PARSING']);
  });

  it('default parse stage fails a document with no extractable text', async () => {
    const store = new FakeStore('UPLOADED');
    const storage = new MemoryStorage();
    // FakeStore.getRef reports a TXT object; store whitespace-only content there.
    await storage.put({ key: 'some-key', body: Buffer.from('   \n  '), contentType: 'text/plain' });
    await expect(
      runIngestion(JOB, { store, storage, embedder: new FakeEmbedder() }),
    ).rejects.toThrow('no extractable text');
    expect(store.history).toEqual(['PARSING']);
  });

  // Start at EMBEDDING so the default parse stage is skipped and the real embed
  // stage runs against the FakeStore's pending chunks.
  it('embed stage embeds pending chunks and writes 1536-dim vectors', async () => {
    const store = new FakeStore('EMBEDDING');
    store.pending = [
      { id: 'c1', content: 'first chunk' },
      { id: 'c2', content: 'second chunk' },
    ];
    await runIngestion(JOB, deps(store));
    expect(store.embedded.map((e) => e.id)).toEqual(['c1', 'c2']);
    expect(store.embedded[0]!.vector.length).toBe(1536);
    expect(store.history).toEqual(['READY']);
  });

  it('embed stage persists (and heartbeats) per batch of 128', async () => {
    const store = new FakeStore('EMBEDDING');
    store.pending = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, content: `chunk ${i}` }));
    await runIngestion(JOB, deps(store));
    expect(store.embedded).toHaveLength(200);
    expect(store.embedBatches).toBe(2); // 128 + 72 -> two setChunkEmbeddings calls
  });

  it('embed stage is a no-op when nothing is pending', async () => {
    const store = new FakeStore('EMBEDDING'); // pending defaults to []
    await runIngestion(JOB, deps(store));
    expect(store.embedded).toEqual([]);
    expect(store.history).toEqual(['READY']);
  });

  it('embed stage fails on an embedder dimension mismatch', async () => {
    const store = new FakeStore('EMBEDDING');
    store.pending = [{ id: 'c1', content: 'x' }];
    await expect(runIngestion(JOB, deps(store, new FakeEmbedder(10)))).rejects.toThrow(
      'dimensions',
    );
    expect(store.embedded).toEqual([]);
  });

  it('embed stage refuses to mix embedding models on one corpus (invariant #4)', async () => {
    const store = new FakeStore('EMBEDDING');
    store.pending = [{ id: 'c1', content: 'x' }];
    store.embeddingModel = 'a-different-model'; // corpus already claimed by another model
    await expect(runIngestion(JOB, deps(store))).rejects.toThrow('mismatch');
    expect(store.embedded).toEqual([]); // nothing embedded — failed before spending calls
  });

  it('embed stage rejects a non-finite embedding value', async () => {
    const store = new FakeStore('EMBEDDING');
    store.pending = [{ id: 'c1', content: 'x' }];
    const nanEmbedder = {
      model: 'nan',
      dimensions: 1536,
      embed: (texts: string[]): Promise<number[][]> =>
        Promise.resolve(
          texts.map(() => {
            const v = new Array<number>(1536).fill(0.1);
            v[0] = NaN;
            return v;
          }),
        ),
    };
    await expect(runIngestion(JOB, deps(store, nanEmbedder))).rejects.toThrow('non-finite');
    expect(store.embedded).toEqual([]);
  });
});
