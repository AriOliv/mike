#!/usr/bin/env bash
# The container images CI's `supabase start` pulls, mirrored in this repo's
# GHCR so a throttled public registry (Docker Hub / ECR Public / GHCR anonymous
# limits) cannot stall the stack, schema-drift and e2e jobs.
#
#   supabase-images.sh list            # "<name>:<tag>" the pinned CLI uses
#   supabase-images.sh mirror          # copy each one into $MIRROR (same digest)
#   supabase-images.sh use             # in a job: point the CLI at $MIRROR, or
#                                      # fall back to the public registries
#
# The list comes from the pinned CLI itself (its embedded Dockerfile, the
# source of truth for its image tags), so a CLI bump needs no edit here.
# MIRROR defaults to ghcr.io/<owner>/<repo>-ci-mirror; the CLI addresses a
# registry override as "<registry>/supabase/<image>", so images land under
# $MIRROR/supabase/.
set -euo pipefail

CLI_VERSION="${SUPABASE_CLI_VERSION:-2.108.0}"
REPO="${GITHUB_REPOSITORY:-aol-tech/mike}"
MIRROR="${MIRROR:-ghcr.io/$(tr 'A-Z' 'a-z' <<<"$REPO")-ci-mirror}"
# What CI's stacks pull: the services they start (the rest is excluded with -x
# in every job) plus realtime and storage-api, whose images the CLI still runs
# as one-off migration jobs while starting the database (they are enabled in
# the generated config.toml; -x drops only their long-running containers), and
# edge-runtime, which it runs to cache the migrations catalog (a warning, not a
# failure, without it).
SERVICES="${SERVICES:-postgres gotrue postgrest kong realtime storage-api edge-runtime}"
EXTRA="${EXTRA:-rustfs/rustfs:latest}"

# "<repository>:<tag>" for every FROM in the CLI's Dockerfile at that version
dockerfile_images() {
  curl -fsSL --retry 4 --retry-delay 3 \
    "https://raw.githubusercontent.com/supabase/cli/v${CLI_VERSION}/apps/cli-go/pkg/config/templates/Dockerfile" \
    | awk '/^FROM /{print $2}'
}

list() {
  local all name
  all=$(dockerfile_images)
  for name in $SERVICES; do
    # last path segment before the tag ("library/kong:2.8.1" -> kong)
    grep -E "(^|/)${name}:" <<<"$all" | head -1 || { echo "no image for $name in CLI $CLI_VERSION" >&2; exit 1; }
  done
}

# the sources the CLI itself tries, in its order (ECR Public, GHCR, Docker Hub)
sources_for() {
  local ref="$1" last="${1##*/}"
  echo "public.ecr.aws/supabase/$last"
  echo "ghcr.io/supabase/$last"
  echo "$ref"
}

retry() { local i; for i in 1 2 3 4 5; do "$@" && return 0; sleep $((i * 5)); done; return 1; }

mirror() {
  local ref src dst ok
  for ref in $(list); do
    dst="$MIRROR/supabase/${ref##*/}"
    ok=""
    for src in $(sources_for "$ref"); do
      # a manifest-list copy: same digest, every platform, no layers on the runner
      if retry docker buildx imagetools create --tag "$dst" "$src" >/dev/null 2>&1; then
        echo "mirrored $src -> $dst ($(docker buildx imagetools inspect "$dst" --format '{{json .Manifest.Digest}}'))"
        ok=1; break
      fi
    done
    [ -n "$ok" ] || { echo "::error::could not mirror $ref from any source"; exit 1; }
  done
  for ref in $EXTRA; do
    # the e2e object store: kept under its own name, outside supabase/
    dst="$MIRROR/${ref##*/}"
    retry docker buildx imagetools create --tag "$dst" "$ref" >/dev/null 2>&1 \
      || { echo "::error::could not mirror $ref"; exit 1; }
    echo "mirrored $ref -> $dst ($(docker buildx imagetools inspect "$dst" --format '{{json .Manifest.Digest}}'))"
  done
}

# In a CI job: log in to GHCR with the job's GITHUB_TOKEN and, when every
# mirrored image resolves, export CI_IMAGE_MIRROR=$MIRROR (and RUSTFS_IMAGE)
# to $GITHUB_ENV; the start step then sets SUPABASE_INTERNAL_IMAGE_REGISTRY to
# it. Otherwise neither is set and the job keeps the CLI's own ECR/GHCR/Docker
# Hub fallback, exactly as before.
use() {
  local ref missing=""
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    echo "$GITHUB_TOKEN" | docker login ghcr.io -u "${GITHUB_ACTOR:-github-actions}" --password-stdin >/dev/null 2>&1 \
      || echo "::warning::ghcr.io login failed; using public registries"
  fi
  for ref in $(list); do
    docker buildx imagetools inspect "$MIRROR/supabase/${ref##*/}" >/dev/null 2>&1 || missing="$missing ${ref##*/}"
  done
  if [ -n "$missing" ]; then
    echo "::warning::CI image mirror is missing:$missing; using public registries (run the 'CI image mirror' workflow)"
    return 0
  fi
  # read by the start step (setup-cli also sets SUPABASE_INTERNAL_IMAGE_REGISTRY,
  # to ghcr.io, so the start step decides from this flag, not from that)
  echo "CI_IMAGE_MIRROR=$MIRROR" >> "${GITHUB_ENV:-/dev/null}"
  if docker buildx imagetools inspect "$MIRROR/rustfs:latest" >/dev/null 2>&1; then
    echo "RUSTFS_IMAGE=$MIRROR/rustfs:latest" >> "${GITHUB_ENV:-/dev/null}"
  fi
  echo "using CI image mirror $MIRROR"
}

case "${1:-}" in
  list) list ;;
  mirror) mirror ;;
  use) use ;;
  *) echo "usage: $0 list|mirror|use" >&2; exit 2 ;;
esac
