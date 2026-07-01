-- Track the embedding model an assistant's corpus was embedded with, so query
-- and corpus can be asserted to share a vector space (invariant #4). Nullable:
-- claimed on first ingest, unset until then.
ALTER TABLE "assistant" ADD COLUMN "embedding_model" TEXT;
