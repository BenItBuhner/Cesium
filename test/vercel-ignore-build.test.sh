#!/usr/bin/env bash
# Exercises scripts/vercel-ignore-build.sh against a throwaway git remote the
# way Vercel runs it: a shallow clone of the pushed branch plus the
# VERCEL_GIT_* environment. Exit 0 from the script means "skip the build",
# exit 1 means "build".
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/vercel-ignore-build.sh"
TEST_HOME="$(mktemp -d)"
trap 'rm -rf "$TEST_HOME"' EXIT

REMOTE="$TEST_HOME/remote.git"
SEED="$TEST_HOME/seed"
failures=0

# Commit signing (if configured on the machine) is slow and irrelevant here.
git_quiet() { git -c init.defaultBranch=main -c commit.gpgsign=false "$@" >/dev/null 2>&1; }

commit_file() {
  # commit_file <repo> <path> <message>
  local repo="$1" path="$2" message="$3"
  mkdir -p "$repo/$(dirname "$path")"
  printf '%s %s\n' "$message" "$RANDOM" >>"$repo/$path"
  git -C "$repo" add -A >/dev/null
  git -C "$repo" -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false \
    commit -q -m "$message" >/dev/null
}

# A remote with a long main history so shallow clones really are shallow.
git_quiet init --bare "$REMOTE"
git_quiet init "$SEED"
git -C "$SEED" remote add origin "$REMOTE"
for i in $(seq 1 60); do
  commit_file "$SEED" "src/app/page.tsx" "main $i"
  commit_file "$SEED" "server/src/index.ts" "server $i"
done
git -C "$SEED" push -q origin main

# make_branch <name> <path...>: cut <name> from main's tip, one commit per path.
make_branch() {
  local name="$1"
  shift
  git -C "$SEED" checkout -q main
  git -C "$SEED" checkout -q -b "$name"
  local path
  for path in "$@"; do
    commit_file "$SEED" "$path" "branch $name touches $path"
  done
  git -C "$SEED" push -q origin "$name"
  git -C "$SEED" checkout -q main
}

# shallow_clone <branch>: what Vercel hands the ignore step. Prints the path.
shallow_clone() {
  local branch="$1"
  local dir="$TEST_HOME/clone-$branch-$RANDOM"
  # file:// makes git honour --depth for a local remote (a bare path does not).
  git_quiet clone --quiet --depth=10 --single-branch --branch "$branch" "file://$REMOTE" "$dir"
  printf '%s' "$dir"
}

# run_case <expected-exit> <label> <clone-dir> [VAR=value ...]
run_case() {
  local expected="$1" label="$2" dir="$3"
  shift 3
  local actual=0
  (
    cd "$dir"
    env -i PATH="$PATH" HOME="$TEST_HOME" \
      VERCEL_GIT_COMMIT_REF="$(git rev-parse --abbrev-ref HEAD)" \
      VERCEL_GIT_COMMIT_SHA="$(git rev-parse HEAD)" \
      "$@" bash "$SCRIPT" >/dev/null 2>"$TEST_HOME/last.log"
  ) || actual=$?
  if [[ "$actual" != "$expected" ]]; then
    printf 'FAIL: %s\nExpected exit %s, got %s\n' "$label" "$expected" "$actual" >&2
    sed 's/^/  /' "$TEST_HOME/last.log" >&2
    failures=$((failures + 1))
  else
    printf 'ok - %s\n' "$label"
  fi
}

# --- production always builds -------------------------------------------------
main_clone="$(shallow_clone main)"
run_case 1 "production environment builds" "$main_clone" VERCEL_ENV=production
run_case 1 "main branch builds even without VERCEL_ENV" "$main_clone"

# --- first push of a branch: merge base with main decides --------------------
make_branch server-only "server/src/lib/thing.ts" "apps/mobile/App.tsx" ".github/workflows/ci.yml" "test/foo.test.ts"
run_case 0 "first push touching only server/apps/.github/test skips" "$(shallow_clone server-only)"

make_branch web-change "server/src/lib/thing.ts" "src/components/Thing.tsx"
run_case 1 "first push touching src/ builds" "$(shallow_clone web-change)"

make_branch shared-package "packages/core/src/protocol.ts"
run_case 1 "first push touching a shared workspace package builds" "$(shallow_clone shared-package)"

make_branch cli-package "packages/cli/bin/cesium.mjs" "scripts/install-cesium-server.sh"
run_case 0 "first push touching packages/cli and installer scripts skips" "$(shallow_clone cli-package)"

make_branch build-scripts "scripts/vercel-build.mjs"
run_case 1 "first push touching the Vercel build script builds" "$(shallow_clone build-scripts)"

make_branch nested-manifest "server/package.json" "apps/desktop/package.json"
run_case 0 "first push touching nested package.json files skips" "$(shallow_clone nested-manifest)"

make_branch empty-branch
run_case 0 "first push of a branch identical to main skips" "$(shallow_clone empty-branch)"

# A branch whose base is deep in main's history: depth-10 clone cannot see the
# merge base without deepening.
git -C "$SEED" checkout -q -b stale-branch "main~45"
commit_file "$SEED" "server/src/stale.ts" "stale server change"
git -C "$SEED" push -q origin stale-branch
git -C "$SEED" checkout -q main
run_case 0 "first push of a stale branch finds the merge base after deepening" "$(shallow_clone stale-branch)"

# --- previous deployment SHA present ------------------------------------------
make_branch two-pushes "server/src/first.ts"
prev_sha="$(git -C "$SEED" rev-parse two-pushes)"
git -C "$SEED" checkout -q two-pushes
commit_file "$SEED" "apps/desktop/main.ts" "second push, desktop only"
git -C "$SEED" push -q origin two-pushes
git -C "$SEED" checkout -q main
run_case 0 "second push touching only apps/ skips against the previous SHA" \
  "$(shallow_clone two-pushes)" VERCEL_GIT_PREVIOUS_SHA="$prev_sha"

git -C "$SEED" checkout -q two-pushes
commit_file "$SEED" "public/manifest.json" "third push, public asset"
git -C "$SEED" push -q origin two-pushes
git -C "$SEED" checkout -q main
run_case 1 "third push touching public/ builds against the previous SHA" \
  "$(shallow_clone two-pushes)" VERCEL_GIT_PREVIOUS_SHA="$prev_sha"

# A previous SHA far behind the depth-10 clone must be reached by deepening.
old_prev="$(git -C "$SEED" rev-parse "main~40")"
make_branch deep-prev "server/src/deep.ts"
run_case 1 "unreachable-looking previous SHA is deepened into, web history builds" \
  "$(shallow_clone deep-prev)" VERCEL_GIT_PREVIOUS_SHA="$old_prev"

# --- failure modes fail open --------------------------------------------------
run_case 1 "unknown previous SHA builds" "$(shallow_clone server-only)" \
  VERCEL_GIT_PREVIOUS_SHA="0000000000000000000000000000000000000000"

run_case 1 "unreachable remote on a first push builds" "$(shallow_clone server-only)" \
  CESIUM_GIT_REMOTE=nowhere

# --- regression: the merge-base path must never consider main's own churn ----
# main moves on after the branch was cut; the branch still only touched server/.
commit_file "$SEED" "src/app/layout.tsx" "main keeps changing web files"
git -C "$SEED" push -q origin main
run_case 0 "later web changes on main do not force a build of a server-only branch" \
  "$(shallow_clone server-only)"

if [[ "$failures" -ne 0 ]]; then
  printf '%s case(s) failed\n' "$failures" >&2
  exit 1
fi
printf 'all vercel-ignore-build cases passed\n'
