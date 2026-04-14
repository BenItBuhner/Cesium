# OpenCursor

OpenCursor is a **local-first browser workbench**: a **Next.js** UI plus a **Node (Hono) companion server** that gives you an **editor** (Monaco), **file tree**, **terminals** (real PTYs), and **multi-backend AI agent chats** against **real folders on disk**. The server persists workspace metadata, conversation history, and optional auth under a configurable data directory.

- **Frontend** (default `http://localhost:3000`): workbench shell with an **agent** view and a classic **IDE** view (`?view=editor`).
- **Backend** (default `http://localhost:9100`): REST + WebSocket APIs for workspaces, FS, terminals, agents, optional speech-to-text, and an allowlisted browser fetch proxy.

Legacy routes `/agent` and `/editor` redirect to the same workbench on `/`.

## Prerequisites

- **Node.js** (current LTS recommended; the repo targets Next 16 + React 19).
- **npm** (or compatible client).
- **Agent CLIs** (optional, depending on backends you want):
  - **Cursor Agent** (ACP) on your `PATH` or via `OPENCURSOR_CURSOR_CLI_BIN` / `OPENCURSOR_CURSOR_ACP_BIN`.
  - **OpenCode** ACP binary or install under `~/.opencode/bin` (see `OPENCURSOR_OPENCODE_ACP_BIN`, `OPENCURSOR_REAL_HOME`).
  - **Codex** / **Claude** CLIs if you use those adapter backends (`OPENCURSOR_CODEX_BIN`, `OPENCURSOR_CLAUDE_BIN`).

## Quick start (development)

From the repository root:

1. **Install dependencies**

   ```bash
   npm install
   npm install --prefix server
   ```

