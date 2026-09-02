#!/usr/bin/env bash
# Vercel "Ignored Build Step" for the root Next.js deployment.
#
# Exit 0  -> skip this deployment (nothing the web build consumes changed).
# Exit 1  -> build.
#
# Fails open: any doubt (missing SHAs, shallow clone, unknown branch state)
# results in a build. Production (main) always builds.
set -u

log() { printf '[vercel-ignore-build] %s\n' "$*" >&2; }

ref="${VERCEL_GIT_COMMIT_REF:-}"
prev="${VERCEL_GIT_PREVIOUS_SHA:-}"
head="${VERCEL_GIT_COMMIT_SHA:-HEAD}"

if [ "${VERCEL_ENV:-}" = "production" ] || [ "$ref" = "main" ]; then
  log "production/main deployment - building"
  exit 1
fi

if [ -z "$prev" ]; then
  log "no VERCEL_GIT_PREVIOUS_SHA (first deployment of this branch) - building"
  exit 1
fi

if ! git cat-file -e "$prev^{commit}" 2>/dev/null; then
  # Vercel clones are shallow; try to deepen just enough to see the previous SHA.
  git fetch --quiet --deepen=50 origin 2>/dev/null || true
  if ! git cat-file -e "$prev^{commit}" 2>/dev/null; then
    log "previous SHA $prev not in clone - building"
    exit 1
  fi
fi

changed="$(git diff --name-only "$prev" "$head" 2>/dev/null)" || {
  log "git diff failed - building"
  exit 1
}

if [ -z "$changed" ]; then
  log "no file changes between $prev and $head - skipping"
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
