/**
 * Canonical devcontainer + bootstrap assets Cesium writes into a repository
 * so a GitHub Codespace can self-provision a Cesium engine.
 *
 * The Codespaces REST API has no "run command" primitive, so everything the
 * engine needs (install, start, public port visibility) must ride the
 * devcontainer lifecycle hooks. Cesium commits these two files (directly or
 * via PR, the user chooses) and then creates codespaces with
 * `devcontainer_path` pointing at the JSON below.
 *
 * Bump {@link CODESPACE_TEMPLATE_VERSION} whenever either file changes so
 * `ensureDevcontainer` refreshes stale copies in user repositories.
 */

export const CODESPACE_TEMPLATE_VERSION = 4;

/** Port the engine listens on inside the codespace (forwarded publicly). */
export const CODESPACE_ENGINE_PORT = 9100;

export const CODESPACE_DEVCONTAINER_PATH = ".devcontainer/cesium/devcontainer.json";
export const CODESPACE_BOOTSTRAP_PATH = ".devcontainer/cesium/bootstrap.sh";

/** Codespaces user-secret names the bootstrap consumes (installer env names). */
export const CODESPACE_AUTH_USERNAME_SECRET = "CESIUM_AUTH_USERNAME";
export const CODESPACE_AUTH_PASSWORD_SECRET = "CESIUM_AUTH_PASSWORD";

const INSTALLER_URL =
  "https://raw.githubusercontent.com/BenItBuhner/Cesium/main/scripts/install-cesium-server.sh";

export function buildDevcontainerJson(): string {
  return `${JSON.stringify(
    {
      name: "Cesium engine",
      image: "mcr.microsoft.com/devcontainers/universal:2",
      forwardPorts: [CODESPACE_ENGINE_PORT],
      portsAttributes: {
        [String(CODESPACE_ENGINE_PORT)]: {
          label: "Cesium engine",
          onAutoForward: "silent",
        },
      },
      postCreateCommand: "bash .devcontainer/cesium/bootstrap.sh install",
      postStartCommand: "bash .devcontainer/cesium/bootstrap.sh start",
      customizations: {
        cesium: { templateVersion: CODESPACE_TEMPLATE_VERSION },
      },
    },
    null,
    2
  )}\n`;
}

/**
 * Bash bootstrap executed by the devcontainer lifecycle hooks.
 *
 * - `install`: runs the standard Cesium server installer under /workspaces
 *   (the only volume that survives container rebuilds), tunnel-free - the
 *   codespace forwarded port is the public endpoint. `CESIUM_INSTALL_BROWSER=1`
 *   also provisions a headless Chromium: document loads through the forwarded
 *   port are hijacked by GitHub's dev-tunnel anti-phishing interstitial
 *   ("Verifying session"), which never completes inside an embedded iframe,
 *   so the in-app browser must render pages inside the codespace and stream
 *   them out over plain API calls.
 * - `start`: refreshes engine credentials from the injected Codespaces
 *   secrets, fast-forwards the engine to the latest release when the git
 *   remote moved (codespaces otherwise run creation-time engine code
 *   forever), backfills the headless Chromium on engines installed by older
 *   templates, starts the engine supervisor, and flips port ${PORT} to public
 *   visibility (mandatory: private forwarded ports cannot be reached by
 *   browser WebSocket clients).
 */
