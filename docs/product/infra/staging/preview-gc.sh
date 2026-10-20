#!/usr/bin/env bash
# RASCUNHO — cron diário na VM mike-staging (ex.: /etc/cron.d/mike-preview-gc,
# "0 5 * * * root /opt/mike-preview/preview-gc.sh"). Não executado.
# Remove prévias sem deploy há mais de TTL_DAYS (default 7). Nunca toca staging.
set -euo pipefail
TTL_DAYS="${TTL_DAYS:-7}"
ROOT=/opt/mike-preview
now=$(date +%s)
for d in "$ROOT"/stacks/mike-pr-*; do
  [[ -d "$d" ]] || continue
  last=$(cat "$d/.last_deploy" 2>/dev/null || echo 0)
  if (( now - last > TTL_DAYS * 86400 )); then
    id="${d##*/mike-pr-}"
    echo "gc: prévia $id sem deploy há mais de $TTL_DAYS dias"
    "$ROOT/preview-down.sh" "$id"
  fi
done
docker image prune -af --filter "until=168h" >/dev/null
