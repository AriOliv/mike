#!/usr/bin/env bash
# One command to refresh the integration preview (namespace preview,
# https://preview.34-120-191-197.nip.io) after any of its PRs moves:
#   1. rebuilds integration/preview from origin: sync/upstream-2026-10 + BRANCHES
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
# named at the end: its owner rebases it on integration/preview.
# Never touches namespace staging (except the shared Gateway, which only the
# staging overlay applies).
set -euo pipefail
# The checkout below rewrites this file; run from a copy.
if [ -z "${_PREVIEW_COPY:-}" ]; then
  c=$(mktemp); cp "$0" "$c"; _PREVIEW_COPY=1 exec bash "$c" "$@"
fi
ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT"
P="${PROJECT:-ari-teste-492120}"; REGION=southamerica-east1; NS=preview
BASE="${BASE:-sync/upstream-2026-10}"; TARGET="${TARGET:-integration/preview}"
# infra/gke-staging carries deploy/gke itself; the rest in merge order.
BRANCHES="${BRANCHES:-infra/gke-staging feat/card-events feat/ui-verdict feat/ui-agent-suggestion feat/intake-orquestracao feat/ux-nav-pt feat/radar-regulatorio feat/inicio-contract-intelligence feat/revisao-playbook}"
# Branches allowed to come from a LOCAL ref while their owner has not pushed
# yet (committed work only; uncommitted changes in their worktrees never enter).
LOCAL_OK="${LOCAL_OK:-feat/radar-regulatorio}"
# kept outside the checkout (the merges rewrite deploy/gke)
UNION=$(mktemp); cp "$ROOT/deploy/gke/scripts/union-words.pl" "$UNION"
UNION_NAV=$(mktemp); cp "$ROOT/deploy/gke/scripts/union-nav.py" "$UNION_NAV"
SUPERSET=$(mktemp); cp "$ROOT/deploy/gke/scripts/superset.pl" "$SUPERSET"
REG="southamerica-east1-docker.pkg.dev/$P/mike"

git diff --quiet && git diff --cached --quiet || { echo "working tree is dirty; commit or stash first"; exit 1; }
git fetch -q origin

if [ "${SKIP_MERGE:-0}" != 1 ]; then
  git checkout -q -B "$TARGET" "origin/$BASE"
  merged=() skipped=() conflicted=()
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
    # diff3 so the resolvers below see the common base; rerere off (a stale
    # recorded resolution would silently win over the rules)
    navdone=""
    if ! git -c rerere.enabled=false -c merge.conflictStyle=diff3 merge -q --no-ff --no-edit "$ref" >/dev/null 2>&1; then
      files=$(git diff --name-only --diff-filter=U | tr '\n' ' ')
      if [ -z "$files" ]; then git merge --abort 2>/dev/null; conflicted+=("$b: merge failed without conflicts"); continue
      else
      # The only conflicts we resolve here are "both sides appended a line"
      # in the registries every feature touches; anything else is real.
      trivial="backend/schema.sql backend/src/app.ts backend/src/jobs/registry.ts frontend/src/app/lib/mikeApi.ts frontend/src/app/lib/mikeApi.contracts.test.ts"
      # the sidebar: features only add to it; per hunk keep the side that
      # contains the other (menu items themselves live in navItems.ts)
      ours="frontend/src/app/components/shared/AppSidebar.tsx"
      # one-line word lists every feature appends to
      # menu items, one line per feature (navItems.ts + its test)
      nav="frontend/src/app/lib/navItems.ts frontend/src/app/lib/navItems.test.ts"
      words="backend/src/lib/observability/sentryPrivacy.ts frontend/src/shared/lib/sentryPrivacy.ts backend/src/__tests__/helpers/scriptedDb.ts"
      # shared components owned by an earlier PR (#6 ActivityFeed/StatusChip,
      # #7 AgentSuggestion, #5 VerdictUI): later branches carry older copies,
      # so in the hunks that collide the integration's (owner's) side wins
      # the sidebar's own test follows the menu (#9 ux-nav-pt owns it): in
      # colliding hunks the side of the branch that is #9 wins
      menu_test="frontend/src/app/components/shared/AppSidebar.memory.test.tsx"
      owned="frontend/src/app/components/shared/AgentSuggestion.tsx frontend/src/app/components/shared/AgentSuggestion.test.tsx frontend/src/app/lib/activityFeed.ts frontend/src/app/lib/activityFeed.test.ts frontend/src/shared/ui/VerdictUI.tsx frontend/src/shared/ui/VerdictUI.test.tsx"
      real=""
      for f in $files; do case " $trivial $ours $words $nav $owned $menu_test " in *" $f "*) ;; *) real="$real $f";; esac; done
      if [ -n "$real" ]; then
        git merge --abort; conflicted+=("$b:$real"); echo "LEFT OUT $b: conflict in$real"; continue
      fi
      for f in $files; do
        case " $ours " in
          *" $f "*) perl "$SUPERSET" "$f" >"$f.res" && mv "$f.res" "$f" ;;
        esac
        case " $words " in
          *" $f "*) perl -0pi "$UNION" "$f" ;;
        esac
        # conflicting hunks only: the rest of the branch's additions stay merged
        case " $menu_test " in *" $f "*)
          if [ "$b" = feat/ux-nav-pt ]; then pick='$2'; else pick='$1'; fi
          perl -0pi -e "s/^<<<<<<< [^\n]*\n(.*?)^\|\|\|\|\|\|\| [^\n]*\n.*?^=======\n(.*?)^>>>>>>> [^\n]*\n/$pick/gms" "$f" ;;
        esac
        case " $owned " in *" $f "*)
          perl -0pi -e 's/^<<<<<<< [^\n]*\n(.*?)^\|\|\|\|\|\|\| [^\n]*\n.*?^=======\n(.*?)^>>>>>>> [^\n]*\n/$1/gms' "$f" ;;
        esac
        case " $nav " in
          *" $f "*) [ -n "${navdone:-}" ] || { python3 "$UNION_NAV" "$ROOT"; navdone=1; } ;;
        esac
        case " $ours $words $nav $owned $menu_test " in *" $f "*) ;;
          # diff3 hunks: ours, then theirs, dropping the common base (keeps
          # a closing brace the base shares from being lost)
          *) perl -0pi -e 's/^<<<<<<< [^\n]*\n(.*?)^\|\|\|\|\|\|\| [^\n]*\n.*?^=======\n(.*?)^>>>>>>> [^\n]*\n/$1$2/gms' "$f" ;;
        esac
      done
      # concatenated hunks leave the migration ledger out of order; sort it
      case " $files " in *" backend/schema.sql "*)
        python3 - <<'PY'
