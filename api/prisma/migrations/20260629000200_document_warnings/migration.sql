-- Issue #14 — persist non-fatal parse warnings (low-text/scanned pages) so they
-- can be surfaced in the UI (#18) instead of vanishing into worker logs.
ALTER TABLE "document" ADD COLUMN "warnings" text[] NOT NULL DEFAULT '{}';
