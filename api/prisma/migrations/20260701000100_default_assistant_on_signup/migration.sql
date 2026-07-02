-- Provision a default assistant as part of tenant creation, so the builder has
-- an upload/query target from day one (the demo model is one tenant → one
-- assistant). Added INSIDE the SECURITY DEFINER bootstrap so tenant + owner +
-- assistant are created atomically. Signature unchanged (still returns
-- tenant_id, user_id) — the admin discovers the assistant via GET /assistants.
-- CREATE OR REPLACE preserves the function's existing grants.
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
  INSERT INTO public.assistant (id, tenant_id, name, updated_at)
    VALUES (gen_random_uuid(), v_tenant_id, 'Default assistant', now());
  RETURN QUERY SELECT v_tenant_id, v_user_id;
END;
$$;
