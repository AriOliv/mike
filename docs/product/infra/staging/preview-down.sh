#!/usr/bin/env bash
# RASCUNHO — /opt/mike-preview/preview-down.sh na VM mike-staging. Não executado.
# Uso: preview-down.sh <pr-number>
# Derruba a prévia e apaga OS VOLUMES DELA (dados sintéticos). Recusa "staging"
# (staging é permanente) e qualquer nome fora do padrão mike-pr-<n>.
set -euo pipefail
ID="${1:?pr number}"
[[ "$ID" =~ ^[0-9]+$ ]] || { echo "só prévias numéricas; staging não se derruba por aqui"; exit 2; }
PROJECT="mike-pr-$ID"
ROOT=/opt/mike-preview
DIR="$ROOT/stacks/$PROJECT"

if docker volume inspect mike_db_data >/dev/null 2>&1; then
  echo "ABORT: volumes de produção nesta máquina."; exit 3
fi

if [[ -d "$DIR" ]]; then
  (cd "$DIR" && COMPOSE_PROJECT_NAME="$PROJECT" docker compose down -v --remove-orphans)
  rm -rf "$DIR"
fi
rm -f "$ROOT/caddy/sites/$PROJECT.caddy"
docker exec mike-preview-caddy caddy reload --config /etc/caddy/Caddyfile || true
echo "[$PROJECT] removida"
