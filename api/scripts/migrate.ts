/**
 * Run Prisma Migrate as the OWNER role.
 *
 * Prisma writes its `_prisma_migrations` history (and applies DDL) through the
 * datasource `url`. The app's `url` is the restricted `asab_app` role, which has
 * no CREATE on the schema (deliberate — issue #8 hardening: forgotten RLS on a
 * future table fails closed instead of leaking). So migrate commands must
 * connect as the owner. This wrapper loads the repo-root `.env` and points
 * DATABASE_URL at DIRECT_DATABASE_URL (owner) before delegating to prisma.
 *
 *   tsx scripts/migrate.ts migrate deploy
 */
import { config } from 'dotenv';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
config({ path: resolve(root, '.env') });

const owner = process.env.DIRECT_DATABASE_URL;
if (!owner) {
  console.error(
    'DIRECT_DATABASE_URL (owner connection) is required to run migrations.\n' +
      'Migrations run as the owner; the app runtime uses the restricted asab_app role.',
  );
  process.exit(1);
}

const res = spawnSync('prisma', process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: owner },
});
process.exit(res.status ?? 1);
