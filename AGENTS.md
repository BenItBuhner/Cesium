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

Use the **official Google Android Emulator (AVD) in pure software mode** — it
is the best (and only practical) emulator in this VM. Only set this up when
the user asks for Android/emulator testing.

**KVM is a trap here:** `/dev/kvm` exists and `emulator -accel-check` reports
"KVM is installed and usable", but creating a vCPU triggers a host kernel BUG
(`kvm_spurious_fault` in dmesg) and the emulator hangs forever at 0% CPU with
the device stuck "offline". Always pass `-accel off`. Use the lightweight
**API 30** google_apis image (app minSdk is 26); newer images take far longer
under software emulation. There is no host GPU either → `-gpu
swiftshader_indirect`.

One-time setup (~2.5 GB download into `~/android-sdk`, a few minutes):

```bash
export ANDROID_HOME=$HOME/android-sdk
mkdir -p $ANDROID_HOME/cmdline-tools && cd /tmp
curl -fsSLO https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip
unzip -q commandlinetools-linux-*.zip -d $ANDROID_HOME/cmdline-tools
mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest
export PATH=$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH
yes | sdkmanager --licenses >/dev/null
sdkmanager "platform-tools" "emulator" "platforms;android-36" "build-tools;36.0.0" \
  "ndk;27.0.12077973" "cmake;3.31.6" "system-images;android-30;google_apis;x86_64"
avdmanager create avd -n CesiumPixel30 -k "system-images;android-30;google_apis;x86_64" -d pixel_7
```

Boot (window appears on the XFCE desktop, `DISPLAY=:1`, so computer-use tools
can drive it; software boot takes ~5–15 min — wait for
`adb shell getprop sys.boot_completed` to print `1`):

```bash
DISPLAY=:1 emulator -avd CesiumPixel30 -accel off -gpu swiftshader_indirect \
  -no-snapshot -no-audio -no-boot-anim -no-metrics -memory 3072 -cores 2 &
```

Build + install the Cesium APK (Java 21 is preinstalled; gradle needs
`ANDROID_HOME` exported; `-PreactNativeArchitectures=x86_64` skips the ARM
native builds and roughly quarters C++ compile time):

```bash
cd apps/mobile
npm run build:web-assets && npm run bundle:android   # refresh bundled workbench + RN bundle
node scripts/run-gradle.mjs --parallel --build-cache -PreactNativeArchitectures=x86_64 :app:assembleDebug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Notes:
- The app's WebView loads the bundled workbench from APK assets and talks to
 the host's backend at `http://10.0.2.2:9100` (start `npm run dev:server` on
 the host first).
- Share-sheet / intent flows can be exercised without a second app:
 `adb shell am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT "hello"`
 opens the system share sheet with Cesium listed; for files, push to
 `/sdcard/Download`, then share from the Files app.
- `adb emu kill` stops the emulator; AVD state lives in `~/.android/avd/`.
- Everything is slow under software emulation — give app launches and taps
 10–30 s before judging them broken; "isn't responding" ANR dialogs are
 normal, tap Wait.
- The API 30 image ships a Chromium 83 WebView: Tailwind v4's `@layer`-based
 CSS is largely ignored there, so overlays/components meant to render inside
 the bundled mobile workbench need inline styles for load-bearing layout.

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
