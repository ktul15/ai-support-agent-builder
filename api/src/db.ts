import { PrismaClient } from '@prisma/client';

/**
 * Prisma client singleton. A single instance owns the connection pool — import
 * this everywhere rather than constructing new clients.
 *
 * The `globalForPrisma` guard prevents `tsx watch` (dev hot-reload) from leaking
 * a new client + pool on every file change.
 *
 * Tenant isolation note: the typed client does NOT set a tenant context. Once
 * RLS lands (issue #8), all tenant-scoped queries must run inside a transaction
 * that first runs `SET LOCAL app.tenant_id` (tenant middleware, issue #9). It
 * MUST be `SET LOCAL` (transaction-scoped) — a plain `SET` would leak tenant
 * context to the next request sharing the pooled connection. Vector reads/writes
 * on `chunk.embedding` use raw SQL since it's an Unsupported column.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ log: ['warn', 'error'] });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
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
