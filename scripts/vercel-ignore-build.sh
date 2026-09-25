#!/usr/bin/env bash
# Vercel "Ignored Build Step" for the root Next.js deployment.
#
# Exit 0  -> skip this deployment (nothing the web build consumes changed).
# Exit 1  -> build.
#
# Fails open: any doubt (unreachable base, shallow clone that cannot be
# deepened, unknown branch state) results in a build. Production (main)
# always builds.
#
# The diff base is, in order:
#   1. VERCEL_GIT_PREVIOUS_SHA - the last successful deployment of this
#      branch, when Vercel provides one.
#   2. The merge base with the production branch. This covers the first push
#      of every branch (no previous deployment yet), which used to build
#      unconditionally even when the branch only touched server/, apps/,
#      scripts/, .github/ or tests. Cloud-agent branches are short-lived and
#      cut from a recent main, so the merge base is normally within a few
#      dozen commits; the shallow clone is deepened in bounded steps to find it.
set -u

log() { printf '[vercel-ignore-build] %s\n' "$*" >&2; }

ref="${VERCEL_GIT_COMMIT_REF:-}"
prev="${VERCEL_GIT_PREVIOUS_SHA:-}"
head="${VERCEL_GIT_COMMIT_SHA:-HEAD}"
production_branch="${CESIUM_PRODUCTION_BRANCH:-main}"
remote="${CESIUM_GIT_REMOTE:-origin}"
# Each deepening round pulls this many more commits per side; four rounds
# (200 commits) covers any branch that is not badly stale against main.
deepen_step=50
deepen_rounds=4

if [ "${VERCEL_ENV:-}" = "production" ] || [ "$ref" = "$production_branch" ]; then
  log "production/$production_branch deployment - building"
  exit 1
fi

have_commit() {
  git cat-file -e "$1^{commit}" 2>/dev/null
}

# Make sure a SHA is present locally, deepening the shallow clone if needed.
ensure_commit() {
  local sha="$1" round=0
  have_commit "$sha" && return 0
  while [ "$round" -lt "$deepen_rounds" ]; do
    round=$((round + 1))
    git fetch --quiet --deepen="$deepen_step" "$remote" 2>/dev/null || true
    have_commit "$sha" && return 0
  done
  return 1
}

# Print the merge base between the production branch and $head, or fail.
merge_base_with_production() {
  local base round=0
  # A depth-1 fetch is enough when the branch was cut from the current tip;
  # deeper history is only pulled when the first attempt finds nothing.
  git fetch --quiet --depth=1 "$remote" "$production_branch" 2>/dev/null || return 1
  while :; do
    if base="$(git merge-base FETCH_HEAD "$head" 2>/dev/null)" && [ -n "$base" ]; then
      printf '%s' "$base"
      return 0
    fi
    [ "$round" -lt "$deepen_rounds" ] || return 1
    round=$((round + 1))
    git fetch --quiet --deepen="$deepen_step" "$remote" "$production_branch" 2>/dev/null || true
    git fetch --quiet --deepen="$deepen_step" "$remote" 2>/dev/null || true
  done
}

base=""
if [ -n "$prev" ]; then
  if ensure_commit "$prev"; then
    base="$prev"
  else
    log "previous SHA $prev not in clone - building"
    exit 1
  fi
else
  log "no VERCEL_GIT_PREVIOUS_SHA (first deployment of this branch) - comparing against $production_branch"
  if ! base="$(merge_base_with_production)"; then
    log "no merge base with $production_branch reachable from this clone - building"
    exit 1
  fi
fi

changed="$(git diff --name-only "$base" "$head" 2>/dev/null)" || {
  log "git diff failed - building"
  exit 1
}

if [ -z "$changed" ]; then
  log "no file changes between $base and $head - skipping"
  exit 0
fi

# Everything the root `next build` reads. Keep in sync with tsconfig.json
# `include` and next.config.ts.
web_paths='^(src/|convex/|public/|packages/(core|contracts|sdk|browser-machine|client|design|ui-web|config)/|scripts/vercel-(ignore-build\.sh|build\.mjs)$|next\.config\.ts$|next-env\.d\.ts$|tsconfig\.json$|package\.json$|package-lock\.json$|vercel\.json$|postcss\.config\.mjs$|\.npmrc$|\.env(\..*)?$)'

relevant="$(printf '%s\n' "$changed" | grep -E "$web_paths" || true)"

if [ -n "$relevant" ]; then
  log "web-relevant changes detected - building:"
  printf '%s\n' "$relevant" | sed 's/^/  /' >&2
  exit 1
fi

log "only non-web paths changed ($(printf '%s\n' "$changed" | wc -l | tr -d ' ') files) - skipping"
exit 0
