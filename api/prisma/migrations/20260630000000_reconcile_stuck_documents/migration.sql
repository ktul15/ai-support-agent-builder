-- Issue #18 — reconcile documents stuck in a non-terminal status.
--
-- The worker marks a document FAILED only when BullMQ exhausts retries, via a
-- best-effort handler. If that write is lost (DB blip) or a job stalls below its
-- attempt count, the document would sit in UPLOADED/PARSING/EMBEDDING forever.
-- This function sweeps such rows once they're older than a generous threshold (a
-- live job advances status within seconds, so minutes of no movement = stuck).
--
-- SECURITY DEFINER (owner) so it can scan/fix across every tenant; exposed only
-- to asab_app — same least-privilege pattern as the auth functions.
CREATE OR REPLACE FUNCTION reconcile_stuck_documents(p_age interval)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH stuck AS (
    UPDATE document
    SET status = 'FAILED', error = 'ingestion timed out'
    WHERE status IN ('QUEUED', 'UPLOADED', 'PARSING', 'EMBEDDING')
      AND updated_at < now() - p_age
    RETURNING 1
  )
  SELECT count(*)::int FROM stuck;
$$;

REVOKE ALL ON FUNCTION reconcile_stuck_documents(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reconcile_stuck_documents(interval) TO asab_app;
