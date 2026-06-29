-- Issue #10 — auth bootstrap functions.
--
-- Signup and login operate BEFORE any tenant context exists (no JWT yet), but
-- `tenant` and `app_user` are FORCE-RLS protected (#8), so the restricted
-- `asab_app` role cannot read/insert them directly. These SECURITY DEFINER
-- functions run as the owner (a superuser, exempt from FORCE RLS) and expose
-- ONLY the two narrow auth operations to `asab_app` — the same least-privilege
-- pattern as auth_resolve_api_key. The app never holds an owner connection.
--
-- NOTE (carried from #8): the bypass works because the function owner (postgres)
-- is a superuser. If ownership ever moves to a non-superuser, FORCE RLS would
-- block these and signup/login would break.

-- Create a tenant and its OWNER user atomically. Enforces GLOBAL email
-- uniqueness (the table unique is per-tenant) so login-by-email is unambiguous.
-- The caller hashes the password (argon2) — a plaintext password never reaches
-- the database.
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
  IF EXISTS (SELECT 1 FROM app_user WHERE email = p_email) THEN
    RAISE EXCEPTION 'email already registered' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO tenant (id, name) VALUES (gen_random_uuid(), p_tenant_name)
    RETURNING id INTO v_tenant_id;
  INSERT INTO app_user (id, tenant_id, email, password_hash, role)
    VALUES (gen_random_uuid(), v_tenant_id, p_email, p_password_hash, 'OWNER')
    RETURNING id INTO v_user_id;
  RETURN QUERY SELECT v_tenant_id, v_user_id;
END;
$$;

-- Resolve a user by email for login (global lookup, pre-tenant-context).
-- Returns the hash so the caller can verify with argon2; exposes no other PII.
CREATE OR REPLACE FUNCTION auth_find_user_by_email(p_email text)
RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text, role text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, tenant_id, password_hash, role::text FROM app_user WHERE email = p_email;
$$;

REVOKE ALL ON FUNCTION auth_create_tenant_and_owner(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_create_tenant_and_owner(text, text, text) TO asab_app;

REVOKE ALL ON FUNCTION auth_find_user_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user_by_email(text) TO asab_app;
