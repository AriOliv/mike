#!/usr/bin/env bash
# RASCUNHO — /opt/mike-preview/preview-up.sh na VM mike-staging. Não executado.
#
# Uso: preview-up.sh <pr-number|staging> <backend-image> <frontend-image> <sha>
#
# Sobe (ou atualiza) a stack mike-pr-<n> / mike-staging, aplica schema + migrações,
# semeia dados sintéticos e registra o host no Caddy de prévias.
#
# Guardas: recusa rodar se encontrar volumes de prod nesta máquina (mike_db_data /
# mike_storage_data) — esta VM nunca deve ser a de produção.
set -euo pipefail

ID="${1:?pr number or 'staging'}"
BACKEND_IMAGE="${2:?}"
FRONTEND_IMAGE="${3:?}"
SHA="${4:?}"
MAX_PREVIEWS="${MAX_PREVIEWS:-3}"
ROOT=/opt/mike-preview
SRC_TAG="${SHA}"

if [[ "$ID" == "staging" ]]; then
  PROJECT=mike-staging; HOST=staging.clm.avenia.tech; ENV_LABEL=staging
  RESEED=false; GOOGLE_ENABLED=true; DISABLE_SIGNUP=false
else
  [[ "$ID" =~ ^[0-9]+$ ]] || { echo "id inválido: $ID"; exit 2; }
  PROJECT="mike-pr-$ID"; HOST="pr-$ID.preview.clm.avenia.tech"; ENV_LABEL="pr-$ID"
  RESEED=true; GOOGLE_ENABLED=false; DISABLE_SIGNUP=true
fi

log(){ echo "[$(date +%H:%M:%S)] [$PROJECT] $*"; }

# --- guarda: esta não pode ser a VM de prod ---------------------------------
if docker volume inspect mike_db_data >/dev/null 2>&1 || docker volume inspect mike_storage_data >/dev/null 2>&1; then
  echo "ABORT: volumes de produção encontrados nesta máquina. preview-up só roda na VM mike-staging."
  exit 3
fi

# --- limite de prévias simultâneas ------------------------------------------
if [[ "$ID" != "staging" ]] && ! docker compose ls --format json | grep -q "\"$PROJECT\""; then
  running=$(docker compose ls --format json | grep -o '"mike-pr-[0-9]*"' | wc -l)
  if (( running >= MAX_PREVIEWS )); then
    echo "limite de $MAX_PREVIEWS prévias atingido; feche um PR ou rode preview-gc.sh"; exit 4
  fi
fi

DIR="$ROOT/stacks/$PROJECT"
mkdir -p "$DIR/schema"
cd "$DIR"

# --- segredos: .env.shared (Secret Manager → arquivo 0600) + por projeto -------
# shellcheck disable=SC1091
set -a; . "$ROOT/.env.shared"; set +a
if [[ ! -f .env.project ]]; then
  umask 077
  {
    echo "DB_PASSWORD=$(openssl rand -hex 24)"
    echo "STORAGE_ACCESS_KEY=$(openssl rand -hex 12)"
    echo "STORAGE_SECRET_KEY=$(openssl rand -hex 24)"
  } > .env.project
fi
set -a; . ./.env.project; set +a
export BACKEND_IMAGE FRONTEND_IMAGE HOST ENV_LABEL GOOGLE_ENABLED DISABLE_SIGNUP
export BUILD_SHA="$SHA" COMPOSE_PROJECT_NAME="$PROJECT"

