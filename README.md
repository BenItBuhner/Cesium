<p align="center">
  <img src="docs/media/logo.png" alt="Cesium" width="96" height="96">
</p>

<h1 align="center">Cesium</h1>

<p align="center">
  <strong>Every agent. Your machine. One workbench.</strong><br>
  Chat with any coding agent, edit real files, and run real terminals - on your machine, from anywhere.
</p>

<p align="center">
  <a href="https://cesium.techlitnow.com">Website</a> ·
  <a href="https://cesium.techlitnow.com/download">Download</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#one-engine-every-screen">Apps</a> ·
  <a href="#configuration-reference">Configuration</a> ·
  <a href="#deployment">Deployment</a>
</p>

<p align="center">
  <a href="https://github.com/BenItBuhner/Cesium/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/BenItBuhner/Cesium?label=release&color=1f2937"></a>
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-1f2937"></a>
  <a href="https://github.com/BenItBuhner/Cesium/actions/workflows/desktop-ci.yml"><img alt="Desktop CI" src="https://github.com/BenItBuhner/Cesium/actions/workflows/desktop-ci.yml/badge.svg"></a>
  <a href="https://github.com/BenItBuhner/Cesium/actions/workflows/mobile-android-ci.yml"><img alt="Android CI" src="https://github.com/BenItBuhner/Cesium/actions/workflows/mobile-android-ci.yml/badge.svg"></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/hero-dark.webp">
    <img alt="The Cesium workbench: an agent conversation explaining how the Wear OS app receives agent status, with tool-call summaries, headers, and code references, next to a rail of recent chats" src="docs/media/hero-light.webp" width="1440">
  </picture>
</p>

## What is Cesium?

Cesium is a **local-first AI workbench**. It gives every coding agent you already use one home: a chat that shows its work, an editor on the folders on your disk, and terminals you can take over at any moment. The engine that touches your files runs on hardware you control; the clients open from wherever you are.

- **One composer, many agents.** Cesium Agent (first-party), Cursor, Codex, Claude Code, OpenCode, Devin, Grok Build, Pi Agent, and Google Antigravity. Switch agents mid-thread and recent context travels with the handoff.
- **You approve every tool call.** Terminal commands, file edits, and connected tools pause for permission, whichever agent is driving.
- **A real IDE beside the chat.** Monaco editor, tabs, split groups, and xterm terminals against real directories - not a sandbox.
- **Local roots, cloud reach.** The engine is a Bun + Hono server that lives with your code. Open it from a browser, the desktop app, a phone, a tablet, or a watch. Optional sync (Convex + Clerk) carries settings and conversations between devices; your source never has to leave home.
- **Files by default, a database when you need one.** Plain JSON storage with zero services to run; switch to Postgres + Redis when you scale.

## See it in action

<p align="center">
  <img src="docs/media/demo.webp" alt="Animated demo: typing a question into the composer, the agent planning todos, grepping and reading files, pausing on a permission card that is approved, then streaming back a list of supported agent harnesses" width="960">
</p>

<p align="center"><sub>A real session against this repository: ask, watch the agent plan and search, approve the shell commands it wants to run, and read the answer - about a minute end to end.</sub></p>

