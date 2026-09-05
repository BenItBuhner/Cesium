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
- **A stale `server/node_modules/cesium` symlink breaks Next.js dev.** Older
  checkouts declared `"cesium": "file:.."` in `server/package.json`, which symlinked
  that path back to the repo root; Turbopack then panics with an infinite
  `track_glob` loop and every page returns HTTP 500. The dependency is gone, but
  a `node_modules` installed before its removal still carries the link, so if you
  see that panic run `rm -f server/node_modules/cesium` (nothing imports it) and
  reload.
- **Build the shared workspace packages before running/testing the server:**
  `npm run build:packages`. The backend and its tests import `@cesium/core/dist/*`,
  so without a build you get `ERR_MODULE_NOT_FOUND` for `@cesium/core/dist/mcp.js`
  and ~7 server test files fail.
- **Integrated terminal uses Bun.Terminal under Bun** (POSIX). The old `node-pty`
  path stays as a Node/desktop fallback only - do **not** switch the server to
  Node just for terminals. Deno is not used or supported.
- **Agent backends need external CLIs / API keys** (Cursor, Codex, Claude, Gemini,
 OpenCode) that are not installed. The app still boots and lists them as
 unavailable; sending a chat without a configured backend surfaces a
 "Compilation failed / Provider responded" toast. This is expected, not an
 environment break.
- **Google Antigravity (`google-antigravity-acp`) uses Google's official ACP
 server**, not the `agy` CLI. To test it live: download the Linux build from the
 ACP Registry manifest (`agentclientprotocol/registry/antigravity-acp/agent.json`,
 ~680 MB zip / ~1.9 GB extracted; the Settings -> Agents install button does the
 same), then `export OPENCURSOR_ANTIGRAVITY_ACP_BIN=/path/to/agy_acp_server.par`
 before `npm run dev:server`. Detection also finds it under
 `{DATA_DIR}/tools/antigravity-acp/current/` and Zed's
 `~/.local/share/zed/external_agents/registry/antigravity-acp/*/`. Google OAuth
 needs a browser that can reach `127.0.0.1:<port>` on this host, so on the cloud
 VM use the headless `gemini-api-key` method instead: set `GEMINI_API_KEY` (a
 Cloud Agent secret works) and the bootstrap authenticates automatically. State
 lives under `$GEMINI_HOME/antigravity-acp/` (`OPENCURSOR_ANTIGRAVITY_ACP_HOME`
 isolates it). Without a key, `session/new` fails with `-32000 Authentication
 required`, which Cesium surfaces as a "not signed in" system error.
- **Cloud (Convex + Clerk) config resolution** is env vars first, then the
 committed defaults in `src/lib/cloud/cloud-defaults.ts`; every client has a
 runtime local-only toggle (Settings → Account → Cloud sync). To test cloud
 modes without accounts: `npx convex dev` (anonymous local deployment on
 `127.0.0.1:3210`; it appends to `.env.local` - verify it didn't clobber
 `NEXT_PUBLIC_SERVER_URL`/`WORKSPACE_ROOT`), then
 `npx convex env set CESIUM_ALLOW_DEVICE_KEYS 1` for device mode. The
 standalone renderer (Electron + mobile WebView bundle) takes
 `NEXT_PUBLIC_CONVEX_URL` at vite build time; for the Android APK export it
 for the WHOLE pipeline - `prepare:android` re-runs `build:web-assets` and
 silently overwrites assets built earlier with different env.

### Android emulator (mobile app testing)

Best route for Cesium mobile (`apps/mobile`, RN + WebView APK): the official
**Google Android SDK emulator** (cmdline-tools) with the
`system-images;android-30;google_apis;x86_64` image, run **fully software-bound**:
`-accel off` (TCG CPU emulation) plus `-gpu swiftshader_indirect` (software GPU).
**Do not trust KVM here:** `/dev/kvm` exists and `emulator -accel-check` claims
"KVM installed and usable", but that probe never runs a vCPU - with KVM enabled
the emulator parks at ~0% CPU before guest boot and never comes up. `-accel off`
is mandatory. **Use the API 30 image, not newer:** API 33+ system WebViews
(recent Chromium `libmonochrome`) hard-crash with SIGTRAP under TCG even with
`-qemu -cpu max`; API 30 ships Chromium 83, which the mobile asset pipeline
explicitly supports. Expect a slow boot (~10 min) and a sluggish but usable
guest. Run headless (`-no-window`; the Qt window also fails to map on this
desktop) and drive it with `adb shell input` / `screencap` / `screenrecord`.

One-time setup (~4 min):

