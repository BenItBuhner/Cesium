#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

if [[ "${PREFIX:-}" != *"com.termux"* ]]; then
  printf 'This installer must run inside Termux.\n' >&2
  exit 1
fi

REPO_URL="${CESIUM_REPO_URL:-https://github.com/BenItBuhner/Cesium.git}"
REPO_BRANCH="${CESIUM_REPO_BRANCH:-main}"
CESIUM_HOME="${CESIUM_HOME:-$HOME/.local/share/cesium}"
SOURCE_DIR="$CESIUM_HOME/source"
STATE_DIR="$HOME/.local/state/cesium"
PROJECTS_DIR="$HOME/projects"
SERVICE_DIR="$PREFIX/var/service/cesium"
LOG_DIR="$PREFIX/var/log/sv/cesium"

# Termux is rolling-release. Partial upgrades break curl/openssl linkage
# (CANNOT LINK EXECUTABLE "curl" / SSL_set_quic_tls_transport_params).
# pkg itself depends on curl, so repair with apt — which does not.
ensure_termux_packages_ready() {
  if ! command -v apt >/dev/null 2>&1; then
    printf 'Termux apt is missing. Reinstall Termux from F-Droid and retry.\n' >&2
    exit 1
  fi
  if ! apt update; then
    printf 'apt update failed. Select a mirror, then retry:\n' >&2
    printf '  termux-change-repo\n' >&2
    printf '  apt update && apt full-upgrade -y\n' >&2
    exit 1
  fi
  DEBIAN_FRONTEND=noninteractive apt full-upgrade -y
}

ensure_curl_works() {
  if ! command -v curl >/dev/null 2>&1 || ! curl --version >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt install -y curl
  fi
  if ! curl --version >/dev/null 2>&1; then
    printf 'curl is still broken after package repair.\n' >&2
    printf 'Run these, then retry this installer:\n' >&2
    printf '  termux-change-repo\n' >&2
    printf '  apt update && apt full-upgrade -y\n' >&2
    exit 1
  fi
}

if [[ "${CESIUM_SKIP_PACKAGE_UPDATE:-0}" != "1" ]]; then
  ensure_termux_packages_ready
fi
ensure_curl_works

DEBIAN_FRONTEND=noninteractive apt install -y \
  clang \
  curl \
  git \
  jq \
  make \
  nodejs-lts \
  pkg-config \
  python \
  termux-services

mkdir -p "$CESIUM_HOME" "$STATE_DIR" "$PROJECTS_DIR/default"
if [[ -d "$SOURCE_DIR/.git" ]]; then
  git -C "$SOURCE_DIR" fetch origin "$REPO_BRANCH"
  git -C "$SOURCE_DIR" checkout "$REPO_BRANCH"
  git -C "$SOURCE_DIR" pull --ff-only origin "$REPO_BRANCH"
else
  git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$SOURCE_DIR"
fi

cd "$SOURCE_DIR"

# Android/Termux cannot build node-pty (requires android_ndk_path) or download
# desktop browser binaries. Skip optional native addons and lifecycle scripts.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export PUPPETEER_SKIP_DOWNLOAD=1
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export npm_config_ignore_scripts=true
export npm_config_fund=false
export npm_config_audit=false

# Lean on-device install: only @cesium/core + cesium-server.
# Do NOT run root `npm ci` (pulls the full monorepo) or a second
# `npm ci --prefix server` against a stale nested lockfile — npm 11 on Termux
# rejects that out-of-sync lock with EUSAGE.
printf 'Installing @cesium/core...\n'
(
  cd packages/core
  npm install --no-workspaces --omit=optional
  npm run build
)
if [[ ! -f packages/core/dist/index.js ]]; then
  printf 'Core build did not produce packages/core/dist/index.js.\n' >&2
  exit 1
fi

