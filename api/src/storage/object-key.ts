const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A single path segment, ≤128 chars: must START with an alphanumeric/_/- (so
// '.' and '..' are rejected), then [A-Za-z0-9._-]. No '/', no leading dot — so
// no '..' segment and no traversal/cross-prefix escape when a caller names the
// object.
const NAME_RE = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,127}$/;

/**
 * Build the canonical storage key for a tenant's document object:
 *   tenants/{tenantId}/{documentId}/{name}
 *
 * The leading `tenants/{tenantId}/` prefix is what isolates each tenant's blobs.
 * `tenantId` MUST come from the verified JWT (never client input). Both ids are
 * uuid-validated and lowercased (so the same logical id never produces two
 * case-distinct prefixes), and `name` is restricted to one safe segment, so a
 * crafted value can't traverse into another tenant's prefix.
 */
export function tenantObjectKey(tenantId: string, documentId: string, name = 'original'): string {
  const tenant = tenantId.toLowerCase();
  const document = documentId.toLowerCase();
  if (!UUID_RE.test(tenant)) throw new Error('tenantObjectKey: tenantId must be a uuid');
  if (!UUID_RE.test(document)) throw new Error('tenantObjectKey: documentId must be a uuid');
  if (!NAME_RE.test(name)) throw new Error(`tenantObjectKey: illegal object name "${name}"`);
  return `tenants/${tenant}/${document}/${name}`;
}
