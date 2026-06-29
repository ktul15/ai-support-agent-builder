-- Issue #10 security-review hardening.

-- H1 — authoritative global-uniqueness backstop. The app-level EXISTS pre-check
-- in auth_create_tenant_and_owner is a check-then-act race (two concurrent
-- signups for the same email land in different new tenants, so the per-tenant
-- unique never fires). This unique index makes the loser fail with a
-- unique_violation, which the service maps to 409. Login-by-email stays
-- unambiguous. Prisma expects this exact name for @@unique([email]).
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user" ("email");

-- M2 — schema-qualify table references in every SECURITY DEFINER auth function.
-- Postgres resolves UNQUALIFIED names against pg_temp BEFORE the pinned
-- search_path schema, so a session able to CREATE TEMP TABLE could shadow the
-- real table inside the definer (forged login / cross-tenant token). Qualifying
-- with public.* removes that vector. CREATE OR REPLACE preserves existing grants.
-- Covers the #10 functions and #8's auth_resolve_api_key for consistency.

CREATE OR REPLACE FUNCTION auth_create_tenant_and_owner(
  p_tenant_name text,
  p_email text,
  p_password_hash text
) RETURNS TABLE (tenant_id uuid, user_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_user_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.app_user WHERE email = p_email) THEN
    RAISE EXCEPTION 'email already registered' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO public.tenant (id, name) VALUES (gen_random_uuid(), p_tenant_name)
    RETURNING id INTO v_tenant_id;
  INSERT INTO public.app_user (id, tenant_id, email, password_hash, role)
    VALUES (gen_random_uuid(), v_tenant_id, p_email, p_password_hash, 'OWNER')
    RETURNING id INTO v_user_id;
  RETURN QUERY SELECT v_tenant_id, v_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION auth_find_user_by_email(p_email text)
RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text, role text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, tenant_id, password_hash, role::text FROM public.app_user WHERE email = p_email;
$$;

CREATE OR REPLACE FUNCTION auth_resolve_api_key(p_key_hash text)
RETURNS TABLE (api_key_id uuid, tenant_id uuid, assistant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, tenant_id, assistant_id FROM public.api_key WHERE key_hash = p_key_hash;
$$;
