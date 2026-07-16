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
DIRECT_PID_FILE="$STATE_DIR/cesium-server.pid"
DIRECT_LOG_FILE="$STATE_DIR/cesium-server.log"

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

# termux-services only works once runsvdir is alive. Fresh installs often have
# the package but no daemon yet → "unable to open supervise/ok".
ensure_runit_running() {
  export SVDIR="${SVDIR:-$PREFIX/var/service}"
  export LOGDIR="${LOGDIR:-$PREFIX/var/log}"
  mkdir -p "$SVDIR" "$LOGDIR"

  if [[ -f "$PREFIX/etc/profile.d/start-services.sh" ]]; then
    # shellcheck disable=SC1091
    source "$PREFIX/etc/profile.d/start-services.sh" || true
  fi

  if ! pgrep -f "runsvdir.*${SVDIR}" >/dev/null 2>&1; then
    if command -v service-daemon >/dev/null 2>&1; then
      service-daemon start >/dev/null 2>&1 || true
    fi
  fi

  if ! pgrep -f "runsvdir.*${SVDIR}" >/dev/null 2>&1; then
    # Last-resort: start runsvdir ourselves (same SVDIR termux-services uses).
    nohup runsvdir -P "$SVDIR" >/dev/null 2>&1 &
    sleep 1
  fi

  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if pgrep -f "runsvdir.*${SVDIR}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

write_server_env_exports() {
  cat <<EOF
export HOST=127.0.0.1
export PORT=9100
export NODE_ENV=production
export OPENCURSOR_STORAGE_DRIVER=legacy-json
export OPENCURSOR_DATA_DIR="$STATE_DIR"
export WORKSPACE_ALLOWED_ROOTS="$PROJECTS_DIR"
export WORKSPACE_ROOT="$PROJECTS_DIR/default"
EOF
}

start_server_direct() {
  mkdir -p "$STATE_DIR"
  if [[ -f "$DIRECT_PID_FILE" ]]; then
    old_pid="$(cat "$DIRECT_PID_FILE" 2>/dev/null || true)"
    if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" 2>/dev/null; then
      kill "$old_pid" 2>/dev/null || true
      sleep 1
    fi
    rm -f "$DIRECT_PID_FILE"
  fi

  (
    cd "$SOURCE_DIR"
    export HOST=127.0.0.1
    export PORT=9100
    export NODE_ENV=production
    export OPENCURSOR_STORAGE_DRIVER=legacy-json
    export OPENCURSOR_DATA_DIR="$STATE_DIR"
    export WORKSPACE_ALLOWED_ROOTS="$PROJECTS_DIR"
    export WORKSPACE_ROOT="$PROJECTS_DIR/default"
    nohup "$PREFIX/bin/node" --max-old-space-size=2048 server/dist/index.js \
      >>"$DIRECT_LOG_FILE" 2>&1 &
    echo $! >"$DIRECT_PID_FILE"
  )
  printf 'Started Cesium in direct mode (pid %s).\n' "$(cat "$DIRECT_PID_FILE")"
  printf 'Logs: %s\n' "$DIRECT_LOG_FILE"
}

wait_for_health() {
  local attempts="${1:-20}"
  local i
  for i in $(seq 1 "$attempts"); do
    if curl -fsS http://127.0.0.1:9100/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
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
  npm ci --no-workspaces --omit=optional
  rm -f node_modules/cesium
  unset npm_config_ignore_scripts
  npm run build
)

if [[ ! -f "$SOURCE_DIR/server/dist/index.js" ]]; then
  printf 'Server build did not produce server/dist/index.js; aborting before enabling the service.\n' >&2
  exit 1
fi

export SVDIR="${SVDIR:-$PREFIX/var/service}"
export LOGDIR="${LOGDIR:-$PREFIX/var/log}"
mkdir -p "$SERVICE_DIR" "$SERVICE_DIR/log" "$LOG_DIR"
cat >"$SERVICE_DIR/run" <<RUN
#!$PREFIX/bin/sh
exec 2>&1
cd "$SOURCE_DIR"
$(write_server_env_exports)
exec "$PREFIX/bin/node" --max-old-space-size=2048 server/dist/index.js
RUN
chmod 700 "$SERVICE_DIR/run"
ln -sfn "$PREFIX/share/termux-services/svlogger" "$SERVICE_DIR/log/run"
# Enabled by default (termux-services treats an existing "down" file as disabled).
rm -f "$SERVICE_DIR/down"

cat >"$PREFIX/bin/cesium-server" <<MANAGER
#!$PREFIX/bin/bash
set -euo pipefail
export SVDIR="\${SVDIR:-$PREFIX/var/service}"
export LOGDIR="\${LOGDIR:-$PREFIX/var/log}"
SOURCE_DIR="$SOURCE_DIR"
STATE_DIR="$STATE_DIR"
SERVICE_DIR="$SERVICE_DIR"
LOG_DIR="$LOG_DIR"
DIRECT_PID_FILE="$DIRECT_PID_FILE"
DIRECT_LOG_FILE="$DIRECT_LOG_FILE"

ensure_runit() {
  if [[ -f "$PREFIX/etc/profile.d/start-services.sh" ]]; then
    # shellcheck disable=SC1091
    source "$PREFIX/etc/profile.d/start-services.sh" || true
  fi
  if ! pgrep -f "runsvdir.*\${SVDIR}" >/dev/null 2>&1; then
    service-daemon start >/dev/null 2>&1 || true
  fi
  if ! pgrep -f "runsvdir.*\${SVDIR}" >/dev/null 2>&1; then
    nohup runsvdir -P "\$SVDIR" >/dev/null 2>&1 &
    sleep 1
  fi
}

start_direct() {
  mkdir -p "\$STATE_DIR"
  if [[ -f "\$DIRECT_PID_FILE" ]]; then
    old_pid="\$(cat "\$DIRECT_PID_FILE" 2>/dev/null || true)"
    if [[ -n "\${old_pid:-}" ]] && kill -0 "\$old_pid" 2>/dev/null; then
      kill "\$old_pid" 2>/dev/null || true
      sleep 1
    fi
  fi
  (
    cd "\$SOURCE_DIR"
    export HOST=127.0.0.1 PORT=9100 NODE_ENV=production
    export OPENCURSOR_STORAGE_DRIVER=legacy-json
    export OPENCURSOR_DATA_DIR="\$STATE_DIR"
    export WORKSPACE_ALLOWED_ROOTS="$PROJECTS_DIR"
    export WORKSPACE_ROOT="$PROJECTS_DIR/default"
    nohup "$PREFIX/bin/node" --max-old-space-size=2048 server/dist/index.js \
      >>"\$DIRECT_LOG_FILE" 2>&1 &
    echo \$! >"\$DIRECT_PID_FILE"
  )
  printf 'Started in direct mode (pid %s). Logs: %s\n' "\$(cat "\$DIRECT_PID_FILE")" "\$DIRECT_LOG_FILE"
}

case "\${1:-status}" in
  start)
    if ensure_runit && rm -f "\$SERVICE_DIR/down" && sv up cesium; then
      printf 'Started via termux-services (runit).\n'
    else
      printf 'runit unavailable; falling back to direct mode.\n' >&2
      start_direct
    fi
    ;;
  stop)
    sv down cesium 2>/dev/null || true
    if [[ -f "\$DIRECT_PID_FILE" ]]; then
      old_pid="\$(cat "\$DIRECT_PID_FILE" 2>/dev/null || true)"
      if [[ -n "\${old_pid:-}" ]]; then
        kill "\$old_pid" 2>/dev/null || true
      fi
      rm -f "\$DIRECT_PID_FILE"
    fi
    ;;
  restart)
    "\$0" stop || true
    "\$0" start
    ;;
  status)
    if sv status cesium 2>/dev/null; then
      exit 0
    fi
    if [[ -f "\$DIRECT_PID_FILE" ]] && kill -0 "\$(cat "\$DIRECT_PID_FILE")" 2>/dev/null; then
      printf 'direct: pid %s\n' "\$(cat "\$DIRECT_PID_FILE")"
      exit 0
    fi
    printf 'cesium is not running\n' >&2
    exit 1
    ;;
  logs)
    if [[ -f "\$LOG_DIR/current" ]]; then
      tail -n 100 -f "\$LOG_DIR/current"
    else
      tail -n 100 -f "\$DIRECT_LOG_FILE"
    fi
    ;;
  health) curl -fsS http://127.0.0.1:9100/health ;;
  update) CESIUM_SKIP_PACKAGE_UPDATE=1 "$SOURCE_DIR/apps/mobile/termux/install-cesium-server.sh" ;;
  remove)
    "\$0" stop 2>/dev/null || true
    rm -rf "\$SERVICE_DIR" "\$STATE_DIR"
    printf 'Cesium service and state removed. Source remains at %s\n' "\$SOURCE_DIR"
    ;;
  *) printf 'Usage: cesium-server {start|stop|restart|status|logs|health|update|remove}\n' >&2; exit 2 ;;