export function buildBootstrapScript(): string {
  // NOTE: this is a template literal producing bash; every bash `${...}`
  // expansion below is escaped as `\${...}` so TypeScript does not
  // interpolate it.
  return `#!/usr/bin/env bash
# Cesium engine bootstrap for GitHub Codespaces.
# Managed by Cesium - do not edit by hand; rerun Codespace setup to refresh.
# cesium-template-version: ${CODESPACE_TEMPLATE_VERSION}
set -uo pipefail

CESIUM_ROOT="/workspaces/.cesium"
LOG_DIR="\${CESIUM_ROOT}/logs"
INSTALL_MARKER="\${CESIUM_ROOT}/.bootstrap-installed"
INSTALLER_URL="\${CESIUM_INSTALLER_URL:-${INSTALLER_URL}}"
ENGINE_PORT=${CODESPACE_ENGINE_PORT}

mkdir -p "\${CESIUM_ROOT}" "\${LOG_DIR}"

log() { printf '[cesium-bootstrap] %s\\n' "$*"; }

# Shared installer invocation for the initial install and later updates. The
# installer is fetched from the canonical URL (not the codespace checkout) so
# updates always run the latest install logic, and it fast-forwards the
# engine source before rebuilding.
run_installer() {
  if env \\
    CESIUM_HOME="\${CESIUM_ROOT}/home" \\
    CESIUM_STATE_DIR="\${CESIUM_ROOT}/state" \\
    CESIUM_WORKSPACE_ROOT="/workspaces" \\
    CESIUM_PORT="\${ENGINE_PORT}" \\
    CESIUM_AUTH_USERNAME="\${CESIUM_AUTH_USERNAME:-cesium}" \\
    CESIUM_AUTH_PASSWORD="\${CESIUM_AUTH_PASSWORD:-}" \\
    CESIUM_SKIP_TUNNEL=1 \\
    CESIUM_RENDEZVOUS_REQUIRED=0 \\
    CESIUM_SERVICE_MANAGER=detached \\
    CESIUM_SKIP_AUTOSTART=1 \\
    CESIUM_INSTALL_BROWSER=1 \\
    CESIUM_SERVER_LABEL="Codespace \${GITHUB_REPOSITORY:-}" \\
    bash -c "curl -fsSL '\${INSTALLER_URL}' | bash" >>"\${LOG_DIR}/install.log" 2>&1; then
    date -u +%Y-%m-%dT%H:%M:%SZ >"\${INSTALL_MARKER}"
    return 0
  fi
  return 1
}

install_engine() {
  if [[ -x "\${CESIUM_ROOT}/home/bin/cesium-server" && -f "\${INSTALL_MARKER}" ]]; then
    log "Engine already installed."
    return 0
  fi
  if [[ -z "\${CESIUM_AUTH_PASSWORD:-}" ]]; then
    log "WARNING: CESIUM_AUTH_PASSWORD codespace secret is missing; the engine"
    log "will generate its own password and Cesium clients cannot sign in"
    log "automatically. Re-run Codespace setup from Cesium to fix this."
  fi
  log "Installing the Cesium engine (log: \${LOG_DIR}/install.log)..."
  if run_installer; then
    log "Engine installed."
    return 0
  fi
  log "Engine install FAILED; see \${LOG_DIR}/install.log"
  return 1
}

# Keep the engine current on every codespace start. Without this a codespace
# would run creation-time engine code forever (the install marker skips the
# installer, GitHub cannot raise idle timeouts post-create, and the checkout's
# bootstrap never refreshes itself), so fixes like the idle-timeout keep-alive
# would never reach existing codespaces. Never fatal: when the remote is
# unreachable or the update fails, the existing engine still starts.
update_engine() {
  local src="\${CESIUM_ROOT}/home/source"
  [[ -d "\${src}/.git" ]] || return 0
  local branch local_head remote_head
  branch="$(git -C "\${src}" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ -z "\${branch}" || "\${branch}" == "HEAD" ]]; then
    branch="main"
  fi
  local_head="$(git -C "\${src}" rev-parse HEAD 2>/dev/null || true)"
  remote_head="$(timeout 30 git -C "\${src}" ls-remote origin "refs/heads/\${branch}" \\
    2>>"\${LOG_DIR}/install.log" | cut -f1)"
  if [[ -z "\${remote_head}" ]]; then
    log "Engine update check skipped (git remote unreachable)."
    return 0
  fi
  if [[ "\${remote_head}" == "\${local_head}" ]]; then
    log "Engine is up to date."
    return 0
  fi
  log "Updating the Cesium engine to \${branch}@\${remote_head} (log: \${LOG_DIR}/install.log)..."
  if run_installer; then
    log "Engine updated."
  else
    log "Engine update FAILED; keeping the existing engine. See \${LOG_DIR}/install.log"
  fi
  return 0
}

# Refresh the engine's persisted environment on every start:
# - Codespaces secrets only apply to new sessions, so a rotated engine
#   password must be re-written for the supervised engine to pick it up.
# - The codespace identity lets the engine keep GitHub's idle timer at bay
#   while agents run (it reports presence to the codespace host agent). It is
#   persisted here because supervised restarts do not inherit this shell.
sync_env() {
  local env_file="\${CESIUM_ROOT}/home/server.env"
  [[ -f "\${env_file}" ]] || return 0
  local tmp="\${env_file}.tmp.$$"
  local strip=(
    -e '^CESIUM_CODESPACE_NAME=' -e '^CESIUM_CODESPACE_KEEPALIVE='
    -e '^CESIUM_CODESPACES_PORT_FORWARDING_DOMAIN='
  )
  if [[ -n "\${CESIUM_AUTH_PASSWORD:-}" ]]; then
    strip+=(-e '^OPENCURSOR_AUTH_USERNAME=' -e '^OPENCURSOR_AUTH_PASSWORD=')
  fi
  grep -v "\${strip[@]}" "\${env_file}" >"\${tmp}" || true
  if [[ -n "\${CESIUM_AUTH_PASSWORD:-}" ]]; then
    printf 'OPENCURSOR_AUTH_USERNAME=%q\\n' "\${CESIUM_AUTH_USERNAME:-cesium}" >>"\${tmp}"
    printf 'OPENCURSOR_AUTH_PASSWORD=%q\\n' "\${CESIUM_AUTH_PASSWORD}" >>"\${tmp}"
  fi
  if [[ -n "\${CODESPACE_NAME:-}" ]]; then
    printf 'CESIUM_CODESPACE_NAME=%q\\n' "\${CODESPACE_NAME}" >>"\${tmp}"
    printf 'CESIUM_CODESPACE_KEEPALIVE=1\\n' >>"\${tmp}"
    printf 'CESIUM_CODESPACES_PORT_FORWARDING_DOMAIN=%q\\n' \\
      "\${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}" >>"\${tmp}"
  fi
  mv "\${tmp}" "\${env_file}"
  chmod 600 "\${env_file}"
}

start_engine() {
  sync_env
  log "Starting the Cesium engine (log: \${LOG_DIR}/engine.log)..."
  if "\${CESIUM_ROOT}/home/bin/cesium-server" run >>"\${LOG_DIR}/engine.log" 2>&1; then
    log "Engine is healthy on port \${ENGINE_PORT}."
    return 0
  fi
  log "Engine FAILED to start; see \${LOG_DIR}/engine.log"
  return 1
}

# The in-app browser must render pages from INSIDE the codespace: document
# loads through the forwarded port are hijacked by GitHub's dev-tunnel
# anti-phishing interstitial ("Verifying session"), which cannot complete in
# an embedded iframe. The engine instead streams a headless Chromium, which
# needs a browser binary. Fresh installs get it via CESIUM_INSTALL_BROWSER=1
# above; this backfills engines installed by older bootstrap templates.
# Always returns 0 - a missing browser degrades the preview, never the engine.
ensure_browser() {
  local browsers_dir="\${CESIUM_ROOT}/home/browsers"
  if compgen -G "\${browsers_dir}/chromium*" >/dev/null 2>&1; then
    return 0
  fi
  local bun_bin="\${CESIUM_ROOT}/home/runtime/bin/bun"
  local cli=""
  local candidate
  for candidate in \\
    "\${CESIUM_ROOT}/home/source/server/node_modules/playwright/cli.js" \\
    "\${CESIUM_ROOT}/home/source/node_modules/playwright/cli.js"; do
    if [[ -f "\${candidate}" ]]; then
      cli="\${candidate}"
      break
    fi
  done
  if [[ ! -x "\${bun_bin}" || -z "\${cli}" ]]; then
    log "Engine runtime not found; skipping the in-app browser install."
    return 0
  fi
  log "Installing headless Chromium for the in-app browser (log: \${LOG_DIR}/browser.log)..."
  if env -u PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD \\
    PLAYWRIGHT_BROWSERS_PATH="\${browsers_dir}" \\
    "\${bun_bin}" "\${cli}" install --with-deps chromium >>"\${LOG_DIR}/browser.log" 2>&1; then
    local env_file="\${CESIUM_ROOT}/home/server.env"
    if [[ -f "\${env_file}" ]] && ! grep -q '^PLAYWRIGHT_BROWSERS_PATH=' "\${env_file}"; then
      printf 'PLAYWRIGHT_BROWSERS_PATH=%q\\n' "\${browsers_dir}" >>"\${env_file}"
    fi
    log "Headless Chromium installed."
  else
    log "Chromium install FAILED; the in-app browser falls back to the proxy preview. See \${LOG_DIR}/browser.log"
  fi
  return 0
}

# Browser clients cannot attach auth headers to WebSockets, so the forwarded
# port must be public; the engine's own password auth is the access gate.
publish_port() {
  if [[ -z "\${CODESPACE_NAME:-}" ]] || ! command -v gh >/dev/null 2>&1; then
    log "Not in a codespace (or gh is missing); skipping port visibility."
    return 0
  fi
  local attempt
  for attempt in 1 2 3 4 5 6; do
    if gh codespace ports visibility "\${ENGINE_PORT}:public" \\
      -c "\${CODESPACE_NAME}" >>"\${LOG_DIR}/ports.log" 2>&1; then
      log "Port \${ENGINE_PORT} is public: https://\${CODESPACE_NAME}-\${ENGINE_PORT}.\${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
      return 0
    fi
    sleep $((attempt * 5))
  done
  log "Could not publish port \${ENGINE_PORT}. Run manually:"
  log "  gh codespace ports visibility \${ENGINE_PORT}:public -c \${CODESPACE_NAME}"
  return 1
}

case "\${1:-start}" in
  install)
    install_engine
    ;;
  start)
    if ! install_engine; then
      exit 1
    fi
    update_engine
    ensure_browser
    if start_engine; then
      publish_port
    else
      exit 1
    fi
    ;;
  *)
    printf 'Usage: bootstrap.sh {install|start}\\n' >&2
    exit 2
    ;;
esac
`;
}

