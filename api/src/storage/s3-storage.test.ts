import { describe, expect, it } from 'vitest';
import { S3Storage } from './s3-storage.js';

// getSignedUrl computes the URL locally (no network), so this is a pure unit
// test of the signing path. The full round-trip is in scripts/verify-storage.ts.
describe('S3Storage.signedReadUrl', () => {
  const storage = new S3Storage({
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    bucket: 'asab-uploads',
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
  });

  it('signs a URL targeting the bucket + key with the requested expiry', async () => {
    const url = await storage.signedReadUrl('tenants/t/d/original', 120);
    expect(url).toContain('asab-uploads');
    expect(url).toContain('tenants/t/d/original');
    expect(url).toMatch(/X-Amz-Signature=/);
    expect(url).toContain('X-Amz-Expires=120');
  });

  it('clamps an over-long expiry to the maximum (900s)', async () => {
    const url = await storage.signedReadUrl('k', 999_999);
    expect(url).toContain('X-Amz-Expires=900');
  });

  it('floors a non-positive expiry to at least 1s', async () => {
    const url = await storage.signedReadUrl('k', 0);
    expect(url).toContain('X-Amz-Expires=1');
  });
});
