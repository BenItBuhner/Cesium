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
npm ci --omit=optional
rm -f server/node_modules/cesium
npm run build:packages
npm ci --prefix server --omit=optional
rm -f server/node_modules/cesium
npm run build --prefix server

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

cat >"$PREFIX/bin/cesium-server" <<MANAGER
#!$PREFIX/bin/bash
set -euo pipefail
case "\${1:-status}" in
  start) sv-enable cesium; sv up cesium ;;
  stop) sv down cesium ;;
  restart) sv restart cesium ;;
  status) sv status cesium ;;
  logs) tail -n 100 -f "$LOG_DIR/current" ;;
  health) curl -fsS http://127.0.0.1:9100/health ;;
  update) CESIUM_SKIP_PACKAGE_UPDATE=1 "$SOURCE_DIR/apps/mobile/termux/install-cesium-server.sh" ;;
  remove)
    sv down cesium 2>/dev/null || true
    rm -rf "$SERVICE_DIR" "$STATE_DIR"
    printf 'Cesium service and state removed. Source remains at %s\\n' "$SOURCE_DIR"
    ;;
  *) printf 'Usage: cesium-server {start|stop|restart|status|logs|health|update|remove}\\n' >&2; exit 2 ;;
esac
MANAGER
chmod 700 "$PREFIX/bin/cesium-server"

if [[ -f "$PREFIX/etc/profile.d/start-services.sh" ]]; then
  # shellcheck disable=SC1091
  source "$PREFIX/etc/profile.d/start-services.sh"
fi
sv-enable cesium
sv up cesium

printf '\nCesium server installed.\n'
printf 'Server: http://127.0.0.1:9100\n'
printf 'Workspace: %s\n' "$PROJECTS_DIR/default"
printf 'Check: cesium-server health\n'
