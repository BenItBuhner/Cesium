#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_equal() {
  [[ "$2" == "$1" ]] || fail "$3 (expected '$1', got '$2')"
}

(
  CESIUM_INSTALLER_SOURCE_ONLY=1
  # shellcheck source=../scripts/install-cesium-server.sh
  source "$ROOT_DIR/scripts/install-cesium-server.sh"
  convex="https://insightful-wolverine-140.convex.site/rendezvous"
  site="https://cesium.techlitnow.com"
  assert_equal "$convex" \
    "$(migrate_legacy_rendezvous_url "$site/api/rendezvous" "$site" "$convex")" \
    "the old account-site registry moves to Convex"
  assert_equal "$convex" \
    "$(migrate_legacy_rendezvous_url "https://www.cesium.techlitnow.com/api/rendezvous/" "$site" "$convex")" \
    "the www host and a trailing slash are recognized"
  assert_equal "$convex" \
    "$(migrate_legacy_rendezvous_url "https://cesium.techlitnow.com/api/rendezvous" "https://other.example" "$convex")" \
    "the production site is recognized even when the default web URL is overridden"
  assert_equal "https://cesium.example/api/rendezvous" \
    "$(migrate_legacy_rendezvous_url "https://cesium.example/api/rendezvous" "$site" "$convex")" \
    "a self-hosted registry is kept"
  assert_equal "$convex" "$(migrate_legacy_rendezvous_url "$convex" "$site" "$convex")" \
    "an already migrated registry is unchanged"
  assert_equal "" "$(migrate_legacy_rendezvous_url "" "$site" "$convex")" \
    "an empty registry stays empty"
  assert_equal "300" "$(migrate_legacy_rendezvous_interval 15)" "the 15 s legacy heartbeat moves to 5 min"
  assert_equal "300" "$(migrate_legacy_rendezvous_interval 30)" "the 30 s legacy heartbeat moves to 5 min"
  assert_equal "300" "$(migrate_legacy_rendezvous_interval "")" "an unset heartbeat defaults to 5 min"
  assert_equal "600" "$(migrate_legacy_rendezvous_interval 600)" "a custom heartbeat is kept"
)

# `cesium-server update` must run the installer from the latest upstream
# commit, not the copy already checked out.
UPSTREAM="$TEST_ROOT/upstream"
mkdir -p "$UPSTREAM/scripts"
git -C "$UPSTREAM" init --quiet --initial-branch=main
git -C "$UPSTREAM" config user.email test@example.com
git -C "$UPSTREAM" config user.name test
printf '#!/usr/bin/env bash\nprintf "stale installer\\n"\n' >"$UPSTREAM/scripts/install-cesium-server.sh"
chmod +x "$UPSTREAM/scripts/install-cesium-server.sh"
git -C "$UPSTREAM" add -A
git -C "$UPSTREAM" commit --quiet -m one

CESIUM_HOME="$TEST_ROOT/home"
mkdir -p "$CESIUM_HOME"
git clone --quiet --depth 1 --branch main "file://$UPSTREAM" "$CESIUM_HOME/source"

cat >"$UPSTREAM/scripts/install-cesium-server.sh" <<'EOF'
#!/usr/bin/env bash
printf 'fresh installer rendezvous=%s branch=%s\n' "$CESIUM_RENDEZVOUS_URL" "$CESIUM_REPO_BRANCH"
EOF
git -C "$UPSTREAM" commit --quiet -am two

cat >"$CESIUM_HOME/server.env" <<EOF
CESIUM_SOURCE_DIR=$CESIUM_HOME/source
CESIUM_BUN_BIN=/bin/false
CESIUM_RENDEZVOUS_URL=https://cesium.techlitnow.com/api/rendezvous
HOST=127.0.0.1
PORT=19101
EOF

output="$(
  export CESIUM_HOME
  # shellcheck source=../scripts/cesium-server
  source "$ROOT_DIR/scripts/cesium-server"
  stop_managed_service() { :; }
  update_install
)"
[[ "$output" == "fresh installer rendezvous=https://cesium.techlitnow.com/api/rendezvous branch=main" ]] ||
  fail "update did not run the latest upstream installer: $output"
assert_equal "two" "$(git -C "$CESIUM_HOME/source" log -1 --format=%s FETCH_HEAD)" \
  "update fetched the latest upstream commit"
assert_equal "one" "$(git -C "$CESIUM_HOME/source" log -1 --format=%s HEAD)" \
  "fetching the installer leaves the checkout for the installer to update"

# Offline: fall back to the checked-out installer instead of failing.
output="$(
  export CESIUM_HOME
  # shellcheck source=../scripts/cesium-server
  source "$ROOT_DIR/scripts/cesium-server"
  stop_managed_service() { :; }
  git -C "$SOURCE_DIR" remote set-url origin "file://$TEST_ROOT/missing"
  update_install 2>/dev/null
)"
assert_equal "stale installer" "$output" \
  "an unreachable upstream falls back to the checked-out installer"

printf 'PASS: Cesium installer update tests\n'
