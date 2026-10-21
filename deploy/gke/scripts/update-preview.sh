#!/usr/bin/env bash
# One command to refresh the integration preview (namespace preview,
# https://preview.34-120-191-197.nip.io) after any of its PRs moves:
#   1. rebuilds integration/harvey from origin: sync/upstream-2026-10 + BRANCHES
#   2. pushes it (force-with-lease: the branch is generated, never hand-edited)
#   3. Cloud Build for that commit, then apply + wait + seed on namespace preview
#
#   deploy/gke/scripts/update-preview.sh
#   BRANCHES="feat/a feat/b" deploy/gke/scripts/update-preview.sh   # other set
#   SKIP_MERGE=1 deploy/gke/scripts/update-preview.sh                # redeploy HEAD of the branch
#   SKIP_BUILD=1 ...                                                 # reuse the image of that commit
#
# Stops on the first merge conflict and names the two branches: whoever owns
# the later branch rebases it on the earlier one; nothing is pushed then.
# Never touches namespace staging (except the shared Gateway, which only the
# staging overlay applies).
set -euo pipefail
# The checkout below rewrites this file; run from a copy.
if [ -z "${_PREVIEW_COPY:-}" ]; then
  c=$(mktemp); cp "$0" "$c"; _PREVIEW_COPY=1 exec bash "$c" "$@"
fi
ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT"
P="${PROJECT:-ari-teste-492120}"; REGION=southamerica-east1; NS=preview
BASE="${BASE:-sync/upstream-2026-10}"; TARGET="${TARGET:-integration/harvey}"
# infra/gke-staging carries deploy/gke itself; the rest in merge order.
BRANCHES="${BRANCHES:-infra/gke-staging feat/card-events feat/ui-verdict feat/ui-agent-suggestion feat/intake-orquestracao feat/radar-regulatorio feat/inicio-contract-intelligence feat/revisao-playbook}"
# Branches allowed to come from a LOCAL ref while their owner has not pushed
# yet (committed work only; uncommitted changes in their worktrees never enter).
LOCAL_OK="${LOCAL_OK:-feat/radar-regulatorio}"
REG="southamerica-east1-docker.pkg.dev/$P/mike"

git diff --quiet && git diff --cached --quiet || { echo "working tree is dirty; commit or stash first"; exit 1; }
git fetch -q origin

if [ "${SKIP_MERGE:-0}" != 1 ]; then
  git checkout -q -B "$TARGET" "origin/$BASE"
  merged=() skipped=()
  for b in $BRANCHES; do
    # the pushed branch; a local one only when listed in LOCAL_OK
    if git rev-parse -q --verify "origin/$b" >/dev/null; then ref="origin/$b"
    elif [[ " $LOCAL_OK " == *" $b "* ]] && git rev-parse -q --verify "refs/heads/$b" >/dev/null; then
      ref="$b"; echo "using LOCAL $b (not pushed)"
    else skipped+=("$b"); continue; fi
    if ! git merge -q --no-ff --no-edit "$ref" >/dev/null 2>&1; then
      files=$(git diff --name-only --diff-filter=U | tr '\n' ' ')
      # The only conflicts we resolve here are "both sides appended a line"
      # in the registries every feature touches; anything else is real.
      trivial="backend/schema.sql backend/src/app.ts backend/src/jobs/registry.ts"
      for f in $files; do
        case " $trivial " in *" $f "*) ;; *) git merge --abort
          echo "CONFLICT merging $b: $files"; echo "already merged: ${merged[*]:-none}"; exit 2;; esac
      done
      for f in $files; do
        perl -0pi -e 's/^<<<<<<< [^\n]*\n(.*?)^=======\n(.*?)^>>>>>>> [^\n]*\n/$1$2/gms' "$f"
      done
      git add $files && git commit -q --no-edit
      echo "merged $ref (kept both sides in: $files)"
    fi
    merged+=("$ref")
  done
  echo "merged: ${merged[*]:-none}"; [ ${#skipped[@]} -eq 0 ] || echo "skipped (not found): ${skipped[*]}"
  git push -q --force-with-lease origin "$TARGET"
fi

TAG=$(git rev-parse --short HEAD)
if [ "${SKIP_BUILD:-0}" != 1 ]; then
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  git archive --format=tar.gz -o "$tmp/src.tgz" HEAD
  gcloud builds submit "$tmp/src.tgz" --region "$REGION" --project "$P" \
    --config deploy/gke/cloudbuild.yaml --substitutions "_TAG=$TAG"
fi

OVERLAY=deploy/gke/overlays/$NS
kubectl apply -f "$OVERLAY/namespace.yaml"
deploy/gke/scripts/bootstrap-secrets.sh "$NS"
kubectl -n "$NS" delete job db-init seed --ignore-not-found
# render with the tag of this commit (no kustomize CLI / file edits needed)
kubectl kustomize "$OVERLAY" \
  | sed -E "s#($REG/(backend|frontend)):latest#\1:$TAG#g" \
  | kubectl apply -f -
kubectl -n "$NS" wait --for=condition=complete job/db-init --timeout=15m
kubectl -n "$NS" rollout restart deploy/auth deploy/rest >/dev/null  # pick up roles on first boot
kubectl -n "$NS" rollout status deploy/backend --timeout=10m
kubectl -n "$NS" rollout status deploy/frontend --timeout=10m
kubectl -n "$NS" wait --for=condition=complete job/seed --timeout=10m
deploy/gke/scripts/grant-iap.sh "$NS" >/dev/null
echo "preview rolled to $TAG: https://preview.34-120-191-197.nip.io"
