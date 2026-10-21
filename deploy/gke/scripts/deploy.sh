#!/usr/bin/env bash
# Builds images for the current commit and rolls an environment on mike-gke.
#   deploy/gke/scripts/deploy.sh staging            # build + apply
#   SKIP_BUILD=1 deploy/gke/scripts/deploy.sh staging
# Needs: gcloud (Cloud Build, container.developer on mike-gke), kubectl with the
# mike-gke context (DNS endpoint: `gcloud container clusters get-credentials
# mike-gke --region southamerica-east1 --dns-endpoint`).
set -euo pipefail
ENV="${1:?environment overlay (staging)}"
ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT"
P="${PROJECT:-ari-teste-492120}"; REGION=southamerica-east1
TAG="${TAG:-$(git rev-parse --short HEAD)}"
OVERLAY="deploy/gke/overlays/$ENV"

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  git diff --quiet HEAD || { echo "uncommitted changes: images are built from HEAD"; exit 1; }
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  git archive --format=tar.gz -o "$tmp/src.tgz" HEAD
  gcloud builds submit "$tmp/src.tgz" --region "$REGION" --project "$P" \
    --config deploy/gke/cloudbuild.yaml --substitutions "_TAG=$TAG"
fi

kubectl apply -f "$OVERLAY/namespace.yaml"
deploy/gke/scripts/bootstrap-secrets.sh "$ENV"
# Jobs are immutable: recreate so a new image re-runs migrations (and the seed,
# where the overlay has one; staging has real data and none).
kubectl -n "$ENV" delete job db-init seed --ignore-not-found
(cd "$OVERLAY" && kustomize edit set image "mike-backend=*:$TAG" "mike-frontend=*:$TAG" 2>/dev/null) || \
  sed -i.bak -E "s/newTag: .*/newTag: $TAG/" "$OVERLAY/kustomization.yaml"
kubectl apply -k "$OVERLAY"
kubectl -n "$ENV" wait --for=condition=complete job/db-init --timeout=15m
kubectl -n "$ENV" rollout status deploy/backend --timeout=10m
kubectl -n "$ENV" rollout status deploy/frontend --timeout=10m
if kubectl -n "$ENV" get job seed >/dev/null 2>&1; then
  kubectl -n "$ENV" wait --for=condition=complete job/seed --timeout=10m
fi
deploy/gke/scripts/grant-iap.sh "$ENV" >/dev/null
echo "rolled $ENV to $TAG"
