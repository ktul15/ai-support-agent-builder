import type { Config } from '../config.js';
import type { ObjectStorage } from './storage.js';
import { S3Storage } from './s3-storage.js';
import { MemoryStorage } from './memory-storage.js';

export { tenantObjectKey } from './object-key.js';
export { DEFAULT_SIGNED_URL_TTL_SECONDS } from './storage.js';
export type { ObjectStorage, PutObjectInput } from './storage.js';
export { S3Storage } from './s3-storage.js';
export { MemoryStorage } from './memory-storage.js';

/**
 * Pick the storage backend from config. If S3/R2 is fully configured, use it;
 * otherwise fall back to non-persistent in-memory storage so local dev and
 * tests run without object storage (with a loud warning — never silent in prod).
 */
export function createStorage(config: Config): ObjectStorage {
  if (
    config.S3_BUCKET &&
    config.S3_REGION &&
    config.S3_ACCESS_KEY_ID &&
    config.S3_SECRET_ACCESS_KEY
  ) {
    return new S3Storage({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET,
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    });
  }
  if (config.NODE_ENV === 'production') {
    throw new Error('Object storage (S3_*) must be configured in production');
  }
  console.warn('[storage] S3 not configured — using non-persistent in-memory storage');
  return new MemoryStorage();
}
