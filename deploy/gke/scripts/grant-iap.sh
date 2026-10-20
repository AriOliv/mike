#!/usr/bin/env bash
# Grants IAP access to the whole @avenia.io Workspace on the frontend backend
# service the Gateway controller created for a namespace. Run after the first
# `kubectl apply` of an environment (the backend service name is generated).
#   deploy/gke/scripts/grant-iap.sh staging
set -euo pipefail
NS="${1:?namespace}"; P="${PROJECT:-ari-teste-492120}"
BS=$(gcloud compute backend-services list --global --project "$P" \
  --filter="name~-${NS}-frontend-3000-" --format="value(name)" | head -1)
[ -n "$BS" ] || { echo "backend service for $NS not created yet"; exit 1; }
gcloud iap web add-iam-policy-binding --project "$P" --resource-type=backend-services \
  --service="$BS" --member=domain:avenia.io --role=roles/iap.httpsResourceAccessor --condition=None
