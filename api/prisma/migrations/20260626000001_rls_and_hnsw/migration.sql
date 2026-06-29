-- Issue #8 — Row-Level Security + HNSW index.
--
-- RLS only takes effect for NON-superuser, NON-owner roles (superusers and table
-- owners bypass it unless FORCE is set). So the application connects as a
-- dedicated restricted role `asab_app`; migrations keep using the owner
-- (postgres) via Prisma's directUrl. Every tenant query must run inside a
-- transaction that first sets `app.tenant_id` (SET LOCAL / set_config(...,true)).

-- 1. Restricted application role -------------------------------------------------
-- The role is provisioned OUT-OF-BAND, never created here: a literal password in
-- a migration would be replayed to every environment by `prisma migrate deploy`
-- and committed to git history. Local dev creates it via db/init/002-app-role.sh
-- (from $ASAB_APP_PASSWORD) on first DB boot; prod provisions it separately with
-- a real secret. We only fail loudly if it is missing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'asab_app') THEN
    RAISE EXCEPTION 'Role "asab_app" must be provisioned before migrating. '
      'Local: it is created by db/init/002-app-role.sh on first DB boot '
      '(run `npm run db:reset`). Prod: provision it out-of-band with a secret '
      'password (NOSUPERUSER NOBYPASSRLS), then re-run migrations.';
  END IF;
END
$$;

-- Explicit, per-table grants only — NO blanket "ON ALL TABLES" and NO
-- ALTER DEFAULT PRIVILEGES. A future tenant table that someone forgets to grant
-- (and FORCE-RLS) then fails CLOSED with "permission denied" instead of being
-- silently readable across tenants. Each new tenant table must add its own
-- GRANT + RLS policy here (and a cross-tenant=0-rows test).
GRANT USAGE ON SCHEMA public TO asab_app;

-- 2. Enable + FORCE RLS, grant DML, and add tenant-isolation policies ------------
-- NULLIF(current_setting('app.tenant_id', true), '') yields NULL when the GUC is
-- unset OR reset to '' (a custom GUC reverts to '' after a SET LOCAL, not NULL),
-- so an unscoped query matches no rows (fail-closed) instead of erroring on ''::uuid.

-- tenant: a tenant may see only its own row (keyed on id, not tenant_id).
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant" TO asab_app;
ALTER TABLE "tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant"
  USING ("id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- All other tenant tables key on tenant_id.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['app_user','assistant','document','chunk','conversation','message','api_key']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO asab_app', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenant_id" = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END
$$;

-- 3. api_key bootstrap (pre-tenant-context) -------------------------------------
-- Auth resolves the tenant FROM the api key before any tenant context exists, so
-- the RLS policy above would hide the row. This SECURITY DEFINER function runs as
-- the owner (bypasses RLS) and exposes ONLY the key->tenant resolution.
--
-- NOTE: this bypass works because the function's owner (postgres) is a superuser,
-- so it is exempt from FORCE RLS. If the table owner is ever changed to a
-- non-superuser, FORCE RLS would block this lookup and silently break auth —
-- re-grant ownership or add a dedicated bypass policy if that ever changes.
CREATE OR REPLACE FUNCTION auth_resolve_api_key(p_key_hash text)
RETURNS TABLE (api_key_id uuid, tenant_id uuid, assistant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, tenant_id, assistant_id FROM api_key WHERE key_hash = p_key_hash;
$$;

REVOKE ALL ON FUNCTION auth_resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_resolve_api_key(text) TO asab_app;

-- 4. HNSW index for ANN retrieval -----------------------------------------------
-- Partial: chunks are NULL between the chunk and embed stages, so only index
-- embedded rows. Cosine ops to match the retrieval distance operator (<=>).
--
-- LIMITATION (invariant #2 — filter (tenant_id, assistant_id) BEFORE the vector
-- scan): this is a GLOBAL vector index; RLS + assistant_id are applied as POST
-- filters on HNSW candidates. For a small tenant in a large corpus that can drop
-- recall below k (HNSW returns other tenants' neighbours, RLS removes them).
-- Isolation is unaffected (RLS still hides other tenants). When the retrieval
-- query lands (issue #19+), revisit: per-(tenant,assistant) partitioning,
-- raised ef_search, or iterative scan. Tracked on issue #8.
CREATE INDEX "chunk_embedding_hnsw" ON "chunk"
  USING hnsw ("embedding" vector_cosine_ops)
  WHERE "embedding" IS NOT NULL;
