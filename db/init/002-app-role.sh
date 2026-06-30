#!/bin/sh
# Provision the restricted application role OUT-OF-BAND.
#
# The role's password must NEVER live in a tracked Prisma migration: migrations
# are replayed verbatim by `prisma migrate deploy` in every environment, so a
# literal password there would ship to production in git history. Instead the
# role is created here (local dev, once on an empty data volume, as the
# superuser) from an env var, and provisioned separately with a real secret in
# prod. The #8 migration only GRANTs to / RAISEs on this role — it never creates
# it or sets its password.
set -e

# Dev-only default. Prod sets ASAB_APP_PASSWORD to a real secret before boot.
: "${ASAB_APP_PASSWORD:=asab_app_dev_pw}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'asab_app') THEN
    CREATE ROLE asab_app LOGIN PASSWORD '${ASAB_APP_PASSWORD}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
\$\$;
SQL
