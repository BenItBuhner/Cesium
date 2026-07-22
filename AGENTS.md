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
HTTP (`/chat/completions` or `/responses`). Provider credentials can come from
**environment variables** and/or Settings → Agents → Cesium Agent (persisted to
`{OPENCURSOR_DATA_DIR}/profile/cesium-agent-settings.json`).

#### Built-in env API keys

These map directly onto known providers (`server/src/lib/cesium-agent-settings.ts`,
`BUILTIN_ENV_KEYS`). Stored Settings keys still win when present for the same
provider id:

| Env var | Provider id |
| --- | --- |
| `OPENAI_API_KEY` | `openai` |
| `ANTHROPIC_API_KEY` | `anthropic` |
| `GOOGLE_API_KEY` | `google` |
| `OPENROUTER_API_KEY` | `openrouter` |
| `GROQ_API_KEY` | `groq` |
| `DEEPSEEK_API_KEY` | `deepseek` |
| `MISTRAL_API_KEY` | `mistral` |
| `XAI_API_KEY` | `xai` |
| `TOGETHER_API_KEY` | `togetherai` |
| `FIREWORKS_API_KEY` | `fireworks` |
| `NVIDIA_API_KEY` | `nvidia` |
| `CEREBRAS_API_KEY` | `cerebras` |
| `CROFAI_API_KEY` | `crofai` |

OpenAI-format `sk-*` keys may be saved under **OpenAI-compatible** / third-party
provider ids (proxies reuse that key shape). Strict native prefixes still must
match: `sk-ant-` → Anthropic, `AIza` → Google, `nvapi-` → Nvidia.

#### Env bootstrap for a custom OpenAI-compatible host

Chat base URL + default model **are** configurable from env (no Settings dance
required). When `OPENCURSOR_CESIUM_BASE_URL` (or `OPENAI_BASE_URL`) points at a
**non-OpenAI** host and an API key is available, Cesium registers an env-sourced
OpenAI-compatible provider with catalog models:

- `OPENCURSOR_CESIUM_BASE_URL` — falls back to `OPENAI_BASE_URL`
- `OPENCURSOR_CESIUM_API_KEY` — falls back to `OPENAI_API_KEY`
- `OPENCURSOR_CESIUM_DEFAULT_MODEL` — e.g. `glm-5.2` or `techlit/glm-5.2`
- `OPENCURSOR_CESIUM_PROVIDER_ID` — optional; defaults to `techlit` for
  `*.techlitnow.com` hosts, otherwise a hostname slug
- `OPENCURSOR_CESIUM_MODELS` — optional comma list or JSON array (default:
  `glm-5.2`, `kimi-k2.7-code`)

Default bootstrap models:

- `glm-5.2` — text / tools (no imagery)
- `kimi-k2.7-code` — text / tools / **images** (multimodal)

Pick the vision model when attaching screenshots; Cesium drops image parts and
warns if the selected model does not advertise `supportsImages`.

#### Speech transcription / title generation

The **speech transcription / title generation** subsystem also accepts a full
OpenAI-compatible `base URL + model + API key` triple from env, in
`server/src/lib/transcription-env.ts`:

- `OPENCURSOR_TRANSCRIPTION_BASE_URL` (falls back to `OPENAI_BASE_URL`)
- `OPENCURSOR_TRANSCRIPTION_MODEL`
- `OPENCURSOR_TRANSCRIPTION_API_KEY` (falls back to `OPENAI_API_KEY`, then `GROQ_API_KEY`)
- Optional: `OPENCURSOR_TITLE_MODEL` (default `openai/gpt-oss-20b`), plus
  `OPENCURSOR_TRANSCRIPTION_CONFIG_JSON` / `OPENCURSOR_TRANSCRIPTION_CONFIG_FILE`.

Secrets added via the Cloud Agent Secrets panel are injected as env vars on the
next VM boot; the server reads them from `process.env` (repo `.env` /`.env.local`
/ `server/.env` / `server/.env.local` are also loaded, but real process env wins).

#### Inference provider for testing

Use the personal OpenAI-compatible proxy for Cesium Agent testing:

- **Base URL:** `https://infer.techlitnow.com/v1`
- **API key:** `OPENAI_API_KEY` Cloud Agent secret (or `OPENCURSOR_CESIUM_API_KEY`)
- **Text / default model:** `glm-5.2` (no imagery)
- **Multimodal / imagery model:** `kimi-k2.7-code`

Env-only setup (preferred for cloud agents):

```bash
export OPENCURSOR_CESIUM_BASE_URL=https://infer.techlitnow.com/v1
# OPENAI_API_KEY already set via Cloud Agent secrets
export OPENCURSOR_CESIUM_DEFAULT_MODEL=glm-5.2
# For image attachments, switch the composer model to kimi-k2.7-code
# (or: export OPENCURSOR_CESIUM_DEFAULT_MODEL=kimi-k2.7-code)
```

That registers provider id `techlit` with models `techlit/glm-5.2` and
`techlit/kimi-k2.7-code`. You can still save the same host under Settings →
Agents → Cesium Agent via `PUT /api/settings/cesium-agent/provider-key` if you
prefer a stored key.