esac
MANAGER
chmod 700 "$PREFIX/bin/cesium-server"

printf 'Starting Cesium server...\n'
SERVICE_MODE="runit"
if ensure_runit_running; then
  # Give runsvdir a moment to notice the new service directory.
  sleep 1
  if ! sv up cesium >/dev/null 2>&1; then
    # Common race: supervise/ not created yet. Bounce runsv if present.
    pkill -f "runsv cesium" >/dev/null 2>&1 || true
    sleep 1
    sv up cesium >/dev/null 2>&1 || true
  fi
  if ! wait_for_health 8; then
    printf 'runit did not bring /health up; falling back to direct mode.\n' >&2
    SERVICE_MODE="direct"
    start_server_direct
  fi
else
  printf 'Could not start runsvdir; falling back to direct mode.\n' >&2
  SERVICE_MODE="direct"
  start_server_direct
fi

if ! wait_for_health 20; then
  printf 'Server installed but /health is not responding.\n' >&2
  printf 'Try: cesium-server logs\n' >&2
  printf 'Or start manually: cesium-server start\n' >&2
  exit 1
fi

printf '\nCesium server installed (%s).\n' "$SERVICE_MODE"
printf 'Server: http://127.0.0.1:9100\n'
printf 'Workspace: %s\n' "$PROJECTS_DIR/default"
printf 'Check: cesium-server health\n'
printf 'Note: integrated terminals need Bun.Terminal; node-pty is skipped on Termux.\n'
printf 'Tip: if services die after closing Termux, run: termux-wake-lock && cesium-server start\n'
