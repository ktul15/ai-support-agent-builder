export interface UsageDelta {
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  embeddings?: number;
}

export interface TenantUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  embeddings: number;
}

const zero = (): TenantUsage => ({
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  embeddings: 0,
});

/**
 * Per-tenant usage aggregation (tokens + embeddings + requests). In-process, so
 * a snapshot reflects one server instance — durable, cross-instance metering for
 * billing is #52; this is the shape that feeds it and powers an ops view.
 */
export class UsageMeter {
  private readonly totals = new Map<string, TenantUsage>();

  record(tenantId: string, delta: UsageDelta): void {
    const cur = this.totals.get(tenantId) ?? zero();
    cur.requests += delta.requests ?? 0;
    cur.inputTokens += delta.inputTokens ?? 0;
    cur.outputTokens += delta.outputTokens ?? 0;
    cur.embeddings += delta.embeddings ?? 0;
    this.totals.set(tenantId, cur);
  }

  forTenant(tenantId: string): TenantUsage {
    return { ...(this.totals.get(tenantId) ?? zero()) };
  }

  snapshot(): Record<string, TenantUsage> {
    const out: Record<string, TenantUsage> = {};
    for (const [tenant, usage] of this.totals) out[tenant] = { ...usage };
    return out;
  }

  reset(): void {
    this.totals.clear();
  }
}
