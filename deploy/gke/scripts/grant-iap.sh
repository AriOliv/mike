#!/usr/bin/env bash
# Grants IAP access on the frontend backend service the Gateway controller
# created for a namespace (the name is generated, so run it after the first
# `kubectl apply` of an environment):
#   - the whole @avenia.io Workspace (people);
#   - the keyless E2E service account (agents' Playwright, see ../README.md),
#     on this backend service only, never project-wide.
#   deploy/gke/scripts/grant-iap.sh staging
set -euo pipefail
NS="${1:?namespace}"; P="${PROJECT:-ari-teste-492120}"
E2E_SA="${E2E_SA:-mike-preview-e2e@$P.iam.gserviceaccount.com}"
BS=$(gcloud compute backend-services list --global --project "$P" \
  --filter="name~-${NS}-frontend-3000-" --format="value(name)" | head -1)
[ -n "$BS" ] || { echo "backend service for $NS not created yet"; exit 1; }
for m in domain:avenia.io "serviceAccount:$E2E_SA"; do
  gcloud iap web add-iam-policy-binding --project "$P" --resource-type=backend-services \
    --service="$BS" --member="$m" --role=roles/iap.httpsResourceAccessor --condition=None --format=none
done