# backend.env: só o que o backend precisa, com valores DE PRÉVIA.
umask 077
cat > backend.env <<EOF
NODE_ENV=production
PORT=3001
SUPABASE_URL=http://gateway:8000
SUPABASE_SECRET_KEY=${SUPABASE_SECRET_KEY_PREVIEW}
FRONTEND_URL=https://${HOST}
APP_BASE_URL=https://${HOST}
R2_ENDPOINT=http://storage:9000
R2_ACCESS_KEY_ID=${STORAGE_ACCESS_KEY}
R2_SECRET_ACCESS_KEY=${STORAGE_SECRET_KEY}
R2_BUCKET=mike
CUSTOM_OPENAI_BASE_URL=${LITELLM_BASE_URL}
CUSTOM_OPENAI_API_KEY=${CUSTOM_OPENAI_API_KEY_PREVIEW}
CUSTOM_OPENAI_MODEL=mike-extract
USER_API_KEYS_ENCRYPTION_SECRET=${USER_API_KEYS_ENCRYPTION_SECRET_PREVIEW}
DOWNLOAD_SIGNING_SECRET=${DOWNLOAD_SIGNING_SECRET_PREVIEW}
FEEDBACK_GITHUB_REPO=AriOliv/mike
FEEDBACK_GITHUB_APP_ID=${FEEDBACK_GITHUB_APP_ID}
FEEDBACK_GITHUB_APP_KEY_FILE=/run/feedback-app.pem
FEEDBACK_PR_NUMBER=$([[ "$ID" == staging ]] && echo "" || echo "$ID")
EOF

# --- código de schema/seed da revisão -----------------------------------------
# Extrai schema.sql + migrations + seed da própria imagem do backend (assim o
# schema aplicado é exatamente o da revisão sob teste).
cid=$(docker create "$BACKEND_IMAGE")
rm -rf schema/*; docker cp "$cid:/app/schema.sql" schema/ ; docker cp "$cid:/app/migrations" schema/
docker cp "$cid:/app/deploy/preview/seed" schema/ 2>/dev/null || cp -r "$ROOT/seed" schema/
docker rm "$cid" >/dev/null
cp "$ROOT/gateway.conf" ./gateway.conf
cp "$ROOT/docker-compose.preview.yml" ./docker-compose.yml

# --- prévia: recomeça do zero a cada push (dados sintéticos, descartáveis) ------
if [[ "$RESEED" == true ]]; then
  log "reset dos volumes desta prévia"
  docker compose down -v --remove-orphans || true
fi

log "pull + up db"
docker compose pull -q
docker compose up -d db
for _ in $(seq 1 60); do docker compose exec -T db pg_isready -U postgres >/dev/null 2>&1 && break; sleep 2; done

# --- schema + migrações (ledger simples, idempotente) ---------------------------
PSQL="docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1"
$PSQL -c "create table if not exists public._preview_migrations (name text primary key, applied_at timestamptz default now())"
if [[ "$($PSQL -tAc "select count(*) from public._preview_migrations where name='schema.sql'")" == 0 ]]; then
  log "schema.sql"
  $PSQL -f /schema/schema.sql
  $PSQL -c "insert into public._preview_migrations(name) values ('schema.sql')"
fi
for f in $(ls schema/migrations/*.sql | sort); do
  n=$(basename "$f")
  if [[ "$($PSQL -tAc "select count(*) from public._preview_migrations where name='$n'")" == 0 ]]; then
    log "migração $n"
    $PSQL -f "/schema/migrations/$n"
    $PSQL -c "insert into public._preview_migrations(name) values ('$n')"
  fi
done

log "up stack"
docker compose up -d

# --- seed sintético (idempotente; ids fixos) -------------------------------------
log "seed"
PREVIEW_DEMO_PASSWORD="$PREVIEW_DEMO_PASSWORD" HOST="$HOST" PROJECT="$PROJECT" \
  bash schema/seed/seed-users.sh
$PSQL -f /schema/seed/seed.sql

# --- registra o host no Caddy de prévias -----------------------------------------
cat > "$ROOT/caddy/sites/$PROJECT.caddy" <<EOF
http://${HOST} {
	handle_path /api/* {
		reverse_proxy ${PROJECT}-backend-1:3001
	}
	handle_path /supabase/* {
		reverse_proxy ${PROJECT}-gateway-1:8000
	}
	handle {
		reverse_proxy ${PROJECT}-frontend-1:3000
	}
}
EOF
docker exec mike-preview-caddy caddy reload --config /etc/caddy/Caddyfile
date +%s > "$DIR/.last_deploy"
log "pronto: https://$HOST (build ${SHA:0:7})"
