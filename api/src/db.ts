import { PrismaClient, type Prisma } from '@prisma/client';

/**
 * Prisma client singleton. A single instance owns the connection pool — import
 * this everywhere rather than constructing new clients.
 *
 * The `globalForPrisma` guard prevents `tsx watch` (dev hot-reload) from leaking
 * a new client + pool on every file change.
 *
 * Tenant isolation note: the bare client sets NO tenant context, so under RLS
 * (issue #8) it sees zero tenant rows (fail-closed). Run every tenant-scoped
 * query through `withTenant()` below, which opens a transaction and sets
 * `app.tenant_id` for that transaction only. Vector reads/writes on
 * `chunk.embedding` use raw SQL since it's an Unsupported column.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ log: ['warn', 'error'] });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` inside a transaction scoped to one tenant. Sets `app.tenant_id` with
 * `set_config(..., is_local => true)` so it lives only for this transaction and
 * never leaks to the next request on the same pooled connection — then Postgres
 * RLS (issue #8) restricts every query in `fn` to that tenant's rows.
 *
 * `tenantId` MUST come from a verified token (see tenantContext middleware),
 * never from client input. We re-validate it's a uuid here as a chokepoint: a
 * malformed value would otherwise abort the query on `''::uuid` / cast errors.
 */
export function withTenant<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new Error('withTenant: tenantId must be a uuid from a verified token');
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

/** Drain the connection pool. Call on shutdown so rolling restarts don't leak. */
export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void disconnectDb().finally(() => process.exit(0));
  });
}
