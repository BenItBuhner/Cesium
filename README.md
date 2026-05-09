# OpenCursor

OpenCursor is a **local-first AI workbench** for running agent chats and a browser IDE against real folders on your machine. It pairs a **Next.js** frontend with a **Bun + Hono** backend that serves REST/WebSocket APIs for workspaces, file edits, terminals, agent conversations, optional auth, and optional speech-to-text.

- **Frontend**: `http://localhost:3000`
- **Backend / bot server**: `http://localhost:9100`
- **Main UI**: `/` with agent and editor views. Legacy `/agent` and `/editor` routes redirect back to `/`.

In practice: start the backend, start the frontend, open the app, add a workspace folder, choose an agent backend/model, and send a message.

## Prerequisites

- **Node.js** (current LTS recommended; the repo targets Next 16 + React 19).
- **npm** for the frontend and package scripts.
- **Bun** for the backend runtime (`server` runs with `bun src/runtime/bun-server.ts`).
- **Docker Desktop** (optional) if you want local Postgres + Redis instead of the default file-based storage.
- **Agent CLIs** (optional, depending on backends you want):
  - **Cursor Agent** (ACP) on your `PATH` or via `OPENCURSOR_CURSOR_CLI_BIN` / `OPENCURSOR_CURSOR_ACP_BIN`.
  - **Cursor SDK** via `@cursor/sdk` plus a Cursor API key configured in Settings or environment.
  - **Claude Code SDK** via `@anthropic-ai/claude-agent-sdk` plus `ANTHROPIC_API_KEY` or a supported Claude provider env.
  - **OpenCode** ACP binary or install under `~/.opencode/bin` (see `OPENCURSOR_OPENCODE_ACP_BIN`, `OPENCURSOR_REAL_HOME`).
  - **Gemini CLI** in ACP mode (`gemini --acp`; install via `@google/gemini-cli`, or set `OPENCURSOR_GEMINI_CLI_BIN`).
  - **Codex** / **Claude** CLIs if you use those adapter backends (`OPENCURSOR_CODEX_BIN`, `OPENCURSOR_CLAUDE_BIN`).

## Quick Start

From the repository root:

1. **Install dependencies**

   ```bash
   npm install
   npm install --prefix server
   ```

2. **Configure environment**

   Copy `.env.example` to `.env.local` at the repo root and adjust the values for your machine:

   ```bash
   cp .env.example .env.local
   ```

   On Windows PowerShell:

   ```powershell
   Copy-Item .env.example .env.local
   ```

   At minimum, keep `NEXT_PUBLIC_SERVER_URL=http://localhost:9100`. Set `WORKSPACE_ROOT` to the folder you want OpenCursor to open first.

   The server loads variables in this order, with later files overriding earlier ones:

   - repo `.env`
   - repo `.env.local`
   - `server/.env`
   - `server/.env.local`

3. **Optional: start Postgres + Redis**

   OpenCursor can run without Docker using the legacy JSON storage driver. For the faster Postgres/Redis-backed setup:

   ```bash
   docker compose up -d
   npm --prefix server run db:migrate
   ```

   Then set these in `.env.local`:

   ```env
   OPENCURSOR_STORAGE_DRIVER=pg
   DATABASE_URL=postgres://opencursor:opencursor@localhost:5433/opencursor
   REDIS_URL=redis://localhost:6380
   ```

