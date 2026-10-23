#!/usr/bin/env bash
# Generates the per-namespace secrets for a Mike environment on GKE and stores
# them as Kubernetes Secrets. Values are random, never printed, never in git.
# Idempotent: an existing secret is kept (rotating JWT_SECRET would invalidate
# every session and the anon/service keys) unless ROTATE=1.
#
#   deploy/gke/scripts/bootstrap-secrets.sh staging
#
# Creates:
#   mike-secrets          POSTGRES_PASSWORD JWT_SECRET ANON_KEY SERVICE_ROLE_KEY DEMO_PASSWORD
#   mike-backend-secrets  SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY + backend signing/encryption secrets
# The demo password is the only value a person needs; read it with:
#   kubectl -n <ns> get secret mike-secrets -o jsonpath='{.data.DEMO_PASSWORD}' | base64 -d
set -euo pipefail
# kubectl always targets mike-gke (see kube.sh)
. "$(dirname "${BASH_SOURCE[0]}")/kube.sh"
NS="${1:?namespace}"

if kubectl -n "$NS" get secret mike-secrets >/dev/null 2>&1 && [ "${ROTATE:-0}" != 1 ]; then
  echo "secrets already exist in $NS (ROTATE=1 to regenerate)"; exit 0
fi

rand() { openssl rand -hex "${1:-32}"; }
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
# HS256 JWT with a 10-year expiry, the shape Supabase uses for anon/service keys.
jwt() {
  local role="$1" secret="$2" now exp header payload sig
  now=$(date +%s); exp=$((now + 315360000))
  header=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
  payload=$(printf '{"iss":"supabase","role":"%s","iat":%d,"exp":%d}' "$role" "$now" "$exp" | b64url)
  sig=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -hmac "$secret" -binary | b64url)
  printf '%s.%s.%s' "$header" "$payload" "$sig"
}

PG=$(rand 24); JWT=$(rand 32)
ANON=$(jwt anon "$JWT"); SERVICE=$(jwt service_role "$JWT")
DEMO="Demo-$(rand 6)"

kubectl -n "$NS" create secret generic mike-secrets --dry-run=client -o yaml \
  --from-literal=POSTGRES_PASSWORD="$PG" \
  --from-literal=JWT_SECRET="$JWT" \
  --from-literal=ANON_KEY="$ANON" \
  --from-literal=SERVICE_ROLE_KEY="$SERVICE" \
  --from-literal=DEMO_PASSWORD="$DEMO" | kubectl apply -f - >/dev/null

kubectl -n "$NS" create secret generic mike-backend-secrets --dry-run=client -o yaml \
  --from-literal=SUPABASE_PUBLISHABLE_KEY="$ANON" \
  --from-literal=SUPABASE_SECRET_KEY="$SERVICE" \
  --from-literal=DOWNLOAD_SIGNING_SECRET="$(rand 32)" \
  --from-literal=USER_API_KEYS_ENCRYPTION_SECRET="$(rand 32)" \
  --from-literal=MCP_CONNECTORS_ENCRYPTION_SECRET="$(rand 32)" \
  --from-literal=AUTH_HANDOFF_ENCRYPTION_SECRET="$(rand 32)" \
  --from-literal=SPOTLIGHT_NONCE_SECRET="$(rand 32)" | kubectl apply -f - >/dev/null

echo "secrets written to $NS (values not shown)"
