import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  MAX_SIGNED_URL_TTL_SECONDS,
  type ObjectStorage,
  type PutObjectInput,
} from './storage.js';

export interface S3StorageConfig {
  /** Custom endpoint for S3-compatible stores (R2, MinIO). Omit for AWS S3. */
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Path-style addressing. Defaults to true when a custom `endpoint` is set
   * (MinIO/R2 need it) and false for real AWS S3 (virtual-hosted; path-style is
   * deprecated there and breaks dotted bucket names).
   */
  forcePathStyle?: boolean;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

/** S3-API storage backend. Works against AWS S3, Cloudflare R2, and MinIO. */
export class S3Storage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: S3StorageConfig) {
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle ?? Boolean(cfg.endpoint),
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  async put(input: PutObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        // Force download, never inline-render. Defends against a tenant uploading
        // active content (HTML/SVG) that would otherwise execute as stored XSS on
        // the storage origin when a signed URL is opened in a browser.
        ContentDisposition: 'attachment',
      }),
    );
  }

  async signedReadUrl(
    key: string,
    expiresInSeconds = DEFAULT_SIGNED_URL_TTL_SECONDS,
  ): Promise<string> {
    // Clamp to [1, MAX]: reads are the security boundary, so a caller can never
    // mint a long-lived URL (a leaked one can't be revoked before it expires).
    const ttl = Math.min(Math.max(Math.floor(expiresInSeconds), 1), MAX_SIGNED_URL_TTL_SECONDS);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: ttl,
    });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /**
   * Create the bucket if it doesn't exist. For local/dev (MinIO) only —
   * production buckets are provisioned out-of-band, so this is never on the hot
   * path. Idempotent: an already-owned bucket is treated as success.
   */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') return;
      throw err;
    }
  }
}
