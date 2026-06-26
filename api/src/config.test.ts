import { afterEach, describe, expect, it } from 'vitest';

const validEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/asab',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'x'.repeat(32),
  ANTHROPIC_API_KEY: 'sk-ant-test',
  OPENAI_API_KEY: 'sk-openai-test',
} as unknown as NodeJS.ProcessEnv;

// loadConfig is pure; import it directly. getConfig touches process.env + dotenv,
// so it's imported lazily per-test (see below) to control the singleton.
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('parses a valid env and applies defaults', () => {
    const cfg = loadConfig(validEnv);
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.PORT).toBe(3000);
    expect(cfg.EMBEDDING_MODEL).toBe('text-embedding-3-small');
    expect(cfg.COHERE_API_KEY).toBeUndefined();
  });

  it('returns a frozen object (immutable after boot)', () => {
    const cfg = loadConfig(validEnv);
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(() => {
      (cfg as { PORT: number }).PORT = 0;
    }).toThrow();
  });

  it('coerces PORT from string', () => {
    expect(loadConfig({ ...validEnv, PORT: '8080' }).PORT).toBe(8080);
  });

  it('rejects an empty-string PORT (does not fall back to default)', () => {
    expect(() => loadConfig({ ...validEnv, PORT: '' })).toThrow(/PORT/);
  });

  it('rejects a non-integer PORT', () => {
    expect(() => loadConfig({ ...validEnv, PORT: '3000.5' })).toThrow(/PORT/);
  });

  it('rejects a malformed DATABASE_URL', () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: 'not-a-url' })).toThrow(/DATABASE_URL/);
  });

  it('fails fast and names every missing required var in one pass', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/Invalid environment configuration/);
    try {
      loadConfig({} as NodeJS.ProcessEnv);
    } catch (err) {
      const msg = (err as Error).message;
      for (const key of [
        'DATABASE_URL',
        'REDIS_URL',
        'JWT_SECRET',
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
      ]) {
        expect(msg).toContain(key);
      }
      // optional/defaulted vars must not appear as errors
      expect(msg).not.toContain('COHERE_API_KEY');
      expect(msg).not.toContain('EMBEDDING_MODEL');
    }
  });

  it('rejects a too-short JWT_SECRET', () => {
    expect(() => loadConfig({ ...validEnv, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('trims surrounding whitespace from secrets', () => {
    const cfg = loadConfig({ ...validEnv, ANTHROPIC_API_KEY: '  sk-ant-test\n' });
    expect(cfg.ANTHROPIC_API_KEY).toBe('sk-ant-test');
  });
});

describe('getConfig', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('caches and returns the same frozen singleton', async () => {
    Object.assign(process.env, validEnv);
    const { getConfig } = await import('./config.js');
    const first = getConfig();
    const second = getConfig();
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
  });
});