4. **Run the app**

   Use two terminals:

   ```bash
   npm run dev
   ```

   ```bash
   npm run dev:server
   ```

   Open [http://localhost:3000](http://localhost:3000).

5. **Start using it**

   Add or select a workspace folder, open the model picker in the chat composer, choose a harness/backend such as Cursor SDK, Claude Code SDK, Codex, OpenCode, Claude, or Gemini, pick a model, and send a prompt. Use Settings to add API keys, enable/disable models, configure permission behavior, and manage storage.

## Production build

Build both apps:

```bash
npm run build
npm --prefix server run build
```

Run production locally with two long-running processes:

```bash
npm run start
```

```bash
npm --prefix server run start
```

The frontend serves Next with `next start`; the backend serves the Bun runtime on `PORT` (default `9100`). Adjust `HOST`, `PORT`, `NEXT_PUBLIC_SERVER_URL`, `ALLOWED_ORIGINS`, workspace roots, and storage variables for your deployment target.

If your shell supports `bash`, `npm run prod` builds both and uses the repo `start:all` helper. On Windows PowerShell, the two-process flow above is clearer and easier to debug.

**PWA note:** The service worker is disabled by default. To opt in, build/run the frontend with `ENABLE_NEXT_PWA=1`.

### Deployment Checklist

- Run the frontend and backend as separate long-lived processes or services.
- Point `NEXT_PUBLIC_SERVER_URL` at the backend origin visible from the browser.
- Set `ALLOWED_ORIGINS` to the exact frontend origin.
- Set `WORKSPACE_ALLOWED_ROOTS` to the folders users are allowed to open.
- Use `OPENCURSOR_AUTH_USERNAME` and `OPENCURSOR_AUTH_PASSWORD` if the app is reachable by anyone besides you.
- Use Postgres/Redis for persistent multi-process deployments; use legacy JSON only for simple local installs.

## Using the workbench

- **Workspaces:** Register one or more directories; switching workspace sends `x-opencursor-workspace-id` on API calls.
- **Agent view:** Create conversations, choose a **backend** (Cursor SDK, Claude Code SDK, Cursor ACP, OpenCode ACP, Gemini CLI ACP, Codex/Claude adapters when installed), send messages, approve tool permissions when the provider supports it. Live updates use **`/ws/agent`**.
- **IDE view:** Edit files, use integrated **xterm** terminals (**`/ws/terminal`**), file watcher (**`/ws/fs`**).
- **Voice input (optional):** If transcription is configured, the composer can send audio to **`POST /api/audio/transcriptions`** (OpenAI-compatible multipart API).

## Environment variables

### Frontend (Next.js)

| Variable | Description |
| -------- | ----------- |
| `NEXT_PUBLIC_SERVER_URL` | Base URL of the OpenCursor API (no trailing slash), e.g. `http://localhost:9100` or `http://192.168.1.10:9100`. **Required** for a non-default host/port. |
| `NEXT_ALLOWED_DEV_ORIGINS` | Space- or comma-separated origins allowed for dev HMR/assets when not using localhost (see `next.config.ts`). |
| `ENABLE_NEXT_PWA` | Set to `1` before building/running Next if you intentionally want the PWA service worker. It is disabled by default to avoid stale local chunks. |

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

### Storage (Postgres + Redis)

OpenCursor supports two storage drivers. The **legacy JSON/JSONL** driver needs
no external services. The **Postgres** driver stores workspaces, sessions, auth
state, and agent conversations/events in a real database and uses Redis (when
configured) for pub/sub and cache.

Driver resolution (first match wins):

1. `OPENCURSOR_STORAGE_DRIVER` — explicit override. Use `legacy-json` or `pg`.
2. `DATABASE_URL` set → `pg` driver is selected automatically.
3. Otherwise → `legacy-json` driver (same on-disk behavior as earlier releases).

| Variable | Description |
| -------- | ----------- |
| `OPENCURSOR_STORAGE_DRIVER` | Force `legacy-json` or `pg`. Omit to let `DATABASE_URL` choose. |
| `DATABASE_URL` | Postgres connection string. Matches `docker-compose.yml` defaults (`postgres://opencursor:opencursor@localhost:5433/opencursor`). |
| `DATABASE_POOL_MAX` | Max Postgres pool size (default `10`). |
| `DATABASE_IDLE_TIMEOUT_SEC` | Pool idle timeout (default `20`). |
| `DATABASE_CONNECT_TIMEOUT_SEC` | Pool connect timeout (default `10`). |
| `REDIS_URL` | Optional. Enables shared pub/sub, KV cache, and rate limits across processes. Unset falls back to in-process `EventEmitter` + `Map`. |
| `OPENCURSOR_REDIS_DEBUG` | Set to `1` to log Redis errors (otherwise suppressed; the fallback absorbs them). |

### Agent backends

| Variable | Description |
| -------- | ----------- |
| `CURSOR_API_KEY` | Cursor SDK API key. If unset, configure it in the app under Settings; stored credentials are kept under `OPENCURSOR_DATA_DIR`. |
| `ANTHROPIC_API_KEY` | Claude Code SDK API key used by `@anthropic-ai/claude-agent-sdk`. |
| `ANTHROPIC_BASE_URL` / `ANTHROPIC_BETAS` | Optional Anthropic API overrides for Claude Code SDK. |
| `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY` | Optional provider selectors for Claude Code SDK when not using `ANTHROPIC_API_KEY`. |
| `CLAUDE_AGENT_SDK_CLIENT_APP` | Optional client app identifier sent by the Claude Agent SDK. Defaults internally to an OpenCursor identifier. |
| `OPENCURSOR_CLAUDE_CODE_SDK_ALLOW_BYPASS` | Set to `1` to allow the Claude Code SDK `bypassPermissions` mode. Leave unset for normal permission safety. |
| `OPENCURSOR_CURSOR_CLI_BIN` | Absolute path to **Cursor Agent** (overrides `PATH`; same as legacy `OPENCURSOR_CURSOR_ACP_BIN`). |
| `OPENCURSOR_CURSOR_ACP_BIN` | Same intent as `OPENCURSOR_CURSOR_CLI_BIN` (either may be set). |
| `OPENCURSOR_CURSOR_AGENT_ARGS` | JSON array of extra argv strings after the binary. |
| `OPENCURSOR_CURSOR_PERMISSION_MODE` | Passed through to the Cursor CLI permission mode (e.g. `default`); see Cursor CLI docs. |
| `OPENCURSOR_OPENCODE_ACP_BIN` | Absolute path to **OpenCode** ACP binary; otherwise resolved via `PATH` / `~/.opencode/bin`. |
| `OPENCURSOR_REAL_HOME` | When the server runs with a different `$HOME` (Docker/systemd), set to the real user home so `~/.opencode` resolution matches your install. |
| `OPENCURSOR_GEMINI_CLI_BIN` | Absolute path to **Gemini CLI** for the `gemini-acp` backend; otherwise `gemini` on `PATH` / Windows `%AppData%\\npm\\gemini.cmd`. |
| `OPENCURSOR_GEMINI_CLI_ARGS` | JSON array of argv after the Gemini binary for ACP (default `["--acp"]`). |
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

## Storage backends

OpenCursor ships with two interchangeable storage drivers and a tool to move
data between them at any time.

- **Legacy JSON/JSONL** (`legacy-json`) — workspaces, sessions, auth, and agent
  events are stored as files under `OPENCURSOR_DATA_DIR`. No external services
  required. This is the default on a fresh clone.
- **Postgres** (`pg`) — workspaces, sessions, auth, and agent events are stored
  in Postgres via Drizzle ORM with optimistic concurrency (`revision` column).
  Selected automatically when `DATABASE_URL` is set (see
  [Storage (Postgres + Redis)](#storage-postgres--redis)).

### Running Postgres + Redis locally

The repo root `docker-compose.yml` starts Postgres, Redis, and Adminer with the
values baked into `.env.example`:

```bash
docker compose up -d
npm --prefix server run db:migrate
```

### Switching drivers

Flip the driver by setting `OPENCURSOR_STORAGE_DRIVER=pg|legacy-json`. When the
variable is unset, `DATABASE_URL` decides (set → `pg`; unset → `legacy-json`).
On boot, the server prints a one-time banner when `pg` is active but a legacy
data directory still contains data on disk, pointing you at the migration
command.

### Moving data between drivers

Use the CLI from `server/`:

```bash
npm run storage:stats                                    # counts per driver
npm run storage:migrate -- --from legacy-json --to pg    # JSON → Postgres
npm run storage:migrate -- --from pg --to legacy-json    # Postgres → JSON
npm run storage:migrate -- --from legacy-json --to pg --overwrite  # source wins
```

The same flow is also available in the UI under **Settings → Storage**, which
streams live progress and supports per-driver `Export` / `Import` of NDJSON
archives. REST endpoints (for scripts and CI):

- `GET /api/storage/status` — current driver + per-driver counts.
- `POST /api/storage/migrate` — streams NDJSON progress events.
- `GET /api/storage/export?driver=pg` — streams NDJSON archive.
- `POST /api/storage/import?driver=pg&overwrite=1` — applies an archive.

## Tests (server)

```bash
npm test --prefix server
```

## Troubleshooting

- **Browser cannot reach API / CORS errors:** Set `NEXT_PUBLIC_SERVER_URL` to the actual server origin and add the **exact** Next.js origin (including scheme and port) to `ALLOWED_ORIGINS`.
- **Agent backend “not available”:** Install the CLI or set the corresponding `OPENCURSOR_*_BIN` path; for OpenCode in containers, set `OPENCURSOR_REAL_HOME`.
- **Transcription 503 / not configured:** Set transcription env vars or a config file; check `GET /health` on the server.
- **ChunkLoadError after upgrade:** The PWA service worker is disabled by default. If you opted in with `ENABLE_NEXT_PWA=1`, hard-refresh or unregister the service worker after local rebuilds.

## License / project meta

This repository is private (`"private": true` in `package.json`). Adjust as needed for your distribution.