2. **Configure environment**  
   Copy `.env.example` to `.env.local` at the repo root (and/or create `server/.env`).   The server loads variables in this order (each step overrides the previous):

   - repo `.env`
   - repo `.env.local`
   - `server/.env`
   - `server/.env.local`

   At minimum, set **`NEXT_PUBLIC_SERVER_URL`** so the browser reaches the API (see [Environment variables](#environment-variables)).

3. **Run the app**

   - **Frontend only:** `npm run dev` → [http://localhost:3000](http://localhost:3000)
   - **Backend only:** `npm run dev:server` → listens on **`PORT`** (default `9100`)
   - **Typical dev:** two terminals — one for `npm run dev`, one for `npm run dev:server`

4. Open the UI, pick or add a **workspace** (folder on disk). The server restricts which roots are allowed unless you use the escape hatch env (see below).

## Production build

```bash
npm run prod
```

This runs `next build`, builds the server with `tsc`, then starts both **Next** (`next start`) and the **compiled server** (`node dist/index.js` under `server/`). Adjust `PORT`, `HOST`, and `NEXT_PUBLIC_SERVER_URL` for your deployment.

**PWA note:** In production, a service worker is registered. If you hit stale chunks after redeploying locally, set `DISABLE_NEXT_PWA=1` for the Next process (see env table below).

## Using the workbench

- **Workspaces:** Register one or more directories; switching workspace sends `x-opencursor-workspace-id` on API calls.
- **Agent view:** Create conversations, choose a **backend** (Cursor ACP, OpenCode ACP, Codex/Claude adapters when installed), send messages, approve tool permissions when the provider supports it. Live updates use **`/ws/agent`**.
- **IDE view:** Edit files, use integrated **xterm** terminals (**`/ws/terminal`**), file watcher (**`/ws/fs`**).
- **Voice input (optional):** If transcription is configured, the composer can send audio to **`POST /api/audio/transcriptions`** (OpenAI-compatible multipart API).

## Environment variables

### Frontend (Next.js)

| Variable | Description |
| -------- | ----------- |
| `NEXT_PUBLIC_SERVER_URL` | Base URL of the OpenCursor API (no trailing slash), e.g. `http://localhost:9100` or `http://192.168.1.10:9100`. **Required** for a non-default host/port. |
| `NEXT_ALLOWED_DEV_ORIGINS` | Space- or comma-separated origins allowed for dev HMR/assets when not using localhost (see `next.config.ts`). |
| `DISABLE_NEXT_PWA` | Set to `1` with `next start` to disable the PWA service worker (helps avoid stale chunk errors after local rebuilds). |

### Server: listen + CORS

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `PORT` | `9100` | HTTP port. |
| `HOST` | `0.0.0.0` | Bind address. |
| `PUBLIC_HOST` | `localhost` if host is `0.0.0.0`, else same as `HOST` | Used to build default CORS allowlist entries with port `3000`. |
| `ALLOWED_ORIGINS` | Comma-separated list derived from `PUBLIC_HOST` + localhost | Browser origins allowed to call the API with credentials. **Set this** if you open the Next app from a LAN IP or custom host. |

### Workspaces + data

| Variable | Description |
| -------- | ----------- |
| `WORKSPACE_ROOT` | Default folder opened on first bootstrap. Must fall under an [allowed root](#workspace-safety). If unset, the server uses the **repository root** (parent of `server/` when cwd is `server/`). |
| `WORKSPACE_ALLOWED_ROOTS` | Comma-separated **absolute** directories. When set, **only** these paths may be used as workspace roots (no automatic repo-root fallback). |
| `OPENCURSOR_ALLOW_ANY_WORKSPACE_ROOT` | Set to `1` to disable allowed-root checks (**dangerous**; avoid on shared or public networks). |
| `OPENCURSOR_DATA_DIR` | Override persisted data directory (workspaces profile, auth state, agent sessions, etc.). Default: OS-specific app data path (e.g. `~/.local/state/opencursor` on Linux, `%LOCALAPPDATA%\OpenCursor\data` on Windows). |

### Authentication (optional)

If **`OPENCURSOR_AUTH_USERNAME`** and **`OPENCURSOR_AUTH_PASSWORD`** are both set, the server enables login, session cookies, and the `x-opencursor-session-token` header flow.

Optional tuning:

| Variable | Purpose |
| -------- | ------- |
| `OPENCURSOR_AUTH_SESSION_TTL_MS` | Session lifetime. |
| `OPENCURSOR_AUTH_REMEMBER_SESSION_TTL_MS` | Longer TTL for “remember me”. |
| `OPENCURSOR_AUTH_ROTATION_INTERVAL_MS` | Session rotation interval. |
| `OPENCURSOR_AUTH_STATUS_RATE_LIMIT`, `OPENCURSOR_AUTH_STATUS_RATE_LIMIT_WINDOW_MS` | Rate limits for auth status. |
| `OPENCURSOR_LOGIN_RATE_LIMIT`, `OPENCURSOR_LOGIN_RATE_LIMIT_WINDOW_MS` | Login attempts. |
| `OPENCURSOR_API_READ_RATE_LIMIT`, `OPENCURSOR_API_READ_RATE_LIMIT_WINDOW_MS` | General read API. |
| `OPENCURSOR_API_WRITE_RATE_LIMIT`, `OPENCURSOR_API_WRITE_RATE_LIMIT_WINDOW_MS` | General write API. |
| `OPENCURSOR_BROWSER_PROXY_RATE_LIMIT`, `OPENCURSOR_BROWSER_PROXY_RATE_LIMIT_WINDOW_MS` | Browser proxy. |
| `OPENCURSOR_FS_WRITE_RATE_LIMIT`, `OPENCURSOR_FS_WRITE_RATE_LIMIT_WINDOW_MS` | Filesystem writes. |
| `OPENCURSOR_AGENT_WRITE_RATE_LIMIT`, `OPENCURSOR_AGENT_WRITE_RATE_LIMIT_WINDOW_MS` | Agent-related writes. |
| `OPENCURSOR_WS_FS_RATE_LIMIT`, `OPENCURSOR_WS_FS_RATE_LIMIT_WINDOW_MS` | File watcher WebSocket. |
| `OPENCURSOR_WS_AGENT_RATE_LIMIT`, `OPENCURSOR_WS_AGENT_RATE_LIMIT_WINDOW_MS` | Agent WebSocket. |
| `OPENCURSOR_WS_TERMINAL_RATE_LIMIT`, `OPENCURSOR_WS_TERMINAL_RATE_LIMIT_WINDOW_MS` | Terminal WebSocket. |

### Agent backends

| Variable | Description |
| -------- | ----------- |
| `OPENCURSOR_CURSOR_CLI_BIN` | Absolute path to **Cursor Agent** (overrides `PATH`; same as legacy `OPENCURSOR_CURSOR_ACP_BIN`). |
| `OPENCURSOR_CURSOR_ACP_BIN` | Same intent as `OPENCURSOR_CURSOR_CLI_BIN` (either may be set). |
| `OPENCURSOR_CURSOR_AGENT_ARGS` | JSON array of extra argv strings after the binary. |
| `OPENCURSOR_CURSOR_PERMISSION_MODE` | Passed through to the Cursor CLI permission mode (e.g. `default`); see Cursor CLI docs. |
| `OPENCURSOR_OPENCODE_ACP_BIN` | Absolute path to **OpenCode** ACP binary; otherwise resolved via `PATH` / `~/.opencode/bin`. |
| `OPENCURSOR_REAL_HOME` | When the server runs with a different `$HOME` (Docker/systemd), set to the real user home so `~/.opencode` resolution matches your install. |
| `OPENCURSOR_CODEX_BIN` | **Codex** CLI path for the `codex-adapter` backend. |
| `OPENCURSOR_CLAUDE_BIN` | **Claude** CLI path for the `claude-adapter` backend. |
| `OPENCURSOR_ACP_CLIENT_CAPABILITIES_JSON` | JSON merged into ACP `initialize.clientCapabilities` (e.g. `{"terminal":true}` if the CLI requires it). |
| `OPENCURSOR_AGENT_HANDOFF_MESSAGE_LIMIT` | Recent message pairs to include when handing off to another agent (default `25`). |

### Transcription (voice input)

The server accepts **`baseUrl`**, **`apiKey`**, and **`model`** from env, optional JSON file, or inline JSON. Env vars take precedence over file defaults for each field that is set.

| Variable | Description |
| -------- | ----------- |
| `OPENCURSOR_TRANSCRIPTION_BASE_URL` | OpenAI-compatible API base (e.g. `https://api.openai.com/v1` or Groq OpenAI-compatible URL). |
| `OPENCURSOR_TRANSCRIPTION_API_KEY` | API key. Also accepts `OPENAI_API_KEY` or `GROQ_API_KEY` as fallbacks when this is unset. |
| `OPENCURSOR_TRANSCRIPTION_MODEL` | Model id for the transcription endpoint. |
| `OPENCURSOR_TRANSCRIPTION_LANGUAGE` | Default language hint (optional). |
| `OPENCURSOR_TRANSCRIPTION_PROMPT` | Default prompt hint (optional). |
| `OPENCURSOR_TRANSCRIPTION_CONFIG_FILE` | Path to a JSON file `{ "baseUrl", "apiKey", "model" }`. |
| `OPENCURSOR_TRANSCRIPTION_CONFIG_JSON` | Same object as a single-line JSON string (useful for secrets in PaaS). |

File fallback locations include `server/transcription-provider.json` (see `server/transcription-provider.json.example`) and paths under `OPENCURSOR_DATA_DIR`. **`GET /health`** reports whether transcription is configured.

### Browser proxy

The **`/browser`** routes proxy HTTP fetches with an allowlist. Relevant env:

| Variable | Description |
| -------- | ----------- |
| `BROWSER_PROXY_ALLOW_PUBLIC` | Default allows public internet hosts. Set to `0` or `false` for **private/LAN-only** resolution (stricter; recommended if the API is exposed untrusted). |
| `BROWSER_PROXY_EXTRA_HOSTS` | Comma-separated extra hostnames to allow. |

## Workspace safety

By default, allowed workspace roots include your **home directory**, **`WORKSPACE_ROOT`** (if set), and the **repo root** derived from `process.cwd()`. Setting **`WORKSPACE_ALLOWED_ROOTS`** narrows this to an explicit list. **`OPENCURSOR_ALLOW_ANY_WORKSPACE_ROOT=1`** disables checks entirely.

## Tests (server)

```bash
npm test --prefix server
```

## Troubleshooting

- **Browser cannot reach API / CORS errors:** Set `NEXT_PUBLIC_SERVER_URL` to the actual server origin and add the **exact** Next.js origin (including scheme and port) to `ALLOWED_ORIGINS`.
- **Agent backend “not available”:** Install the CLI or set the corresponding `OPENCURSOR_*_BIN` path; for OpenCode in containers, set `OPENCURSOR_REAL_HOME`.
- **Transcription 503 / not configured:** Set transcription env vars or a config file; check `GET /health` on the server.
- **ChunkLoadError after upgrade:** `DISABLE_NEXT_PWA=1` for Next, or hard-refresh; dev mode sets `no-store` on `/_next/static` to reduce this.

## License / project meta

This repository is private (`"private": true` in `package.json`). Adjust as needed for your distribution.
