/**
 * @asab/shared — cross-workspace types and contracts.
 *
 * This is the home for code shared between the API, the ingestion worker,
 * and (via codegen) the clients: domain types, DTOs, and the swappable AI
 * provider interfaces (`Embedder`, `Chat`, `Reranker`) added in issue #6.
 *
 * Kept intentionally minimal for the monorepo scaffold (issue #2).
 */

export const SHARED_PACKAGE = '@asab/shared';

/** Marker type so downstream packages can depend on a real export today. */
export type TenantId = string & { readonly __brand: 'TenantId' };
