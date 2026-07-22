#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID:-$(id -u)}" == "0" ]]; then
  printf 'Do not run the Cesium installer as root.\n' >&2
  exit 1
fi

case "$(uname -s)" in
  Linux | Darwin) ;;
  *)
    printf 'This installer currently supports Linux and macOS.\n' >&2
    exit 1
    ;;
esac

for command_name in curl git tar; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command is missing: %s\n' "$command_name" >&2
    exit 1
  fi
done

INSTALL_CWD="$PWD"
REPO_URL="${CESIUM_REPO_URL:-https://github.com/BenItBuhner/Cesium.git}"
REPO_BRANCH="${CESIUM_REPO_BRANCH:-main}"
CESIUM_HOME="${CESIUM_HOME:-$HOME/.cesium}"
EXISTING_ENV_FILE="$CESIUM_HOME/server.env"
existing_env_value() {
  local name="$1"
  [[ -f "$EXISTING_ENV_FILE" ]] || return 0
  (
    set +u
    # shellcheck disable=SC1090
    source "$EXISTING_ENV_FILE"
    printf '%s' "${!name-}"
  )
}
SOURCE_DIR="$CESIUM_HOME/source"
RUNTIME_DIR="$CESIUM_HOME/runtime"
BIN_DIR="$CESIUM_HOME/bin"
USER_BIN_DIR="${CESIUM_BIN_DIR:-$HOME/.local/bin}"
STATE_DIR="${CESIUM_STATE_DIR:-$(existing_env_value OPENCURSOR_DATA_DIR)}"
STATE_DIR="${STATE_DIR:-$CESIUM_HOME/state}"
WORKSPACE_ROOT="${CESIUM_WORKSPACE_ROOT:-$(existing_env_value WORKSPACE_ROOT)}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$INSTALL_CWD}"
PORT="${CESIUM_PORT:-$(existing_env_value PORT)}"
PORT="${PORT:-9100}"
WEB_URL="${CESIUM_WEB_URL:-$(existing_env_value CESIUM_WEB_URL)}"
AUTH_USERNAME="${CESIUM_AUTH_USERNAME:-$(existing_env_value OPENCURSOR_AUTH_USERNAME)}"
AUTH_USERNAME="${AUTH_USERNAME:-cesium}"
AUTH_PASSWORD="${CESIUM_AUTH_PASSWORD:-$(existing_env_value OPENCURSOR_AUTH_PASSWORD)}"
SERVER_ID="${CESIUM_SERVER_ID:-$(existing_env_value CESIUM_SERVER_ID)}"
SERVER_LABEL="${CESIUM_SERVER_LABEL:-$(existing_env_value CESIUM_SERVER_LABEL)}"
SERVER_LABEL="${SERVER_LABEL:-$(hostname 2>/dev/null || printf 'Cesium server')}"
RENDEZVOUS_READ_SECRET="${CESIUM_RENDEZVOUS_READ_SECRET:-$(existing_env_value CESIUM_RENDEZVOUS_READ_SECRET)}"
RENDEZVOUS_WRITE_SECRET="${CESIUM_RENDEZVOUS_WRITE_SECRET:-$(existing_env_value CESIUM_RENDEZVOUS_WRITE_SECRET)}"
RENDEZVOUS_URL="${CESIUM_RENDEZVOUS_URL:-$(existing_env_value CESIUM_RENDEZVOUS_URL)}"
RENDEZVOUS_REQUIRED="${CESIUM_RENDEZVOUS_REQUIRED:-$(existing_env_value CESIUM_RENDEZVOUS_REQUIRED)}"
SERVICE_MANAGER="${CESIUM_SERVICE_MANAGER:-$(existing_env_value CESIUM_SERVICE_MANAGER)}"
SERVICE_MANAGER="${SERVICE_MANAGER:-auto}"
TUNNEL_PROVIDER="${CESIUM_TUNNEL_PROVIDER:-$(existing_env_value CESIUM_TUNNEL_PROVIDER)}"
TUNNEL_PROVIDER="${TUNNEL_PROVIDER:-auto}"
TUNNEL_TOKEN="${CESIUM_TUNNEL_TOKEN:-$(existing_env_value CESIUM_TUNNEL_TOKEN)}"
PUBLIC_URL="${CESIUM_PUBLIC_URL:-$(existing_env_value CESIUM_PUBLIC_URL)}"
TUNNEL_REQUIRED="${CESIUM_TUNNEL_REQUIRED:-$(existing_env_value CESIUM_TUNNEL_REQUIRED)}"
SKIP_TUNNEL="${CESIUM_SKIP_TUNNEL:-0}"
SKIP_AUTOSTART="${CESIUM_SKIP_AUTOSTART:-0}"

