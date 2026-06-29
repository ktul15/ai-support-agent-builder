import { describe, expect, it } from 'vitest';
import type { DocumentStatus } from '@prisma/client';
import {
  runIngestion,
  type DocumentStatusStore,
  type IngestStage,
  type IngestDeps,
} from './pipeline.js';
import { MemoryStorage } from '../storage/memory-storage.js';

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

function deps(store: DocumentStatusStore): IngestDeps {
  return { store, storage: new MemoryStorage() };
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
    // MemoryStorage is empty -> exists() false -> parse throws.
    await expect(runIngestion(JOB, deps(store))).rejects.toThrow('raw object not found');
    expect(store.history).toEqual(['PARSING']);
  });
});
