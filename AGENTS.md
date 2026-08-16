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

### Android emulator (mobile app testing)

Best route for Cesium mobile (`apps/mobile`, RN + WebView APK): the official
**Google Android SDK emulator** (cmdline-tools) with the
`system-images;android-36;google_apis;x86_64` image, run **fully software-bound**:
`-accel off` (TCG CPU emulation) plus `-gpu swiftshader_indirect` (software GPU).
**Do not trust KVM here:** `/dev/kvm` exists and `emulator -accel-check` claims
"KVM installed and usable", but that probe never runs a vCPU — with KVM enabled
the emulator parks at ~0% CPU before guest boot and never comes up. `-accel off`
is mandatory. Expect a slow boot (~10 min) and a sluggish but fully usable guest.
Run headless (`-no-window`; the Qt window also fails to map on this desktop) and
drive it with `adb shell input` / `screencap` / `screenrecord`.

One-time setup (~4 min):

```bash
mkdir -p ~/android-sdk/cmdline-tools && cd ~/android-sdk
curl -sSLo tools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
unzip -q tools.zip -d cmdline-tools && mv cmdline-tools/cmdline-tools cmdline-tools/latest && rm tools.zip
export ANDROID_HOME=$HOME/android-sdk
yes | cmdline-tools/latest/bin/sdkmanager --licenses
cmdline-tools/latest/bin/sdkmanager "platform-tools" "platforms;android-36" \
  "build-tools;36.0.0" "emulator" "cmake;3.31.6" "ndk;27.0.12077973" \
  "system-images;android-36;google_apis;x86_64"
echo no | cmdline-tools/latest/bin/avdmanager create avd -n cesium \
  -k "system-images;android-36;google_apis;x86_64" -d pixel_7
```

(CMake + the pinned NDK are required or `:app:configureCMakeDebug` fails with
`[CXX1300] CMake '3.31.6' was not found`.)

Run + install (from repo root):

```bash
export ANDROID_HOME=$HOME/android-sdk \
  PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
emulator -avd cesium -no-window -accel off -gpu swiftshader_indirect \
  -no-snapshot -no-audio -no-boot-anim -no-metrics -memory 3072 -cores 4 &
adb wait-for-device   # then poll: adb shell getprop sys.boot_completed -> 1
npm run build:packages
npm --prefix apps/mobile run build:web-assets      # workbench bundle -> APK assets
npm --prefix apps/mobile run build:android:debug   # gradle assembleDebug (JDK 21 OK)
adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.cesium.mobile/.MainActivity
```

Interact headlessly: `adb shell input tap/swipe/text`, screenshots with
`adb exec-out screencap -p > shot.png`, demo videos with
`adb shell screenrecord` (pull the mp4 afterwards). Give the WebView extra
time under TCG — first workbench load can take a couple of minutes.

The app's WebView reaches a host-side backend at `http://10.0.2.2:9100`
(default), so start `npm run dev:server` on the VM first. Rebuild
`build:web-assets` whenever shared `src/` web code changes — the APK ships a
static copy.

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
required). When `CESIUM_BASE_URL` (or `OPENAI_BASE_URL`) points at a
**non-OpenAI** host and an API key is available, Cesium registers an env-sourced
OpenAI-compatible provider with catalog models:

- `CESIUM_BASE_URL` — falls back to `OPENAI_BASE_URL`
- `CESIUM_API_KEY` — falls back to `OPENAI_API_KEY`
- `CESIUM_DEFAULT_MODEL` — e.g. `kimi-k3` or `techlit/kimi-k3`
- `CESIUM_PROVIDER_ID` — optional; defaults to `techlit` for
  `*.techlitnow.com` hosts, otherwise a hostname slug
- `CESIUM_MODELS` — optional comma list or JSON array (default: `kimi-k3`)

Default bootstrap model:

- `kimi-k3` — text / tools / **images** (multimodal); ~1M context, fast,
  strong general intelligence. Use this as the single default for cloud-agent
  and inference testing (no separate text-only vs vision model).

Cesium still drops image parts and warns if a selected model does not advertise
`supportsImages`; `kimi-k3` does.

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
- **API key:** `OPENAI_API_KEY` Cloud Agent secret (or `CESIUM_API_KEY`)
- **Default model:** `kimi-k3` (text, tools, imagery; ~1M context)

Env-only setup (preferred for cloud agents):

```bash
export CESIUM_BASE_URL=https://infer.techlitnow.com/v1
# OPENAI_API_KEY already set via Cloud Agent secrets
export CESIUM_DEFAULT_MODEL=kimi-k3
```

That registers provider id `techlit` with model `techlit/kimi-k3`. You can still
save the same host under Settings → Agents → Cesium Agent via
`PUT /api/settings/cesium-agent/provider-key` if you prefer a stored key.
