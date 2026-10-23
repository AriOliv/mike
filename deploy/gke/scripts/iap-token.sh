#!/usr/bin/env bash
# Prints a short-lived (≤1 h) token that passes IAP in front of a Mike
# environment, for Playwright/curl run by agents. Keyless: the E2E service
# account signs a JWT through impersonation (needs roles/iam.serviceAccountTokenCreator
# on it for whoever runs this). Send it as `Proxy-Authorization: Bearer <token>`;
# IAP consumes that header, so `Authorization` stays free for the Mike session.
#   TOKEN=$(deploy/gke/scripts/iap-token.sh https://preview.34-120-191-197.nip.io)
set -euo pipefail
URL="${1:?environment URL, e.g. https://preview.34-120-191-197.nip.io}"; URL="${URL%/}"
P="${PROJECT:-ari-teste-492120}"
SA="${E2E_SA:-mike-preview-e2e@$P.iam.gserviceaccount.com}"
now=$(date +%s)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
printf '{"iss":"%s","sub":"%s","aud":"%s/*","iat":%d,"exp":%d}' "$SA" "$SA" "$URL" "$now" $((now + 3600)) >"$tmp/claims.json"
gcloud iam service-accounts sign-jwt "$tmp/claims.json" "$tmp/jwt" --iam-account "$SA" --project "$P" --quiet 2>/dev/null
cat "$tmp/jwt"