## Highlights

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/media/feature-permission.webp" alt="A permission card asking to run a find command, with Allow, Always allow, Reject and Always reject buttons; the rail shows the chat under Needs attention">
      <p><strong>Approve every tool call.</strong> Shell commands and edits wait for you - allow once, always allow, or reject. The rail groups anything that needs attention so nothing stalls silently.</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/media/feature-backends.webp" alt="The composer's harness picker listing Cesium Agent, Cursor, Codex, OpenCode, Devin, Grok Build, Claude Code, Pi Agent and Google Antigravity, next to a searchable model list">
      <p><strong>Works with the agents you already use.</strong> Pick a harness and a model from one composer. Bring your own keys and CLIs; you own the accounts.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/media/feature-ide.webp" alt="The workbench pane open beside the chat: a TypeScript test file in the Monaco editor above a terminal running git log">
      <p><strong>A real IDE beside the chat.</strong> Open files the agent touched, split editors, and run terminals in the same window. Watch what your agents run, scroll back through it, and take over whenever you want.</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/media/feature-quickopen.webp" alt="The Quick Open palette with Files, Chats, Commands, Settings and Tabs scopes, matching a test file">
      <p><strong>Quick Open for everything.</strong> One palette for files, chats, commands, settings, and tabs, with keyboard scopes (<code>&gt;</code> commands, <code>@</code> chats, <code>#</code> settings).</p>
    </td>
  </tr>
</table>

## One engine, every screen

Start a task at your desk. Approve the last tool call from the couch. Every client talks to the same engine over REST and WebSockets, so a conversation you start in one place is waiting for you in the others.

### Desktop

<p align="center">
  <img src="docs/media/desktop-electron-dark.webp" alt="The Cesium desktop app: a frameless window with its own window controls showing the same workbench in dark mode" width="1440">
</p>

A native windowed workbench for **macOS, Windows, and Linux** with the engine embedded - install it and start chatting, no terminal required. Installers (`.dmg`/`.zip`, `-setup.exe`, `.AppImage`/`.deb`, x64 and arm64) ship with every [release](https://github.com/BenItBuhner/Cesium/releases/latest).

### Web

<p align="center">
  <img src="docs/media/home-dark.webp" alt="The new-chat home screen: workspace, branch and engine pickers above the composer, quick actions, and a list of recent conversations" width="1440">
</p>

The same workbench in any modern browser, installable as a PWA. Run it next to your engine with `npm run dev`, or use the hosted client at [cesium.techlitnow.com](https://cesium.techlitnow.com) and pair it with an engine you install anywhere with one command (see [Terminal](#terminal)).

### Phone and tablet

<p align="center">
  <img src="docs/media/mobile-trio.webp" alt="Three phone screens: the new-chat home, a full agent answer with code references, and the navigation drawer listing recent conversations" width="1100">
</p>

The **Android** app wraps the workbench in a native shell: full conversations with approvals, the editor panel, a navigation drawer, share-to-Cesium intake, and notifications with quick actions when an agent needs you. A touch-tuned layout covers tablets. The APK ships with every release; **iOS** builds from source (`npm --prefix apps/mobile run build:ios:sim`).

### Watch

<p align="center">
  <img src="docs/media/watch-trio.webp" alt="Three Wear OS watch faces: a live agent status card with title and current activity, a Needs Input card for a pending terminal command, and a Controls screen with Pause, Resume and Cancel" width="1100">
</p>

The **Wear OS** companion keeps the focused agent on your wrist: what it is doing right now, a highlighted card the moment it needs input, and pause / resume / cancel without reaching for the phone - plus a tile and complication for your watch face. Status and actions relay through the paired phone over the Wear Data Layer.

### Terminal

```bash
npx cesium-workbench install      # install a headless engine under ~/.cesium (add --local for loopback only)
cesium start                      # start it (plus the tunnel when configured)
cesium status                     # engine / tunnel / rendezvous status
cesium connect                    # print a client connect URL
cesium logs server                # tail engine logs
```

The `cesium` CLI installs, starts, updates, and pairs an engine on a server, a homelab box, or a Raspberry Pi. Public access always requires the engine's generated credentials plus a tunnel or reverse proxy - a pasted URL is never enough to expose a machine.

## Quick start

Run Cesium from source. You need **Node.js** (current LTS), **npm**, and **Bun** (the engine runtime).

```bash
git clone https://github.com/BenItBuhner/Cesium.git && cd Cesium
npm install && npm install --prefix server
npm run build:packages            # shared workspace packages the server imports
cp .env.example .env.local        # set WORKSPACE_ROOT to the folder to open first
```

On Windows PowerShell use `Copy-Item .env.example .env.local` for the last step; keep `NEXT_PUBLIC_SERVER_URL=http://localhost:9100` unless you move the engine.

Then, in two terminals:

```bash
npm run dev:server                # engine on http://127.0.0.1:9100
npm run dev                       # web client on http://localhost:3000
```

Open [http://localhost:3000](http://localhost:3000), continue as a guest (or sign in), pick a workspace folder, choose an agent and model in the composer, and send a message. Settings holds API keys, enabled models, permission behavior, storage, and themes.

Optional extras:

- **Agent CLIs.** Install any of Cursor Agent, Codex, Claude Code, OpenCode, Devin, or Google Antigravity and Cesium detects them; override paths with the `OPENCURSOR_*_BIN` variables in [`.env.example`](.env.example). Antigravity installs in one click from Settings → Agents.
- **Model providers for Cesium Agent.** Add keys under Settings → Agents → Cesium Agent, or export `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, and friends. Any OpenAI-compatible host works via `CESIUM_BASE_URL` + `CESIUM_DEFAULT_MODEL`.
- **Voice input.** Point `OPENCURSOR_TRANSCRIPTION_*` at any OpenAI-compatible transcription endpoint and dictate prompts.
- **Postgres + Redis.** `docker compose up -d && npm --prefix server run db:migrate`, then set `DATABASE_URL` (see [Storage](#storage-backends)).

## How it fits together

| Path | What lives there |
| --- | --- |
| `src/`, `apps/web` | The Next.js web client: workbench (`/agent`), landing page, `/download`, sign-in |
| `apps/desktop`, `apps/desktop-renderer` | Electron shell and the Vite-built renderer it shares with mobile |
| `apps/mobile` | React Native shell for Android and iOS; the Wear OS app lives in `android/wear` |
| `server/` | The engine: Bun + Hono REST API, `/ws/agent`, `/ws/terminal`, `/ws/fs`, agent runtimes, storage drivers |
| `packages/` | Shared core, contracts, client SDK, UI, and the `cesium-workbench` CLI |
| `convex/` | Optional cloud sync (Convex functions and schema) |

The client is a window onto your machine; nothing sensitive lives in it. The engine holds the workspaces, files, terminals, and agent sessions, and adds auth and rate limits the moment you open it beyond this computer. Clients register one or more directories as workspaces and send `x-opencursor-workspace-id` on API calls; live agent output streams over `/ws/agent`, terminals over `/ws/terminal`, and file changes over `/ws/fs`. Voice input posts audio to `POST /api/audio/transcriptions` (OpenAI-compatible multipart).

## Configuration reference

The canonical, commented list of variables is [`.env.example`](.env.example). The server loads `.env`, then `.env.local`, then `server/.env`, then `server/.env.local`; later files win and real process env wins over all of them.

<details>
<summary><strong>Frontend (Next.js)</strong></summary>

| Variable | Description |
| --- | --- |
| `NEXT_PUBLIC_SERVER_URL` | Base URL of the engine (no trailing slash), e.g. `http://localhost:9100` or `http://192.168.1.10:9100`. Required for a non-default host/port. |
| `NEXT_ALLOWED_DEV_ORIGINS` | Space- or comma-separated origins allowed for dev HMR/assets when not using localhost (see `next.config.ts`). |
| `ENABLE_NEXT_PWA` | Set to `1` before building/running Next to enable the service worker. Off by default to avoid stale local chunks. |

</details>

<details>
<summary><strong>Engine: listen address and CORS</strong></summary>

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `9100` | HTTP port. |
| `HOST` | `127.0.0.1` | Bind address. `0.0.0.0` is refused unless `OPENCURSOR_AUTH_USERNAME` and `OPENCURSOR_AUTH_PASSWORD` are both set. |
| `PUBLIC_HOST` | `localhost` when `HOST` is `0.0.0.0`, else `HOST` | Used to build the default CORS allowlist (port `3000`). |
| `ALLOWED_ORIGINS` | Derived from `PUBLIC_HOST` + localhost | Comma-separated browser origins allowed to call the API with credentials. Set this when you open the client from a LAN IP or custom host. |

</details>

<details>
<summary><strong>Workspaces and data</strong></summary>

| Variable | Description |
| --- | --- |
| `WORKSPACE_ROOT` | Folder opened on first bootstrap. Must fall under an allowed root. Unset: the repository root (parent of `server/` when cwd is `server/`). |
| `WORKSPACE_ALLOWED_ROOTS` | Comma-separated absolute directories. When set, only these paths may be workspace roots (no repo-root fallback). |
| `OPENCURSOR_ALLOW_ANY_WORKSPACE_ROOT` | `1` disables allowed-root checks. Dangerous on shared or public networks. |
| `OPENCURSOR_DATA_DIR` | Persisted data directory (workspace profile, auth state, agent sessions). Default: OS app-data path, e.g. `~/.local/state/cesium` on Linux or `%LOCALAPPDATA%\Cesium\data` on Windows. |

By default the allowed workspace roots are your home directory, `WORKSPACE_ROOT` (if set), and the repo root derived from `process.cwd()`.

</details>

<details>
<summary><strong>Authentication and rate limits</strong></summary>

When both `OPENCURSOR_AUTH_USERNAME` and `OPENCURSOR_AUTH_PASSWORD` are set, the engine enables login, session cookies, and the `x-opencursor-session-token` header flow.

| Variable | Purpose |
| --- | --- |
| `OPENCURSOR_AUTH_SESSION_TTL_MS` | Session lifetime. |
| `OPENCURSOR_AUTH_REMEMBER_SESSION_TTL_MS` | Longer TTL for "remember me". |
| `OPENCURSOR_AUTH_ROTATION_INTERVAL_MS` | Session rotation interval. |
| `OPENCURSOR_AUTH_STATUS_RATE_LIMIT`, `..._WINDOW_MS` | Auth status checks. |
| `OPENCURSOR_LOGIN_RATE_LIMIT`, `..._WINDOW_MS` | Login attempts. |
| `OPENCURSOR_API_READ_RATE_LIMIT`, `..._WINDOW_MS` | General read API. |
| `OPENCURSOR_API_WRITE_RATE_LIMIT`, `..._WINDOW_MS` | General write API. |
| `OPENCURSOR_BROWSER_PROXY_RATE_LIMIT`, `..._WINDOW_MS` | Browser proxy. |
| `OPENCURSOR_FS_WRITE_RATE_LIMIT`, `..._WINDOW_MS` | Filesystem writes. |
| `OPENCURSOR_AGENT_WRITE_RATE_LIMIT`, `..._WINDOW_MS` | Agent-related writes. |
| `OPENCURSOR_WS_FS_RATE_LIMIT`, `..._WINDOW_MS` | File watcher WebSocket. |
| `OPENCURSOR_WS_AGENT_RATE_LIMIT`, `..._WINDOW_MS` | Agent WebSocket. |
| `OPENCURSOR_WS_TERMINAL_RATE_LIMIT`, `..._WINDOW_MS` | Terminal WebSocket. |

</details>

<details>
<summary><strong>Agent backends</strong></summary>

| Variable | Description |
| --- | --- |
| `CURSOR_API_KEY` | Cursor SDK API key. Otherwise configure it in Settings; stored credentials live under `OPENCURSOR_DATA_DIR`. |
| `OPENCURSOR_CURSOR_CLI_BIN` / `OPENCURSOR_CURSOR_ACP_BIN` | Absolute path to Cursor Agent (overrides `PATH`; either name works). |
| `OPENCURSOR_CURSOR_AGENT_ARGS` | JSON array of extra argv after the binary. |
| `OPENCURSOR_CURSOR_PERMISSION_MODE` | Passed through to the Cursor CLI permission mode (e.g. `default`). |
| `OPENCURSOR_OPENCODE_ACP_BIN` | Absolute path to the OpenCode ACP binary; otherwise resolved via `PATH` / `~/.opencode/bin`. |
| `OPENCURSOR_REAL_HOME` | When the engine runs with a different `$HOME` (Docker/systemd), the real user home so `~/.opencode` resolves. |
| `OPENCURSOR_DEVIN_CLI_BIN` | Absolute path to the Devin CLI for `devin-acp`; otherwise `devin` on `PATH` / `~/.local/bin/devin`. |
| `OPENCURSOR_DEVIN_CLI_ARGS` | JSON array of argv after the Devin binary (default `["acp"]`). |
| `WINDSURF_API_KEY` | Devin/Windsurf API key when `devin auth login` credentials are unavailable. |
| `OPENCURSOR_ANTIGRAVITY_ACP_BIN` | Absolute path to Google's Antigravity ACP server (`agy_acp_server.par` / `.exe`). Otherwise Cesium checks its own tools dir (one-click install), Zed's `external_agents/registry/antigravity-acp/`, then `PATH`. |
| `OPENCURSOR_ANTIGRAVITY_ACP_ARGS` | JSON array replacing the server's default argv (the registry manifest passes `["--uid="]` on Linux). |
| `OPENCURSOR_ANTIGRAVITY_ACP_HOME` | Overrides the `GEMINI_HOME` the ACP server stores credentials and sessions under (default `~/.gemini`). |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Enables the headless `gemini-api-key` auth method for the Antigravity ACP server. |
| `OPENCURSOR_ANTIGRAVITY_CLI_BIN` / `OPENCURSOR_AGY_BIN` | Absolute path to the legacy Antigravity CLI (`agy`); otherwise `agy` on `PATH`. |
| `OPENCURSOR_CODEX_BIN` | Codex CLI path for `codex-app-server` / `codex-acp`; otherwise `codex` on `PATH` or common tool dirs. Model, provider and MCP servers come from `~/.codex/config.toml` (custom `model_provider` entries are honoured). |
| `OPENCURSOR_CODEX_APP_SERVER_ALLOW_BYPASS` | `1` lets the Codex "Bypass Permissions" execution mode map to `approvalPolicy: never` + `dangerFullAccess`; otherwise it behaves like Workspace Write. |
| `OPENCURSOR_CODEX_APP_SERVER_ASK_IN_AGENT_MODE` | `1` enables Codex's `default_mode_request_user_input` feature so the question tool is available in Agent mode too (always available in Plan mode). |
| `OPENCURSOR_CODEX_APP_SERVER_SETTLE_GRACE_MS` | Wait for `turn/completed` after Codex reports the thread idle/errored before settling the turn anyway (default `8000`). |
| `OPENCURSOR_CLAUDE_BIN` | Claude CLI path. |
| `OPENCURSOR_ACP_CLIENT_CAPABILITIES_JSON` | JSON merged into ACP `initialize.clientCapabilities` (e.g. `{"terminal":true}`). |
| `OPENCURSOR_AGENT_HANDOFF_MESSAGE_LIMIT` | Recent message pairs included when handing off to another agent (default `25`). |

Cesium Agent provider keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`, `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`, `NVIDIA_API_KEY`, `CEREBRAS_API_KEY`, `CROFAI_API_KEY`. For any OpenAI-compatible host set `CESIUM_BASE_URL` (falls back to `OPENAI_BASE_URL`), `CESIUM_API_KEY` (falls back to `OPENAI_API_KEY`), `CESIUM_DEFAULT_MODEL`, and optionally `CESIUM_PROVIDER_ID` / `CESIUM_MODELS`.

</details>

<details>
<summary><strong>Transcription (voice input)</strong></summary>

The engine accepts `baseUrl`, `apiKey`, and `model` from env, a JSON file, or inline JSON; env wins per field.

| Variable | Description |
| --- | --- |
| `OPENCURSOR_TRANSCRIPTION_BASE_URL` | OpenAI-compatible API base (OpenAI, Groq, and similar). |
| `OPENCURSOR_TRANSCRIPTION_API_KEY` | API key. Falls back to `OPENAI_API_KEY`, then `GROQ_API_KEY`. |
| `OPENCURSOR_TRANSCRIPTION_MODEL` | Model id for the transcription endpoint. |
| `OPENCURSOR_TRANSCRIPTION_LANGUAGE` | Default language hint. |
| `OPENCURSOR_TRANSCRIPTION_PROMPT` | Default prompt hint. |
| `OPENCURSOR_TRANSCRIPTION_CONFIG_FILE` | Path to a JSON file `{ "baseUrl", "apiKey", "model" }`. |
| `OPENCURSOR_TRANSCRIPTION_CONFIG_JSON` | The same object as a single-line JSON string (handy for PaaS secrets). |
| `OPENCURSOR_TRANSCRIPTION_MAX_RETRIES` | Automatic retries with exponential backoff for network errors and 408/429/5xx (default `5`, `0` disables). |
| `OPENCURSOR_TRANSCRIPTION_RETRY_BASE_DELAY_MS` | First backoff delay, doubled per retry (default `500`). |
| `OPENCURSOR_TRANSCRIPTION_RETRY_MAX_DELAY_MS` | Cap for a single backoff delay (default `8000`). |

File fallbacks include `server/transcription-provider.json` (see `server/transcription-provider.json.example`) and paths under `OPENCURSOR_DATA_DIR`. `GET /health` reports whether transcription is configured. When a transcription still fails after the retries, the composer keeps the recording: the mic button becomes a retry button, and after the third failure a notification offers to save the audio under `.cesium/tmp/recordings/` in the workspace.

</details>

<details>
<summary><strong>Browser proxy</strong></summary>

The `/browser` routes proxy HTTP fetches through an allowlist.

| Variable | Description |
| --- | --- |
| `BROWSER_PROXY_ALLOW_PUBLIC` | Default allows public internet hosts. Set to `0` or `false` for private/LAN-only resolution (recommended if the API is exposed to untrusted networks). |
| `BROWSER_PROXY_EXTRA_HOSTS` | Comma-separated extra hostnames to allow. |

</details>

## Storage backends

Cesium ships two interchangeable storage drivers and a tool to move data between them at any time.

- **`legacy-json`** (default): workspaces, sessions, auth, and agent events as JSON/JSONL files under `OPENCURSOR_DATA_DIR`. No external services.
- **`pg`**: the same data in Postgres via Drizzle ORM with optimistic concurrency, plus Redis (when configured) for pub/sub, cache, and cross-process rate limits.

Driver resolution, first match wins: `OPENCURSOR_STORAGE_DRIVER` (`legacy-json` or `pg`), then `DATABASE_URL` set → `pg`, otherwise `legacy-json`. On boot the engine prints a one-time banner when `pg` is active but a legacy data directory still holds data, pointing you at the migration command.

<details>
<summary><strong>Variables and migration commands</strong></summary>

| Variable | Description |
| --- | --- |
| `OPENCURSOR_STORAGE_DRIVER` | Force `legacy-json` or `pg`. Omit to let `DATABASE_URL` choose. |
| `DATABASE_URL` | Postgres connection string. Matches `docker-compose.yml` (`postgres://cesium:cesium@localhost:5433/cesium`). |
| `DATABASE_POOL_MAX` | Max Postgres pool size (default `10`). |
| `DATABASE_IDLE_TIMEOUT_SEC` | Pool idle timeout (default `20`). |
| `DATABASE_CONNECT_TIMEOUT_SEC` | Pool connect timeout (default `10`). |
| `REDIS_URL` | Optional. Enables shared pub/sub, KV cache, and rate limits across processes; unset falls back to in-process `EventEmitter` + `Map`. |
| `OPENCURSOR_REDIS_DEBUG` | `1` logs Redis errors (otherwise the fallback absorbs them). |

Run Postgres, Redis, and Adminer locally with the values baked into `.env.example`:

```bash
docker compose up -d
npm --prefix server run db:migrate
```

Move data between drivers from `server/`:

```bash
npm run storage:stats                                              # counts per driver
npm run storage:migrate -- --from legacy-json --to pg              # JSON → Postgres
npm run storage:migrate -- --from pg --to legacy-json             # Postgres → JSON
npm run storage:migrate -- --from legacy-json --to pg --overwrite # source wins
```

The same flow lives in **Settings → Storage** with live progress and per-driver NDJSON export/import. REST endpoints for scripts and CI: `GET /api/storage/status`, `POST /api/storage/migrate` (streams NDJSON progress), `GET /api/storage/export?driver=pg`, `POST /api/storage/import?driver=pg&overwrite=1`.

</details>

## Deployment

<details>
<summary><strong>Production build and checklist</strong></summary>

Build both apps, then run them as two long-lived processes:

```bash
npm run build && npm --prefix server run build
npm run start                     # Next.js
npm --prefix server run start     # engine on PORT (default 9100)
```

`npm run prod` builds both and uses the `start:all` helper where `bash` is available. Enable the PWA service worker only deliberately, with `ENABLE_NEXT_PWA=1` at build/run time.

- Point `NEXT_PUBLIC_SERVER_URL` at the engine origin the browser can reach.
- Set `ALLOWED_ORIGINS` to the exact frontend origin.
- Set `WORKSPACE_ALLOWED_ROOTS` to the folders users may open.
- Set `OPENCURSOR_AUTH_USERNAME` and `OPENCURSOR_AUTH_PASSWORD` if anyone but you can reach the engine.
- Use Postgres/Redis for persistent multi-process deployments; keep `legacy-json` for simple local installs.

</details>

<details>
<summary><strong>Hosting the client on Vercel (Clerk + Convex)</strong></summary>

The Next.js client is designed to run on Vercel while every user brings their own engine (the desktop app, or `npx cesium-workbench install` on their hardware).

1. **Vercel project.** Import the repo (root directory is the Next app; `vercel.json` pins the framework). Add your domain and set `NEXT_PUBLIC_SITE_URL=https://your.domain` so robots, sitemap, and Open Graph metadata use the canonical origin.
2. **Convex (database).** Schema and functions live in `convex/`. The build command `node scripts/vercel-build.mjs` runs `npx convex deploy` before `next build` whenever `CONVEX_DEPLOY_KEY` is set, so merging a change under `convex/` ships backend and web app together. Add a Production deploy key (Convex dashboard → Settings → Deploy Keys) in Vercel → Environment Variables; optionally a Preview key for per-branch deployments. Builds without the key skip the Convex step and use the committed production URL. Set `NEXT_PUBLIC_CONVEX_URL` on Vercel, and commit the deployment URL plus Clerk publishable key (both public-safe) to `src/lib/cloud/cloud-defaults.ts` so packaged desktop and mobile apps default to production cloud behavior too. Every client keeps a runtime local-only switch in Settings → Account.
3. **Clerk (authentication).** Create a Clerk app, add a JWT template named `convex`, and set `CLERK_JWT_ISSUER_DOMAIN` on the Convex deployment (`npx convex env set CLERK_JWT_ISSUER_DOMAIN https://...`). On Vercel set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`. Hosted sign-in and sign-up pages ship at `/sign-in` and `/sign-up`.
4. **Gate the workbench (optional).** `NEXT_PUBLIC_CESIUM_REQUIRE_SIGN_IN=1` requires a Clerk account for the workbench routes; the landing page, `/download`, the auth pages, and the engine rendezvous API stay public.
5. **Engine rendezvous.** Add an Upstash Redis (or Vercel KV) integration so `/api/rendezvous` can pair installed engines with signed-in browsers (`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` or `KV_REST_API_URL`/`KV_REST_API_TOKEN`).
6. **Downloads.** `/download` detects the visitor's platform and serves the latest GitHub release assets via `/api/releases/latest` (set `GITHUB_RELEASES_TOKEN` for a higher upstream rate limit if needed).

End-user flow once deployed: install the desktop app from `/download` (or run `npx cesium-workbench install` for a headless engine), sign up at `/sign-up`, and the workbench connects the account to the engine. Servers, preferences, and conversation snapshots sync across devices through Convex.

</details>

## Troubleshooting

- **Browser cannot reach the API / CORS errors.** Set `NEXT_PUBLIC_SERVER_URL` to the actual engine origin and add the exact Next.js origin (scheme and port) to `ALLOWED_ORIGINS`.
- **Agent backend "not available".** Install the CLI or set the matching `OPENCURSOR_*_BIN` path; for OpenCode in containers, set `OPENCURSOR_REAL_HOME`.
- **Transcription 503 / not configured.** Set the transcription variables or a config file; check `GET /health` on the engine.
- **`ERR_MODULE_NOT_FOUND` for `@cesium/core/dist/...`.** Run `npm run build:packages`; the engine and its tests import the built workspace packages.
- **ChunkLoadError after upgrading.** Only relevant if you opted into the PWA with `ENABLE_NEXT_PWA=1`: hard-refresh or unregister the service worker after local rebuilds.

## Development

```bash
npm run typecheck                 # Next.js typegen + tsc for the web client
npm test                          # web client unit tests
npm test --prefix server          # engine tests (build packages first)
npm run build:all                 # packages, web, desktop, mobile
```

Platform builds: `npm run build:desktop`, `npm --prefix apps/mobile run build:android:debug` (phone and Wear APKs), `npm --prefix apps/mobile run build:ios:sim`. Releases are cut from tags by the [Release workflow](.github/workflows/release.yml), which publishes the desktop installers plus the Android and Wear OS APKs.

## License

Cesium is open source under the [GNU Affero General Public License v3.0](LICENSE).
