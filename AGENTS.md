# AGENTS.md

## Cursor Cloud specific instructions

Cesium is a local-first AI workbench: a **Next.js frontend** (port `3000`) and a
**Bun + Hono backend** (port `9100`). Standard install/run/test commands live in
`README.md` and the `scripts` blocks of `package.json` / `server/package.json`.
Default storage is the file-based `legacy-json` driver, so **no Docker / Postgres /
Redis is required** (those services are optional and not installed here).

Run the two dev servers in separate terminals from the repo root:
- Backend: `npm run dev:server` (Bun runtime, listens on `9100`).
- Frontend: `npm run dev` (Next.js dev, `3000`). Uses `.env.local` (already created
  for local dev with `NEXT_PUBLIC_SERVER_URL=http://localhost:9100` and
  `WORKSPACE_ROOT=/workspace`).

Non-obvious caveats discovered during setup (the startup update script already
handles the first two, but you must repeat them by hand if you re-run installs):

- **`bun` is required for the backend** and lives at `~/.bun/bin` (added to
  `~/.bashrc`). A non-login shell may not have it on `PATH`; export
  `PATH="$HOME/.bun/bin:$PATH"` if `bun` is not found.
- **Remove the self-referential symlink `server/node_modules/cesium`** after any
  `npm install` / `npm install --prefix server`. The server's `"cesium": "file:.."`
  dependency symlinks that path back to the repo root; Next.js dev (Turbopack) then
  panics with an infinite `track_glob` loop ("`server/node_modules/cesium` is a
  symlink that causes an infinite loop") and every page returns HTTP 500. Nothing
  in the server actually imports the `cesium` package, so `rm -f
  server/node_modules/cesium` is safe. If the frontend was already running when the
  symlink reappeared, its next request may 500 until the symlink is gone.
- **Build the shared workspace packages before running/testing the server:**
  `npm run build:packages`. The backend and its tests import `@cesium/core/dist/*`,
  so without a build you get `ERR_MODULE_NOT_FOUND` for `@cesium/core/dist/mcp.js`
  and ~7 server test files fail.
- **Integrated terminal uses Bun.Terminal under Bun** (POSIX). The old `node-pty`
  path stays as a Node/desktop fallback only — do **not** switch the server to
  Node just for terminals. Deno is not used or supported.
- **Agent backends need external CLIs / API keys** (Cursor, Codex, Claude, Gemini,
  OpenCode) that are not installed. The app still boots and lists them as
  unavailable; sending a chat without a configured backend surfaces a
  "Compilation failed / Provider responded" toast. This is expected, not an
  environment break.

### Inference / model provider environment variables

The built-in `cesium-agent` backend is the one that talks to LLM providers over
HTTP (`/chat/completions` or `/responses`). Important nuance about how it is
configured (verified in `server/src/lib/cesium-agent-settings.ts`):

- **The only provider fields read from the environment are API keys, and only for
  three built-in providers** (`server/src/lib/cesium-agent-settings.ts`,
  `BUILTIN_ENV_KEYS`):
  - `OPENAI_API_KEY` — OpenAI (and the default "OpenAI-compatible" path).
  - `ANTHROPIC_API_KEY` — Anthropic.
  - `GOOGLE_API_KEY` — Google.
- **There is NO environment variable for the chat base URL or default model.**
  - Base URL: implicit `https://api.openai.com/v1` for OpenAI; other known hosts
    (groq, openrouter, deepseek, mistral, xai, togetherai, fireworks, nvidia,
    cerebras) use a hardcoded map (`BUILTIN_PROVIDER_BASE_URLS`); a fully custom
    OpenAI-compatible host's base URL must be saved in Settings → Agents → Cesium
    Agent (persisted to `{OPENCURSOR_DATA_DIR}/profile/cesium-agent-settings.json`,
    or via `PUT /api/settings/cesium-agent/provider-key` with `{apiKind,apiKey,baseUrl}`).
  - Default model: `defaultModelId` in that same settings JSON (default
    `openai/gpt-5.1`), or just picked per-conversation in the composer's model
    picker — not an env var.
  - Note: providers other than openai/anthropic/google also need their key saved
    in Settings (their keys are NOT read from env), even though their base URL is
    known.
- **Simplest env-only inference:** set `OPENAI_API_KEY`; the app then uses OpenAI
  at `https://api.openai.com/v1` and you choose a model (e.g. `openai/gpt-5.1`) in
  the composer or via `defaultModelId`.

The **only** subsystem that accepts a full OpenAI-compatible `base URL + model +
API key` triple purely from env is **speech transcription / title generation**
(not chat), in `server/src/lib/transcription-env.ts`:

- `OPENCURSOR_TRANSCRIPTION_BASE_URL` (falls back to `OPENAI_BASE_URL`)
- `OPENCURSOR_TRANSCRIPTION_MODEL`
- `OPENCURSOR_TRANSCRIPTION_API_KEY` (falls back to `OPENAI_API_KEY`, then `GROQ_API_KEY`)
- Optional: `OPENCURSOR_TITLE_MODEL` (default `openai/gpt-oss-20b`), plus
  `OPENCURSOR_TRANSCRIPTION_CONFIG_JSON` / `OPENCURSOR_TRANSCRIPTION_CONFIG_FILE`.

Secrets added via the Cloud Agent Secrets panel are injected as env vars on the
next VM boot; the server reads them from `process.env` (repo `.env` /`.env.local`
/ `server/.env` / `server/.env.local` are also loaded, but real process env wins).

#### Inference provider for testing

The OpenAI-compatible inference provider to use for testing in this environment:

- **Base URL:** `https://infer.techlitnow.com/v1` (a personal OpenAI-compatible
  model proxy).
- **Preferred model:** `glm-5.2`
- **API key:** provided via the `OPENAI_API_KEY` Cloud Agent secret.

Because the base URL and model are not env-configurable for `cesium-agent` chat
(see above), point Cesium at this proxy in **Settings → Agents → Cesium Agent**
(save an `openai-compatible` provider key with the base URL above), then select
`glm-5.2` as the model.
