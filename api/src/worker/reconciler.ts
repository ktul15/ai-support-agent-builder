import { prisma } from '../db.js';

/**
 * Mark documents stuck in a non-terminal status (older than `ageSeconds`) as
 * FAILED. Calls the SECURITY DEFINER reconcile_stuck_documents function, which
 * runs as the owner so it can sweep across all tenants. Returns the count fixed.
 */
export async function reconcileStuckDocuments(ageSeconds: number): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT reconcile_stuck_documents(make_interval(secs => ${ageSeconds})) AS n`;
  return rows[0]?.n ?? 0;
}