printf 'Installing cesium-server...\n'
(
  cd server
  # --no-workspaces: use server/package-lock.json in isolation (kept in sync
  # with server/package.json). --omit=optional skips node-pty's NDK build.
  npm ci --no-workspaces --omit=optional
  rm -f node_modules/cesium
  unset npm_config_ignore_scripts
  npm run build
)

# Only configure runit after a successful build so a failed compile cannot leave
# a service pointing at a missing server/dist/index.js.
if [[ ! -f "$SOURCE_DIR/server/dist/index.js" ]]; then
  printf 'Server build did not produce server/dist/index.js; aborting before enabling the service.\n' >&2
  exit 1
fi

mkdir -p "$SERVICE_DIR" "$SERVICE_DIR/log" "$LOG_DIR"
cat >"$SERVICE_DIR/run" <<RUN
#!$PREFIX/bin/sh
exec 2>&1
cd "$SOURCE_DIR"
export HOST=127.0.0.1
export PORT=9100
export NODE_ENV=production
export OPENCURSOR_STORAGE_DRIVER=legacy-json
export OPENCURSOR_DATA_DIR="$STATE_DIR"
export WORKSPACE_ALLOWED_ROOTS="$PROJECTS_DIR"
export WORKSPACE_ROOT="$PROJECTS_DIR/default"
exec "$PREFIX/bin/node" --max-old-space-size=2048 server/dist/index.js
RUN
chmod 700 "$SERVICE_DIR/run"
ln -sfn "$PREFIX/share/termux-services/svlogger" "$SERVICE_DIR/log/run"

# The manager owns all service lifecycle logic so there is exactly one robust
# implementation shared by this installer and later `cesium-server` calls. The
# path constants are baked in via an unquoted header heredoc; the logic below is
# a quoted heredoc so nothing is re-expanded at write time.
cat >"$PREFIX/bin/cesium-server" <<HEADER
#!$PREFIX/bin/bash
set -uo pipefail
PREFIX="$PREFIX"
SERVICE_DIR="$SERVICE_DIR"
SOURCE_DIR="$SOURCE_DIR"
STATE_DIR="$STATE_DIR"
PROJECTS_DIR="$PROJECTS_DIR"
LOG_DIR="$LOG_DIR"
export SVDIR="$PREFIX/var/service"
HEADER
cat >>"$PREFIX/bin/cesium-server" <<'BODY'

_port_healthy() { curl -fsS "http://127.0.0.1:9100/health" >/dev/null 2>&1; }
_supervising() { pgrep -x runsvdir >/dev/null 2>&1; }
_direct_running() { pgrep -f "server/dist/index.js" >/dev/null 2>&1; }

# runit's runsvdir only starts at Termux login. During a first-run install (or
# any non-login shell) it may be absent, so `sv up` would fail with
# "unable to open supervise/ok". Start it if we can.
_ensure_runsvdir() {
  _supervising && return 0
  if [ -f "$PREFIX/etc/profile.d/start-services.sh" ]; then
    # shellcheck disable=SC1091
    . "$PREFIX/etc/profile.d/start-services.sh" >/dev/null 2>&1 || true
  fi
  _supervising && return 0
  command -v runsvdir >/dev/null 2>&1 || return 1
  setsid runsvdir "$SVDIR" >/dev/null 2>&1 &
  sleep 1
  _supervising
}

# runsv creates supervise/ok a moment after runsvdir first scans the service, so
# poll for it (up to ~20s) before `sv up` to avoid the race.
_wait_supervise() {
  i=0
  while [ "$i" -lt 40 ]; do
    [ -e "$SERVICE_DIR/supervise/ok" ] && return 0
    sleep 0.5
    i=$((i + 1))
  done
  return 1
}