if [[ ! "$PORT" =~ ^[0-9]+$ ]] || ((PORT < 1 || PORT > 65535)); then
  printf 'CESIUM_PORT must be an integer from 1 to 65535.\n' >&2
  exit 1
fi
if [[ ! -d "$WORKSPACE_ROOT" ]]; then
  printf 'Workspace root does not exist: %s\n' "$WORKSPACE_ROOT" >&2
  exit 1
fi
WORKSPACE_ROOT="$(cd "$WORKSPACE_ROOT" && pwd)"

WEB_ORIGIN=""
if [[ -n "$WEB_URL" ]]; then
  if [[ "$WEB_URL" =~ ^(https?://[^/]+) ]]; then
    WEB_ORIGIN="${BASH_REMATCH[1]}"
    WEB_URL="${WEB_URL%/}"
  else
    printf 'CESIUM_WEB_URL must be an absolute http(s) URL.\n' >&2
    exit 1
  fi
fi
if [[ -z "$RENDEZVOUS_URL" && -n "$WEB_ORIGIN" ]]; then
  RENDEZVOUS_URL="$WEB_ORIGIN/api/rendezvous"
fi
if [[ -n "$RENDEZVOUS_URL" ]]; then
  if [[ "$RENDEZVOUS_URL" =~ ^https://[^/]+(/.*)?$ ]] ||
    [[ "$RENDEZVOUS_URL" =~ ^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/.*)?$ ]]; then
    RENDEZVOUS_URL="${RENDEZVOUS_URL%/}"
  else
    printf 'CESIUM_RENDEZVOUS_URL must use HTTPS (or local HTTP for development).\n' >&2
    exit 1
  fi
fi
if [[ -n "$PUBLIC_URL" && ! "$PUBLIC_URL" =~ ^https:// ]]; then
  printf 'CESIUM_PUBLIC_URL must be an HTTPS URL.\n' >&2
  exit 1
fi
if [[ -n "$TUNNEL_TOKEN" && -z "$PUBLIC_URL" ]]; then
  printf 'CESIUM_PUBLIC_URL is required when CESIUM_TUNNEL_TOKEN is set.\n' >&2
  exit 1
fi
case "$TUNNEL_PROVIDER" in
  auto | localhost-run | cloudflare-quick) ;;
  *)
    printf 'CESIUM_TUNNEL_PROVIDER must be auto, localhost-run, or cloudflare-quick.\n' >&2
    exit 1
    ;;
esac
if [[ -z "$TUNNEL_REQUIRED" ]]; then
  TUNNEL_REQUIRED=0
  if [[ "$SKIP_TUNNEL" != "1" && -n "$WEB_URL" ]]; then
    TUNNEL_REQUIRED=1
  fi
fi
if [[ "$TUNNEL_REQUIRED" != "0" && "$TUNNEL_REQUIRED" != "1" ]]; then
  printf 'CESIUM_TUNNEL_REQUIRED must be 0 or 1.\n' >&2
  exit 1
fi
if [[ -z "$RENDEZVOUS_REQUIRED" ]]; then
  RENDEZVOUS_REQUIRED=0
  [[ -n "$WEB_URL" ]] && RENDEZVOUS_REQUIRED=1
fi
if [[ "$RENDEZVOUS_REQUIRED" != "0" && "$RENDEZVOUS_REQUIRED" != "1" ]]; then
  printf 'CESIUM_RENDEZVOUS_REQUIRED must be 0 or 1.\n' >&2
  exit 1
fi
case "$SERVICE_MANAGER" in
  auto | systemd-user | launchd | detached) ;;
  *)
    printf 'CESIUM_SERVICE_MANAGER must be auto, systemd-user, launchd, or detached.\n' >&2
    exit 1
    ;;
esac

mkdir -p "$CESIUM_HOME" "$RUNTIME_DIR/bin" "$BIN_DIR" "$USER_BIN_DIR" \
  "$STATE_DIR" "$CESIUM_HOME/logs" "$CESIUM_HOME/run"

install_bun() {
  local target="$RUNTIME_DIR/bin/bun"
  if [[ -x "$target" ]]; then
    return 0
  fi
  if command -v bun >/dev/null 2>&1; then
    cp "$(command -v bun)" "$target"
    chmod 700 "$target"
    return 0
  fi

  printf 'Installing Bun runtime into %s...\n' "$RUNTIME_DIR"
  curl -fsSL https://bun.sh/install | env BUN_INSTALL="$RUNTIME_DIR" bash
  if [[ ! -x "$target" ]]; then
    printf 'Bun installation did not produce %s.\n' "$target" >&2
    exit 1
  fi
}

install_cloudflared() {
  local target="$RUNTIME_DIR/bin/cloudflared"
  if [[ "$SKIP_TUNNEL" == "1" || -z "$WEB_URL" || -x "$target" ]]; then
    return 0
  fi
  if [[ -z "$TUNNEL_TOKEN" && "$TUNNEL_PROVIDER" != "cloudflare-quick" ]] &&
    command -v ssh >/dev/null 2>&1; then
    return 0
  fi
  if command -v cloudflared >/dev/null 2>&1; then
    cp "$(command -v cloudflared)" "$target"
    chmod 700 "$target"
    return 0
  fi

  local os arch asset
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os:$arch" in
    Linux:x86_64 | Linux:amd64) asset="cloudflared-linux-amd64" ;;
    Linux:aarch64 | Linux:arm64) asset="cloudflared-linux-arm64" ;;
    Darwin:x86_64 | Darwin:amd64) asset="cloudflared-darwin-amd64.tgz" ;;
    Darwin:arm64 | Darwin:aarch64) asset="cloudflared-darwin-arm64.tgz" ;;
    *)
      printf 'Unsupported cloudflared platform: %s %s\n' "$os" "$arch" >&2
      exit 1
      ;;
  esac

  printf 'Installing cloudflared into %s...\n' "$RUNTIME_DIR"
  if [[ "$asset" == *.tgz ]]; then
    local archive="$RUNTIME_DIR/cloudflared.tgz"
    curl -fL "https://github.com/cloudflare/cloudflared/releases/latest/download/$asset" \
      -o "$archive"
    tar -xzf "$archive" -C "$RUNTIME_DIR/bin"
    rm -f "$archive"
  else
    curl -fL "https://github.com/cloudflare/cloudflared/releases/latest/download/$asset" \
      -o "$target"
  fi
  chmod 700 "$target"
  "$target" --version >/dev/null
}

