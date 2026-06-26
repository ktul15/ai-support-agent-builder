import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Typed, validated environment configuration. Fails fast with a single
 * aggregated error listing every missing/invalid var — never half-configured.
 *
 * Secrets live only here (server-side). Vars not yet consumed by a feature are
 * declared optional now and tightened to required in their own issue:
 *   - storage (S3/R2)  -> issue #11
 *   - COHERE_API_KEY   -> reranker, issue #46 (stretch)
 */
const schema = z.object({
  // Core runtime (safe defaults — never block boot)
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Infrastructure (required — fail fast if absent)
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // Auth
  JWT_SECRET: z.string().trim().min(32, 'must be at least 32 characters'),

  // AI providers (server-side only). trim() catches stray newlines/quotes from .env.
  ANTHROPIC_API_KEY: z.string().trim().min(1),
  OPENAI_API_KEY: z.string().trim().min(1),
  COHERE_API_KEY: z.string().trim().min(1).optional(),

  // Model selection (overridable; sensible defaults)
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  CHAT_MODEL: z.string().default('claude-haiku-4-5'),

  // Object storage (optional until the upload pipeline lands)
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
});

export type Config = Readonly<z.infer<typeof schema>>;

/**
 * Validate an env-like record and return a frozen, typed config, or throw a
 * readable, aggregated error. Pure: no side effects, no dotenv — accepts the
 * source so callers and tests stay deterministic.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return Object.freeze(parsed.data);
}

let cached: Config | undefined;

/**
 * Lazily validated singleton for app runtime. Loads `.env` into process.env on
 * first call (no-op if absent; never overrides already-set vars), then validates.
 */
export function getConfig(): Config {
  if (!cached) {
    loadDotenv();
    cached = loadConfig();
  }
  return cached;
}