# Fallback when runit supervision cannot be established in this session: launch
# the built server directly, detached, with the same environment as the service.
_direct_launch() {
  _direct_running && return 0
  mkdir -p "$STATE_DIR" "$PROJECTS_DIR/default" "$LOG_DIR"
  (
    cd "$SOURCE_DIR" || exit 1
    HOST=127.0.0.1 PORT=9100 NODE_ENV=production \
      OPENCURSOR_STORAGE_DRIVER=legacy-json \
      OPENCURSOR_DATA_DIR="$STATE_DIR" \
      WORKSPACE_ALLOWED_ROOTS="$PROJECTS_DIR" \
      WORKSPACE_ROOT="$PROJECTS_DIR/default" \
      setsid "$PREFIX/bin/node" --max-old-space-size=2048 server/dist/index.js \
        >"$LOG_DIR/direct.log" 2>&1 &
  )
}

start() {
  if _port_healthy; then
    printf 'Cesium is already running on http://127.0.0.1:9100\n'
    return 0
  fi
  rm -f "$SERVICE_DIR/down" 2>/dev/null || true
  sv-enable cesium >/dev/null 2>&1 || true
  if _ensure_runsvdir && _wait_supervise; then
    n=0
    while [ "$n" -lt 5 ]; do
      sv up cesium >/dev/null 2>&1 && break
      sleep 1
      n=$((n + 1))
    done
  else
    printf 'runit supervision is unavailable in this session; starting Cesium directly.\n' >&2
    _direct_launch
  fi
  n=0
  while [ "$n" -lt 15 ]; do
    _port_healthy && break
    sleep 1
    n=$((n + 1))
  done
  if _port_healthy; then
    printf 'Cesium is running on http://127.0.0.1:9100\n'
    return 0
  fi
  printf 'Cesium did not become healthy yet. Check: cesium-server logs\n' >&2
  return 1
}

stop() {
  sv down cesium >/dev/null 2>&1 || true
  pkill -f "server/dist/index.js" 2>/dev/null || true
}

logs() {
  f="$LOG_DIR/current"
  [ -f "$f" ] || f="$LOG_DIR/direct.log"
  [ -f "$f" ] || { printf 'No logs yet.\n' >&2; return 1; }
  tail -n 100 -f "$f"
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop; sleep 1; start ;;
  status)
    sv status cesium 2>/dev/null || true
    if _port_healthy; then printf 'health: ok\n'; else printf 'health: down\n'; fi
    ;;
  logs) logs ;;
  health) curl -fsS http://127.0.0.1:9100/health ;;
  update) CESIUM_SKIP_PACKAGE_UPDATE=1 "$SOURCE_DIR/apps/mobile/termux/install-cesium-server.sh" ;;
  remove)
    stop
    rm -rf "$SERVICE_DIR" "$STATE_DIR"
    printf 'Cesium service and state removed. Source remains at %s\n' "$SOURCE_DIR"
    ;;
  *) printf 'Usage: cesium-server {start|stop|restart|status|logs|health|update|remove}\n' >&2; exit 2 ;;
esac
BODY
chmod 700 "$PREFIX/bin/cesium-server"

# Bring it up through the manager (single robust path). Guarded by `if` so a
# transient bring-up failure surfaces guidance instead of aborting under set -e.
if "$PREFIX/bin/cesium-server" start; then
  printf '\nCesium server installed and running.\n'
  printf 'Server: http://127.0.0.1:9100\n'
  printf 'Workspace: %s\n' "$PROJECTS_DIR/default"
  printf 'Manage: cesium-server {start|stop|restart|status|logs|health|update}\n'
  printf 'Note: integrated terminals need Bun.Terminal; node-pty is skipped on Termux.\n'
else
  printf '\nCesium built successfully but the service did not come up in this session.\n' >&2
  printf 'This is usually because Termux had just installed the runit supervisor.\n' >&2
  printf 'Fully close and reopen Termux (starts runsvdir), then run:\n' >&2
  printf '  cesium-server start\n' >&2
  printf 'Logs: cesium-server logs\n' >&2
  exit 1
fi