install_bun
BUN_BIN="$RUNTIME_DIR/bin/bun"
if [[ -z "$SERVER_ID" ]]; then
  SERVER_ID="$("$BUN_BIN" -e \
    'console.log(require("node:crypto").randomBytes(24).toString("base64url"))')"
fi
if [[ -z "$RENDEZVOUS_READ_SECRET" ]]; then
  RENDEZVOUS_READ_SECRET="$("$BUN_BIN" -e \
    'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
fi
if [[ -z "$RENDEZVOUS_WRITE_SECRET" ]]; then
  RENDEZVOUS_WRITE_SECRET="$("$BUN_BIN" -e \
    'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
fi
if [[ ! "$SERVER_ID" =~ ^[A-Za-z0-9_-]{24,80}$ ]]; then
  printf 'CESIUM_SERVER_ID is invalid.\n' >&2
  exit 1
fi
if [[ ! "$RENDEZVOUS_READ_SECRET" =~ ^[A-Za-z0-9_-]{32,128}$ ]]; then
  printf 'CESIUM_RENDEZVOUS_READ_SECRET is invalid.\n' >&2
  exit 1
fi
if [[ ! "$RENDEZVOUS_WRITE_SECRET" =~ ^[A-Za-z0-9_-]{32,128}$ ]]; then
  printf 'CESIUM_RENDEZVOUS_WRITE_SECRET is invalid.\n' >&2
  exit 1
fi
install_cloudflared
SSH_BIN="$(command -v ssh 2>/dev/null || true)"

if [[ "$SERVICE_MANAGER" == "auto" ]]; then
  if [[ "$(uname -s)" == "Linux" ]] &&
    command -v systemctl >/dev/null 2>&1 &&
    systemctl --user show-environment >/dev/null 2>&1; then
    SERVICE_MANAGER="systemd-user"
  elif [[ "$(uname -s)" == "Darwin" ]] &&
    command -v launchctl >/dev/null 2>&1; then
    SERVICE_MANAGER="launchd"
  else
    SERVICE_MANAGER="detached"
  fi