```bash
mkdir -p ~/android-sdk/cmdline-tools && cd ~/android-sdk
curl -sSLo tools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
unzip -q tools.zip -d cmdline-tools && mv cmdline-tools/cmdline-tools cmdline-tools/latest && rm tools.zip
export ANDROID_HOME=$HOME/android-sdk
yes | cmdline-tools/latest/bin/sdkmanager --licenses
cmdline-tools/latest/bin/sdkmanager "platform-tools" "platforms;android-36" \
  "build-tools;36.0.0" "emulator" "cmake;3.31.6" "ndk;27.0.12077973" \
  "system-images;android-30;google_apis;x86_64"
echo no | cmdline-tools/latest/bin/avdmanager create avd -n cesium \
  -k "system-images;android-30;google_apis;x86_64" -d pixel_5
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
time under TCG - first workbench load can take a couple of minutes.

TCG survival kit (all learned the hard way):

- **ANR dialogs**: the slow guest trips "Cesium isn't responding" dialogs.
  Detect with `adb shell dumpsys window windows | grep -ci "not responding"`
  and tap **Wait** at `adb shell input tap 336 1313` (Pixel 5, 1080x2340).
  Do NOT `settings put global hide_error_dialogs 1` - that silently kills the
  app instead.
- **Stale screencaps**: the Android compositor can lag the WebView by minutes
 under SwiftShader. When `screencap` looks frozen, verify the real UI state
 over CDP: `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`
 (find the socket via `adb shell cat /proc/net/unix | grep webview_devtools`),
 then query/screenshot Chromium directly (`http://localhost:9222/json`).
 `adb shell screenrecord` freezes the same way - prefer CDP
 `Page.captureScreenshot` for evidence. Driving the UI: CDP
 `Runtime.evaluate` + element `.click()` is reliable;
 `Input.dispatchTouchEvent` hangs on the API 30 WebView (Chromium 83), and
 physical `adb shell input tap` needs the WebView's on-screen offset, not
 just CSS×devicePixelRatio.
- **Share-intent testing**: `am start -a android.intent.action.SEND` with a
  `content://media/...` EXTRA_STREAM fails with SecurityException (shell can't
  grant URI perms on extras). Instead `run-as com.cesium.mobile` to drop a file
  into `files/` and share `file:///data/user/0/com.cesium.mobile/files/<name>`.

The app's WebView reaches a host-side backend at `http://10.0.2.2:9100`
(default), so start `npm run dev:server` on the VM first. Rebuild
`build:web-assets` whenever shared `src/` web code changes - the APK ships a
static copy.

### Codex App Server harness (`codex-app-server`) testing

The harness speaks Codex's app-server protocol v2 (verified against Codex CLI
0.153.4). Ground truth for wire shapes is the CLI itself:
`codex app-server generate-json-schema --experimental --out <dir>` (and
`generate-ts`) plus `codex-rs/app-server/README.md` upstream.

- **Install the CLI into a user prefix** (global npm prefix is not writable):
 `npm config set prefix ~/.npm-global && npm i -g @openai/codex@latest`; the
 harness detector already scans `~/.npm-global/bin`.
- **Route Codex through the inference proxy** with a custom provider in
 `~/.codex/config.toml` (no ChatGPT login needed):

 ```toml
 model = "kimi-k3"
 model_provider = "techlit"

 [model_providers.techlit]
 name = "TechLit Proxy"
 base_url = "https://infer.techlitnow.com/v1"
 env_key = "TECHLIT_API_KEY"
 wire_api = "responses"
 ```

 then `export TECHLIT_API_KEY=<proxy key>` before `npm run dev:server` or the
 probe. `model/list` only knows OpenAI's catalog; the harness reads
 `config/read` so the configured custom model is the default (never pin
 `gpt-*` models onto a third-party provider - every turn fails).
- **Deterministic tests**: `server/test/codex-app-server-e2e.test.ts` drives the
 real provider against `server/test/fixtures/fake-codex-app-server.mjs`
 (protocol-faithful double; scenarios selected by `scenario:<name>` in the
 prompt). `server/test/codex-app-server.test.ts` covers normalization.
- **Live probe**: `bun ./scripts/codex-app-server-probe.ts --scenario all`
 (from `server/`) runs approval/question/plan/image/cancel/resume flows
 through the provider and writes `server/tmp/codex-app-server-probe/events.jsonl`;
 `--raw` captures the untouched JSON-RPC stream instead.
- **Known quirks**: the container lacks bubblewrap (Codex warns and uses its
 bundled copy); the proxy stringifies `function_call_output` content-item
 arrays, so MCP tool results reach the model as `[object Object]` (shell
 output is plain text and fine); Codex 0.153.4 emits no `commandExecution`
 item for unified-exec commands that exit non-zero.

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

- `CESIUM_BASE_URL` - falls back to `OPENAI_BASE_URL`
- `CESIUM_API_KEY` - falls back to `OPENAI_API_KEY`
- `CESIUM_DEFAULT_MODEL` - e.g. `kimi-k3` or `techlit/kimi-k3`
- `CESIUM_PROVIDER_ID` - optional; defaults to `techlit` for
  `*.techlitnow.com` hosts, otherwise a hostname slug
- `CESIUM_MODELS` - optional comma list or JSON array (default: `kimi-k3`)

Default bootstrap model:

- `kimi-k3` - text / tools / **images** (multimodal); ~1M context, fast,
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