export type CodespaceTemplateFile = { path: string; content: string };

export function buildCodespaceTemplateFiles(): CodespaceTemplateFile[] {
  return [
    { path: CODESPACE_DEVCONTAINER_PATH, content: buildDevcontainerJson() },
    { path: CODESPACE_BOOTSTRAP_PATH, content: buildBootstrapScript() },
  ];
}

/** Derive the public forwarded-port URL for a codespace's engine. */
export function codespaceEngineBaseUrl(
  codespaceName: string,
  portForwardingDomain = "app.github.dev"
): string {
  const name = codespaceName.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error("Invalid codespace name.");
  }
  return `https://${name}-${CODESPACE_ENGINE_PORT}.${portForwardingDomain}`;
}

/**
 * Resolve the engine URL for a codespace, honoring deployment overrides:
 *
 * - `urlTemplate` (env `CESIUM_CODESPACES_ENGINE_URL_TEMPLATE`): full URL
 *   with optional `{name}` / `{port}` placeholders. Escape hatch for hosts
 *   whose forwarded-port URLs are not `<name>-<port>.<domain>` shaped, and
 *   for integration harnesses that stand in for GitHub.
 * - `portForwardingDomain` (env `CESIUM_CODESPACES_PORT_FORWARDING_DOMAIN`):
 *   GitHub Enterprise forwarding domains (github.com uses app.github.dev).
 */
export function resolveCodespaceEngineBaseUrl(
  codespaceName: string,
  overrides?: { urlTemplate?: string | null; portForwardingDomain?: string | null }
): string {
  const template = overrides?.urlTemplate?.trim();
  if (template) {
    const resolved = template
      .replaceAll("{name}", codespaceName.trim().toLowerCase())
      .replaceAll("{port}", String(CODESPACE_ENGINE_PORT));
    if (!/^https?:\/\//.test(resolved)) {
      throw new Error("Codespace engine URL template must resolve to http(s).");
    }
    return resolved.replace(/\/+$/, "");
  }
  const domain = overrides?.portForwardingDomain?.trim();
  return codespaceEngineBaseUrl(codespaceName, domain || undefined);
}