fi

if [[ -d "$SOURCE_DIR/.git" ]]; then
  printf 'Updating Cesium source...\n'
  git -C "$SOURCE_DIR" fetch origin "$REPO_BRANCH"
  git -C "$SOURCE_DIR" checkout "$REPO_BRANCH"
  git -C "$SOURCE_DIR" pull --ff-only origin "$REPO_BRANCH"
else
  printf 'Downloading Cesium source...\n'
  rm -rf "$SOURCE_DIR"
  git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$SOURCE_DIR"
fi

printf 'Installing Cesium server dependencies...\n'
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export PUPPETEER_SKIP_DOWNLOAD=1
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export npm_config_fund=false
export npm_config_audit=false
(
  cd "$SOURCE_DIR"
  "$BUN_BIN" install \
    --filter @cesium/core \
    --filter cesium-server \
    --ignore-scripts \
    --no-save
  "$BUN_BIN" run --cwd packages/core build
  rm -f server/node_modules/cesium
)

if [[ ! -f "$SOURCE_DIR/packages/core/dist/index.js" ]]; then
  printf 'Core build did not produce packages/core/dist/index.js.\n' >&2
  exit 1
fi
if [[ ! -f "$SOURCE_DIR/server/src/runtime/bun-server.ts" ]]; then
  printf 'Server runtime is missing after installation.\n' >&2
  exit 1
fi

if [[ -z "$AUTH_PASSWORD" ]]; then
  AUTH_PASSWORD="$("$BUN_BIN" -e \
    'console.log(require("node:crypto").randomBytes(24).toString("base64url"))')"
fi

ALLOWED_ORIGINS="http://localhost:3000,http://127.0.0.1:3000"
if [[ -n "$WEB_ORIGIN" ]]; then
  ALLOWED_ORIGINS="$WEB_ORIGIN,$ALLOWED_ORIGINS"
fi
TUNNEL_ENABLED=0
if [[ "$SKIP_TUNNEL" != "1" && -n "$WEB_URL" ]]; then
  TUNNEL_ENABLED=1
fi

write_env_value() {
  local key="$1"
  local value="$2"
  printf '%s=' "$key"
  printf '%q' "$value"
  printf '\n'
}

ENV_FILE="$CESIUM_HOME/server.env"
{
  write_env_value CESIUM_HOME "$CESIUM_HOME"
  write_env_value CESIUM_SOURCE_DIR "$SOURCE_DIR"
  write_env_value CESIUM_BUN_BIN "$BUN_BIN"
  write_env_value CESIUM_CLOUDFLARED_BIN "$RUNTIME_DIR/bin/cloudflared"
  write_env_value CESIUM_SSH_BIN "$SSH_BIN"
  write_env_value CESIUM_WEB_URL "$WEB_URL"
  write_env_value CESIUM_SERVER_ID "$SERVER_ID"
  write_env_value CESIUM_SERVER_LABEL "$SERVER_LABEL"
  write_env_value CESIUM_RENDEZVOUS_URL "$RENDEZVOUS_URL"
  write_env_value CESIUM_RENDEZVOUS_READ_SECRET "$RENDEZVOUS_READ_SECRET"
  write_env_value CESIUM_RENDEZVOUS_WRITE_SECRET "$RENDEZVOUS_WRITE_SECRET"
  write_env_value CESIUM_RENDEZVOUS_REQUIRED "$RENDEZVOUS_REQUIRED"
  write_env_value CESIUM_RENDEZVOUS_INTERVAL "15"
  write_env_value CESIUM_SERVICE_MANAGER "$SERVICE_MANAGER"
  write_env_value CESIUM_BACKEND_MANAGES_PUBLIC_ACCESS "1"
  write_env_value CESIUM_TUNNEL_ENABLED "$TUNNEL_ENABLED"
  write_env_value CESIUM_TUNNEL_REQUIRED "$TUNNEL_REQUIRED"
  write_env_value CESIUM_TUNNEL_PROVIDER "$TUNNEL_PROVIDER"
  write_env_value CESIUM_TUNNEL_TOKEN "$TUNNEL_TOKEN"
  write_env_value CESIUM_PUBLIC_URL "${PUBLIC_URL%/}"
  write_env_value HOST "127.0.0.1"
  write_env_value PORT "$PORT"
  write_env_value NODE_ENV "production"
  write_env_value OPENCURSOR_PROCESS_NAME "Cesium Server"
  write_env_value OPENCURSOR_STORAGE_DRIVER "legacy-json"
  write_env_value OPENCURSOR_DATA_DIR "$STATE_DIR"
  write_env_value OPENCURSOR_AUTH_USERNAME "$AUTH_USERNAME"
  write_env_value OPENCURSOR_AUTH_PASSWORD "$AUTH_PASSWORD"
  write_env_value OPENCURSOR_ALLOW_PRIVATE_LAN_ORIGINS "0"
  write_env_value ALLOWED_ORIGINS "$ALLOWED_ORIGINS"
  write_env_value WORKSPACE_ALLOWED_ROOTS "$WORKSPACE_ROOT"
  write_env_value WORKSPACE_ROOT "$WORKSPACE_ROOT"
} >"$ENV_FILE"
chmod 600 "$ENV_FILE"

