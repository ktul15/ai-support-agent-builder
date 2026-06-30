/**
 * Swappable object-storage abstraction. Feature code depends on this interface,
 * never on a concrete S3/R2 client — so the backend (R2, S3, MinIO, in-memory)
 * can change without touching callers. Mirrors the AI provider pattern.
 *
 * Reads are ALWAYS via short-lived signed URLs (the bucket is private); we never
 * hand out a public object URL.
 */
export interface PutObjectInput {
  key: string;
  body: Buffer | Uint8Array;
  contentType: string;
}

export interface ObjectStorage {
  /** Upload (or overwrite) an object at `key`. */
  put(input: PutObjectInput): Promise<void>;
  /** Download an object's full bytes (worker-side). Rejects if absent. */
  get(key: string): Promise<Buffer>;
  /** A time-limited signed GET URL for `key` (the only way to read). */
  signedReadUrl(key: string, expiresInSeconds?: number): Promise<string>;
  /** Whether an object exists at `key`. */
  exists(key: string): Promise<boolean>;
  /** Remove the object at `key` (no-op if absent). */
  delete(key: string): Promise<void>;
}

/** Default signed-URL lifetime: short, since URLs are minted on demand per read. */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;

/**
 * Hard upper bound on a signed-URL lifetime. Reads are the security boundary, so
 * a URL must never be long-lived: if one leaks (logs, history, a shared link) it
 * stays readable until expiry with no revocation. Callers can't exceed this.
 */
export const MAX_SIGNED_URL_TTL_SECONDS = 900;