import re
p = "backend/schema.sql"; s = open(p).read()
m = list(re.finditer(r"(insert into public\.schema_migrations \(filename\) values\n)(.*?)(\non conflict)", s, re.S))[-1]
rows = sorted({r.strip().rstrip(",") for r in m.group(2).split("\n") if r.strip()})
s = s[:m.start(2)] + ",\n".join("  " + r for r in rows) + s[m.end(2):]
open(p, "w").write(s)
PY
      ;; esac
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
# RESET_DB=1: recreate the (synthetic) database, e.g. after a branch rewrote a
# migration the preview already applied. Only ever the preview namespace.
if [ "${RESET_DB:-0}" = 1 ]; then
  echo "resetting the preview database (synthetic data, re-seeded below)"
  kubectl -n "$NS" scale deploy/backend --replicas=0 2>/dev/null || true
  kubectl -n "$NS" scale statefulset/db --replicas=0
  kubectl -n "$NS" wait --for=delete pod/db-0 --timeout=5m 2>/dev/null || true
  kubectl -n "$NS" delete pvc data-db-0 --ignore-not-found --wait=true
  kubectl -n "$NS" delete pvc backend-files --ignore-not-found --wait=true
fi
# render with the tag of this commit (no kustomize CLI / file edits needed)
RENDERED=$(mktemp)
kubectl kustomize "$OVERLAY" \
  | sed -E "s#($REG/(backend|frontend)):latest#\1:$TAG#g" > "$RENDERED"
kubectl apply -f "$RENDERED"
[ "${RESET_DB:-0}" != 1 ] || kubectl -n "$NS" scale statefulset/db --replicas=1
kubectl -n "$NS" wait --for=condition=complete job/db-init --timeout=15m
# the seed checks which tables/columns exist (requires-table), so it must run
# after this rollout's migrations: on an existing database it would not wait
kubectl -n "$NS" delete job seed --ignore-not-found --wait=true
kubectl apply -f "$RENDERED" >/dev/null
kubectl -n "$NS" rollout restart deploy/auth deploy/rest >/dev/null  # pick up roles on first boot
kubectl -n "$NS" rollout status deploy/backend --timeout=10m
kubectl -n "$NS" rollout status deploy/frontend --timeout=10m
# files the seed points at (storage keys under STORAGE_FS_ROOT), e.g. the
# Revisão .docx: copied into the backend volume, never overwritten if present
FILES=deploy/gke/seed/integration/files
if [ -d "$FILES" ]; then
  pod=$(kubectl -n "$NS" get pod -l app=backend --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
  # /data/files only exists once the backend has stored a file
  COPYFILE_DISABLE=1 tar --no-xattrs -C "$FILES" -cf - . | kubectl -n "$NS" exec -i "$pod" -- \
    sh -c 'mkdir -p /data/files && tar -C /data/files --skip-old-files -xf -'
fi
kubectl -n "$NS" wait --for=condition=complete job/seed --timeout=10m
deploy/gke/scripts/grant-iap.sh "$NS" >/dev/null
echo "preview rolled to $TAG: https://preview.34-120-191-197.nip.io"
