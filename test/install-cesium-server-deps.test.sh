#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

CESIUM_INSTALLER_SOURCE_ONLY=1
# shellcheck source=../scripts/install-cesium-server.sh
source "$ROOT_DIR/scripts/install-cesium-server.sh"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

# A fake bun that records each invocation's arguments and whose per-call exit
# status is scripted through a counter file. This keeps the test deterministic
# and offline - no real dependency resolution runs.
make_fake_bun() {
  local dir="$1"
  shift
  local bin="$dir/bun"
  : >"$dir/bun-calls.log"
  printf '0' >"$dir/bun-attempts"
  # Remaining args are the exit codes to return on successive `install` calls.
  printf '%s\n' "$@" >"$dir/bun-exit-codes"
  cat >"$bin" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${FAKE_BUN_LOG:?}"
if [[ "$1" != "install" ]]; then
  exit 0
fi
attempt="$(cat "${FAKE_BUN_ATTEMPTS:?}")"
next=$((attempt + 1))
printf '%s' "$next" >"$FAKE_BUN_ATTEMPTS"
code="$(sed -n "${next}p" "${FAKE_BUN_EXITS:?}")"
exit "${code:-0}"
FAKE
  chmod +x "$bin"
  printf '%s' "$bin"
}

new_source_tree() {
  local dir="$1"
  mkdir -p "$dir/server/node_modules" "$dir/packages/core" "$dir/packages/contracts"
}

# --- clean_nested_workspace_copies drops exactly the stale copies -----------
copies_case="$TEST_ROOT/copies"
new_source_tree "$copies_case"
mkdir -p "$copies_case/server/node_modules/@cesium/core/dist" \
  "$copies_case/server/node_modules/cesium" \
  "$copies_case/server/node_modules/hono"
printf 'stale\n' >"$copies_case/server/node_modules/@cesium/core/dist/index.js"
clean_nested_workspace_copies "$copies_case"
[[ ! -e "$copies_case/server/node_modules/@cesium" ]] ||
  fail "stale server/node_modules/@cesium was not removed"
[[ ! -e "$copies_case/server/node_modules/cesium" ]] ||
  fail "stale server/node_modules/cesium was not removed"
[[ -d "$copies_case/server/node_modules/hono" ]] ||
  fail "cleanup must not touch unrelated dependencies"

# --- happy path: one install, no --force, stale copies pre-cleaned ----------
ok_case="$TEST_ROOT/ok"
new_source_tree "$ok_case"
mkdir -p "$ok_case/server/node_modules/@cesium/core"
printf 'stale\n' >"$ok_case/server/node_modules/@cesium/core/old.js"
ok_bun="$(make_fake_bun "$ok_case" 0)"
FAKE_BUN_LOG="$ok_case/bun-calls.log" \
  FAKE_BUN_ATTEMPTS="$ok_case/bun-attempts" \
  FAKE_BUN_EXITS="$ok_case/bun-exit-codes" \
  install_server_dependencies "$ok_bun" "$ok_case" ||
  fail "install_server_dependencies failed on the happy path"
ok_calls="$(grep -c '^install ' "$ok_case/bun-calls.log")"
[[ "$ok_calls" == "1" ]] || fail "expected exactly one install on the happy path, saw $ok_calls"
if grep -q -- '--force' "$ok_case/bun-calls.log"; then
  fail "the first install attempt must not pass --force"
fi
[[ ! -e "$ok_case/server/node_modules/@cesium/core/old.js" ]] ||
  fail "stale @cesium copy was not cleaned before install"

# --- recovery: first install fails, retry with --force succeeds -------------
retry_case="$TEST_ROOT/retry"
new_source_tree "$retry_case"
retry_bun="$(make_fake_bun "$retry_case" 1 0)"
FAKE_BUN_LOG="$retry_case/bun-calls.log" \
  FAKE_BUN_ATTEMPTS="$retry_case/bun-attempts" \
  FAKE_BUN_EXITS="$retry_case/bun-exit-codes" \
  install_server_dependencies "$retry_bun" "$retry_case" ||
  fail "install_server_dependencies did not recover after a first-attempt failure"
retry_calls="$(grep -c '^install ' "$retry_case/bun-calls.log")"
[[ "$retry_calls" == "2" ]] || fail "expected two install attempts on recovery, saw $retry_calls"
sed -n '1p' "$retry_case/bun-calls.log" | grep -q -- '--force' &&
  fail "the first attempt must not use --force"
sed -n '2p' "$retry_case/bun-calls.log" | grep -q -- '--force' ||
  fail "the retry attempt must bypass the cache with --force"

# --- fail-fast: bun always fails -> non-zero with an actionable message -----
fail_case="$TEST_ROOT/fail"
new_source_tree "$fail_case"
fail_bun="$(make_fake_bun "$fail_case" 1 1)"
set +e
message="$(
  FAKE_BUN_LOG="$fail_case/bun-calls.log" \
    FAKE_BUN_ATTEMPTS="$fail_case/bun-attempts" \
    FAKE_BUN_EXITS="$fail_case/bun-exit-codes" \
    install_server_dependencies "$fail_bun" "$fail_case" 2>&1
)"
status=$?
set -e
[[ "$status" -ne 0 ]] || fail "install_server_dependencies must return non-zero when bun keeps failing"
[[ "$message" == *"Failed to install Cesium server dependencies"* ]] ||
  fail "a persistent failure must print a clear, actionable message"
[[ "$message" == *"pm cache rm"* ]] ||
  fail "the failure guidance should mention clearing the bun cache"
fail_calls="$(grep -c '^install ' "$fail_case/bun-calls.log")"
[[ "$fail_calls" == "2" ]] || fail "expected one retry before giving up, saw $fail_calls attempts"

printf 'PASS: Cesium installer dependency-install tests\n'
