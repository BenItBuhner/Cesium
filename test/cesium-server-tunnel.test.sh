#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_HOME="$(mktemp -d)"
TEST_PROCESS_PID=""

cleanup() {
  if [[ -n "$TEST_PROCESS_PID" ]] && kill -0 "$TEST_PROCESS_PID" 2>/dev/null; then
    kill "$TEST_PROCESS_PID"
    wait "$TEST_PROCESS_PID" 2>/dev/null || true
  fi
  rm -rf "$TEST_HOME"
}
trap cleanup EXIT

cat >"$TEST_HOME/server.env" <<EOF
CESIUM_SOURCE_DIR=$ROOT_DIR
CESIUM_BUN_BIN=/bin/false
CESIUM_CLOUDFLARED_BIN=/tmp/cloudflared-test
CESIUM_SSH_BIN=/usr/bin/ssh
CESIUM_WEB_URL=https://cesium-test.vercel.app
CESIUM_TUNNEL_ENABLED=1
CESIUM_TUNNEL_REQUIRED=1
CESIUM_TUNNEL_PROVIDER=auto
CESIUM_TUNNEL_TOKEN=''
CESIUM_PUBLIC_URL=''
HOST=127.0.0.1
PORT=19100
OPENCURSOR_AUTH_USERNAME=cesium
OPENCURSOR_AUTH_PASSWORD=test-password
WORKSPACE_ROOT=/workspace
EOF

CESIUM_HOME="$TEST_HOME"
# shellcheck source=../scripts/cesium-server
source "$ROOT_DIR/scripts/cesium-server"

assert_equal() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    printf 'FAIL: %s\nExpected: %s\nActual: %s\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
}

CESIUM_TUNNEL_TOKEN="test-token"
assert_equal "cloudflare-named" "$(resolve_tunnel_provider)" \
  "a token always selects a named Cloudflare tunnel"
CESIUM_TUNNEL_TOKEN=""

CESIUM_TUNNEL_PROVIDER="auto"
find_ssh() { printf '/usr/bin/ssh'; }
assert_equal "localhost-run" "$(resolve_tunnel_provider)" \
  "auto prefers localhost.run when ssh is available"

find_ssh() { return 1; }
assert_equal "cloudflare-quick" "$(resolve_tunnel_provider)" \
  "auto falls back to Cloudflare Quick Tunnel without ssh"

CESIUM_TUNNEL_PROVIDER="cloudflare-quick"
assert_equal "cloudflare-quick" "$(resolve_tunnel_provider)" \
  "Cloudflare Quick Tunnel can be selected explicitly"

printf '%s\n' \
  'Manage at https://admin.localhost.run/' \
  'Connect to https://stale-first.lhr.life with this tunnel' \
  'Assigned remote URL https://current-second.lhr.life after rotation' >"$TUNNEL_LOG"
assert_equal "https://current-second.lhr.life" \
  "$(extract_tunnel_url localhost-run)" \
  "the latest assigned localhost.run URL is parsed after rotation"

printf '%s\n' \
  'Visit https://sample-quick-tunnel.trycloudflare.com now' >"$TUNNEL_LOG"
assert_equal "https://sample-quick-tunnel.trycloudflare.com" \
  "$(extract_tunnel_url cloudflare-quick)" \
  "Cloudflare Quick Tunnel URL is parsed"

bash -c 'exec -a "ssh -R 80:127.0.0.1:19100 nokey@localhost.run" sleep 30' &
TEST_PROCESS_PID="$!"
printf '%s\n' "$TEST_PROCESS_PID" >"$TUNNEL_PID_FILE"
printf '%s\n' "localhost-run" >"$TUNNEL_PROVIDER_FILE"
printf '%s\n' \
  'Connect to https://stale-first.lhr.life with this tunnel' \
  'Assigned remote URL https://current-second.lhr.life after rotation' >"$TUNNEL_LOG"
printf '%s\n' "https://stale-first.lhr.life" >"$PUBLIC_URL_FILE"
curl() {
  local url="${!#}"
  [[ "$url" == *"current-second.lhr.life/health"* ]] && printf '{"ok":true}'
}

if ! tunnel_is_running; then
  printf 'FAIL: PID-scoped localhost.run process was not detected\n' >&2
  exit 1
fi
original_tunnel_pid="$(<"$TUNNEL_PID_FILE")"
start_tunnel
run_output="$(print_connection_details)"
[[ "$run_output" == *"Connect: https://cesium-test.vercel.app?serverUrl=https%3A%2F%2Fcurrent-second.lhr.life"* ]] || {
  printf 'FAIL: run did not use the latest healthy public URL\n%s\n' "$run_output" >&2
  exit 1
}
assert_equal "$original_tunnel_pid" "$(<"$TUNNEL_PID_FILE")" \
  "run reuses the live tunnel PID during hostname rotation"

printf '%s\n' "https://stale-first.lhr.life" >"$PUBLIC_URL_FILE"
status_output="$(status)"
[[ "$status_output" == *"Tunnel: running (localhost-run, https://current-second.lhr.life)"* ]] || {
  printf 'FAIL: status did not refresh to the latest healthy URL\n%s\n' "$status_output" >&2
  exit 1
}

printf '%s\n' "https://stale-first.lhr.life" >"$PUBLIC_URL_FILE"
connect_output="$(print_connection_details)"
[[ "$connect_output" == *"Connect: https://cesium-test.vercel.app?serverUrl=https%3A%2F%2Fcurrent-second.lhr.life"* ]] || {
  printf 'FAIL: connection details did not use the latest healthy public URL\n%s\n' "$connect_output" >&2
  exit 1
}
assert_equal "https://current-second.lhr.life" \
  "$(<"$PUBLIC_URL_FILE")" \
  "the rotated healthy URL is persisted"

printf '%s\n' \
  'Assigned remote URL https://newest-unhealthy.lhr.life after rotation' >>"$TUNNEL_LOG"
assert_equal "https://newest-unhealthy.lhr.life" \
  "$(extract_tunnel_url localhost-run)" \
  "the newest advertised localhost.run URL remains discoverable"
assert_equal "https://current-second.lhr.life" \
  "$(public_url)" \
  "an unhealthy newer assignment does not replace the latest healthy URL"

stop_tunnel
if kill -0 "$TEST_PROCESS_PID" 2>/dev/null; then
  printf 'FAIL: stop_tunnel did not stop its recorded PID\n' >&2
  exit 1
fi
TEST_PROCESS_PID=""

PUBLIC_HEALTH_TIMEOUT=1
curl() { printf '<html>not Cesium</html>'; }
if wait_for_public_health "https://example.invalid" >/dev/null 2>&1; then
  printf 'FAIL: an unrelated HTTP 200 response passed the health check\n' >&2
  exit 1
fi
curl() { printf '{"ok":true}'; }
if ! wait_for_public_health "https://example.invalid"; then
  printf 'FAIL: the Cesium health payload did not pass the health check\n' >&2
  exit 1
fi

printf 'PASS: Cesium tunnel provider tests\n'
