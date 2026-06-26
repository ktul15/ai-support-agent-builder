-- Runs automatically the first time the Postgres data volume is initialized
-- (docker-entrypoint-initdb.d). Enables pgvector so the schema/migrations in
-- later issues can declare vector columns. Idempotent.
CREATE EXTENSION IF NOT EXISTS vector;
