import { describe, expect, it } from 'vitest';
import { tenantObjectKey } from './object-key.js';

const T = '11111111-1111-1111-1111-111111111111';
const D = '22222222-2222-2222-2222-222222222222';

describe('tenantObjectKey', () => {
  it('builds the canonical per-tenant key with the default name', () => {
    expect(tenantObjectKey(T, D)).toBe(`tenants/${T}/${D}/original`);
  });

  it('accepts a safe custom object name', () => {
    expect(tenantObjectKey(T, D, 'page-1.txt')).toBe(`tenants/${T}/${D}/page-1.txt`);
  });

  it('rejects a non-uuid tenant id (no path traversal into the prefix)', () => {
    expect(() => tenantObjectKey('../evil', D)).toThrow();
  });

  it('rejects a non-uuid document id', () => {
    expect(() => tenantObjectKey(T, 'not-a-uuid')).toThrow();
  });

  it('rejects traversal or slashes in the object name', () => {
    expect(() => tenantObjectKey(T, D, '../../etc/passwd')).toThrow();
    expect(() => tenantObjectKey(T, D, 'a/b')).toThrow();
  });

  it('rejects pure-dot / leading-dot object names', () => {
    expect(() => tenantObjectKey(T, D, '.')).toThrow();
    expect(() => tenantObjectKey(T, D, '..')).toThrow();
    expect(() => tenantObjectKey(T, D, '.hidden')).toThrow();
  });

  it('lowercases uuids so the key is canonical regardless of input case', () => {
    expect(tenantObjectKey(T.toUpperCase(), D.toUpperCase())).toBe(`tenants/${T}/${D}/original`);
  });
});
