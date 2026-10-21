#!/usr/bin/env bash
# Sets who passes IAP on the frontend backend service the Gateway controller
# created for a namespace (the name is generated, so run it after the first
# `kubectl apply` of an environment):
#   - staging (real contracts): ONLY the people listed in STAGING_MEMBERS, one
#     user: per person. No domain, no service account: agents use a person's
#     own credential. Anything else on the binding is removed.
#   - preview (fictitious): the whole @avenia.io Workspace, plus the keyless E2E
#     service account (agents' Playwright, see ../README.md).
#   deploy/gke/scripts/grant-iap.sh staging
#   STAGING_MEMBERS="user:a@avenia.io user:b@avenia.io" deploy/gke/scripts/grant-iap.sh staging
set -euo pipefail
NS="${1:?namespace}"; P="${PROJECT:-ari-teste-492120}"
ROLE=roles/iap.httpsResourceAccessor
E2E_SA="${E2E_SA:-mike-preview-e2e@$P.iam.gserviceaccount.com}"
STAGING_MEMBERS="${STAGING_MEMBERS:-user:aoliveira@avenia.io user:mvianna@avenia.io user:bmarcal@avenia.io user:lnoel@avenia.io}"
# gcloud with retries: a flaky network must not leave the binding half-written
g() { local i; for i in 1 2 3 4 5; do "$@" && return 0; sleep $((i * 3)); done; return 1; }
BS=$(g gcloud compute backend-services list --global --project "$P" \
  --filter="name~-${NS}-frontend-3000-" --format="value(name)" | head -1)
[ -n "$BS" ] || { echo "backend service for $NS not created yet"; exit 1; }

case "$NS" in
  staging) want="$STAGING_MEMBERS" ;;
  *) want="domain:avenia.io serviceAccount:$E2E_SA" ;;
esac
for m in $want; do
  case "$m" in user:*@avenia.io|domain:avenia.io|serviceAccount:*) ;;
    *) echo "refusing member $m"; exit 1 ;; esac
done

have=$(g gcloud iap web get-iam-policy --project "$P" --resource-type=backend-services \
  --service="$BS" --format=json | python3 -c '
import json, sys
for b in json.load(sys.stdin).get("bindings", []):
    if b["role"] == sys.argv[1]:
        print("\n".join(b["members"]))' "$ROLE")

for m in $want; do
  grep -qxF "$m" <<<"$have" || g gcloud iap web add-iam-policy-binding --project "$P" \
    --resource-type=backend-services --service="$BS" --member="$m" --role="$ROLE" \
    --condition=None --format=none
done
# staging is an allowlist: drop whoever is not on it (domain, SAs, ex-members),
# only after every wanted member is in, so nobody on the list is locked out
if [ "$NS" = staging ]; then
  [ -n "$have" ] || { echo "could not read the current policy; not removing anything"; exit 1; }
  for m in $have; do
    [[ " $want " == *" $m "* ]] || g gcloud iap web remove-iam-policy-binding --project "$P" \
      --resource-type=backend-services --service="$BS" --member="$m" --role="$ROLE" \
      --condition=None --format=none
  done
fi
