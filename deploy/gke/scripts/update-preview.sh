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
# A branch with a real merge conflict, or whose migrations create a table an
# earlier branch already creates, is left out (the others still ship) and
# named at the end: its owner rebases it on integration/harvey.
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
# kept outside the checkout (the merges rewrite deploy/gke)
UNION=$(mktemp); cp "$ROOT/deploy/gke/scripts/union-words.pl" "$UNION"
REG="southamerica-east1-docker.pkg.dev/$P/mike"

git diff --quiet && git diff --cached --quiet || { echo "working tree is dirty; commit or stash first"; exit 1; }
git fetch -q origin

if [ "${SKIP_MERGE:-0}" != 1 ]; then
  git checkout -q -B "$TARGET" "origin/$BASE"
  merged=() skipped=() conflicted=() nolink=()
  # tables every migration creates; a branch whose migrations create a table
  # some earlier migration already creates is left out (create-if-not-exists
  # would silently keep the first shape)
  tables_of() { git grep -hioE "create table if not exists public\.[a-z_]+" "$1" -- backend/migrations \
                  | sed -E 's/.*public\.//' | tr 'A-Z' 'a-z' | sort -u; }
  for b in $BRANCHES; do
    # the pushed branch; a local one only when listed in LOCAL_OK
    if git rev-parse -q --verify "origin/$b" >/dev/null; then ref="origin/$b"
    elif [[ " $LOCAL_OK " == *" $b "* ]] && git rev-parse -q --verify "refs/heads/$b" >/dev/null; then
      ref="$b"; echo "using LOCAL $b (not pushed)"
    else skipped+=("$b"); continue; fi
    before=$(tables_of HEAD)
    # rerere replays conflict resolutions already recorded on this machine
    # (resolve once by hand in a worktree, `git rerere`, commit: next run is clean)
    if ! git -c rerere.enabled=true -c rerere.autoupdate=true -c merge.conflictStyle=diff3 merge -q --no-ff --no-edit "$ref" >/dev/null 2>&1; then
      files=$(git diff --name-only --diff-filter=U | tr '\n' ' ')
      if [ -z "$files" ]; then git commit -q --no-edit; echo "merged $ref (recorded resolution)"
      else
      # The only conflicts we resolve here are "both sides appended a line"
      # in the registries every feature touches; anything else is real.
      trivial="backend/schema.sql backend/src/app.ts backend/src/jobs/registry.ts frontend/src/app/lib/mikeApi.ts frontend/src/app/lib/mikeApi.contracts.test.ts"
      # the sidebar moved to app/lib/navItems.ts (#8): keep the integration's
      # sidebar; the branch's menu link is missing until its owner adds a line
      # to navItems.ts (the page itself still works by URL)
      ours="frontend/src/app/components/shared/AppSidebar.tsx"
      # one-line word lists every feature appends to
      words="backend/src/lib/observability/sentryPrivacy.ts frontend/src/shared/lib/sentryPrivacy.ts backend/src/__tests__/helpers/scriptedDb.ts"
      real=""
      for f in $files; do case " $trivial $ours $words " in *" $f "*) ;; *) real="$real $f";; esac; done
      if [ -n "$real" ]; then
        git merge --abort; conflicted+=("$b:$real"); echo "LEFT OUT $b: conflict in$real"; continue
      fi
      for f in $files; do
        case " $ours " in
          *" $f "*) git checkout -q --ours -- "$f"; nolink+=("$b") ;;
        esac
        case " $words " in
          *" $f "*) perl -0pi "$UNION" "$f" ;;
        esac
        case " $ours $words " in *" $f "*) ;;
          # diff3 hunks: ours, then theirs, dropping the common base (keeps
          # a closing brace the base shares from being lost)
          *) perl -0pi -e 's/^<<<<<<< [^\n]*\n(.*?)^\|\|\|\|\|\|\| [^\n]*\n.*?^=======\n(.*?)^>>>>>>> [^\n]*\n/$1$2/gms' "$f" ;;
        esac
      done
      git add $files && git commit -q --no-edit
      echo "merged $ref (kept both sides in: $files)"
      fi
    fi
    dup=$(comm -12 <(echo "$before") <(git diff --name-only HEAD^1 HEAD -- backend/migrations \
            | xargs -I{} git grep -hioE "create table if not exists public\.[a-z_]+" HEAD -- {} \
            | sed -E 's/.*public\.//' | tr 'A-Z' 'a-z' | sort -u))
    if [ -n "$dup" ]; then
      git reset -q --hard HEAD^1; conflicted+=("$b: table(s) already created by an earlier branch: $(echo $dup)")
      echo "LEFT OUT $b: its migrations re-create $(echo $dup)"; continue
    fi
    merged+=("$ref")
  done
  echo "merged: ${merged[*]:-none}"; [ ${#skipped[@]} -eq 0 ] || echo "skipped (not found): ${skipped[*]}"
  [ ${#nolink[@]} -eq 0 ] || echo "no menu link yet (add a line to app/lib/navItems.ts): ${nolink[*]}"
  if [ ${#conflicted[@]} -gt 0 ]; then echo "LEFT OUT (owner must rebase/rename):"; printf '  %s\n' "${conflicted[@]}"; fi
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
