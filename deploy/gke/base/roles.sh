#!/bin/bash
# Runs once on first DB init (docker-entrypoint-initdb.d, after the image's own
# scripts). GoTrue and PostgREST log in with the generated POSTGRES_PASSWORD
# instead of the compose stack's well-known 'postgres'.
set -euo pipefail
psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-supabase_admin}" -d "${POSTGRES_DB:-postgres}" \
  -v pw="$POSTGRES_PASSWORD" <<'SQL'
alter role supabase_auth_admin with login password :'pw';
alter role authenticator with login password :'pw';
alter role postgres with login password :'pw';
SQL