install -m 700 "$SOURCE_DIR/scripts/cesium-server" "$BIN_DIR/cesium-server"
ln -sfn "$BIN_DIR/cesium-server" "$USER_BIN_DIR/cesium-server"

systemd_quote() {
  local value="${1//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

xml_escape() {
  local value="${1//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  printf '%s' "$value"
}

configure_service_manager() {
  case "$SERVICE_MANAGER" in
    systemd-user)
      local unit_dir="$HOME/.config/systemd/user"
      local unit_file="$unit_dir/cesium-server.service"
      mkdir -p "$unit_dir"
      {
        printf '[Unit]\nDescription=Cesium local server and secure tunnel\nAfter=network-online.target\nWants=network-online.target\n\n'
        printf '[Service]\nType=simple\nExecStart=%s supervise\n' "$(systemd_quote "$BIN_DIR/cesium-server")"
        printf 'WorkingDirectory=%s\n' "$(systemd_quote "$SOURCE_DIR")"
        printf 'Restart=always\nRestartSec=5\nKillMode=control-group\n'
        printf 'StandardOutput=append:%s\n' "$CESIUM_HOME/logs/supervisor.log"
        printf 'StandardError=append:%s\n\n[Install]\nWantedBy=default.target\n' "$CESIUM_HOME/logs/supervisor.log"
      } >"$unit_file.tmp"
      mv "$unit_file.tmp" "$unit_file"
      chmod 600 "$unit_file"
      systemctl --user daemon-reload
      systemctl --user enable cesium-server.service >/dev/null
      ;;
    launchd)
      local agent_dir="$HOME/Library/LaunchAgents"
      local plist="$agent_dir/dev.cesium.server.plist"
      mkdir -p "$agent_dir"
      {
        printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
        printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
        printf '%s\n' '<plist version="1.0"><dict>'
        printf '%s\n' '<key>Label</key><string>dev.cesium.server</string>'
        printf '<key>ProgramArguments</key><array><string>%s</string><string>supervise</string></array>\n' \
          "$(xml_escape "$BIN_DIR/cesium-server")"
        printf '<key>WorkingDirectory</key><string>%s</string>\n' "$(xml_escape "$SOURCE_DIR")"
        printf '%s\n' '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer>'
        printf '<key>StandardOutPath</key><string>%s</string>\n' "$(xml_escape "$CESIUM_HOME/logs/supervisor.log")"
        printf '<key>StandardErrorPath</key><string>%s</string>\n' "$(xml_escape "$CESIUM_HOME/logs/supervisor.log")"
        printf '%s\n' '</dict></plist>'
      } >"$plist.tmp"
      mv "$plist.tmp" "$plist"
      chmod 600 "$plist"
      ;;
    detached) ;;
  esac
}

configure_service_manager

printf '\nCesium server installed in %s.\n' "$CESIUM_HOME"
printf 'Lifecycle: %s\n' "$SERVICE_MANAGER"
if [[ ":$PATH:" != *":$USER_BIN_DIR:"* ]]; then
  printf 'Add %s to PATH, or use %s/cesium-server.\n' "$USER_BIN_DIR" "$USER_BIN_DIR"
fi

if [[ "$SKIP_AUTOSTART" == "1" ]]; then
  printf 'Start it with: %s/cesium-server run\n' "$USER_BIN_DIR"
  exit 0
fi

"$BIN_DIR/cesium-server" run
