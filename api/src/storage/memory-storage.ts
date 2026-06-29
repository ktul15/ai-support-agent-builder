import {
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  type ObjectStorage,
  type PutObjectInput,
} from './storage.js';

interface StoredObject {
  body: Uint8Array;
  contentType: string;
}

/**
 * Non-persistent in-memory storage for tests and for local dev when no S3/R2 is
 * configured. `signedReadUrl` returns a `memory://` URL (not fetchable) — it
 * exists only to satisfy the interface; real reads go through `get()` in tests.
 */
export class MemoryStorage implements ObjectStorage {
  private readonly store = new Map<string, StoredObject>();

  put(input: PutObjectInput): Promise<void> {
    this.store.set(input.key, {
      // Always copy, so a later mutation of the caller's buffer can't change the
      // stored bytes — matching S3's snapshot-at-put semantics (Buffer is a
      // Uint8Array, so this covers both input types).
      body: new Uint8Array(input.body),
      contentType: input.contentType,
    });
    return Promise.resolve();
  }

  signedReadUrl(key: string, expiresInSeconds = DEFAULT_SIGNED_URL_TTL_SECONDS): Promise<string> {
    return Promise.resolve(`memory://${key}?expires=${expiresInSeconds}`);
  }

  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.store.has(key));
  }

  delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }

  /** Test helper: read back a stored object (no signed-URL round-trip). */
  get(key: string): StoredObject | undefined {
    return this.store.get(key);
  }
}
