#!/usr/bin/env bash
# RASCUNHO — cria os usuários demo da prévia via GoTrue admin API e grava os ids
# em public._seed_users (lido por seed.sql). Não executado.
# Requer: PREVIEW_DEMO_PASSWORD, SUPABASE_SECRET_KEY_PREVIEW, PROJECT.
# Idempotente: usuário existente é reaproveitado.
set -euo pipefail
: "${PREVIEW_DEMO_PASSWORD:?}" "${SUPABASE_SECRET_KEY_PREVIEW:?}" "${PROJECT:?}"

DC="docker compose -p $PROJECT"
PSQL="$DC exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1"
$PSQL -c "create table if not exists public._seed_users (email text primary key, id uuid not null, role text not null)"

create_user() {
  local email="$1" name="$2" role="$3"
  # Chamada de dentro da rede da stack (container backend tem curl? senão usar
  # um curlimages/curl efêmero na mesma rede).
  local body
  body=$(printf '{"email":"%s","password":"%s","email_confirm":true,"user_metadata":{"full_name":"%s"}}' \
    "$email" "$PREVIEW_DEMO_PASSWORD" "$name")
  docker run --rm --network "${PROJECT}_default" curlimages/curl:8.10.1 -s -o /dev/null \
    -X POST http://auth:9999/admin/users \
    -H "Authorization: Bearer ${SUPABASE_SECRET_KEY_PREVIEW}" \
    -H "Content-Type: application/json" -d "$body" || true
  $PSQL -c "insert into public._seed_users(email, id, role)
            select email, id, '$role' from auth.users where email = '$email'
            on conflict (email) do update set id = excluded.id, role = excluded.role"
}

create_user legal.demo@avenia.io       "Legal Demo"       legal
create_user solicitante.demo@avenia.io "Solicitante Demo" solicitante
