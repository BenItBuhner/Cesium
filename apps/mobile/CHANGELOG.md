# Changelog

All notable changes to the Cesium native Android app (`@cesium/mobile`) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases are tagged as `mobile-vX.Y.Z` on GitHub.

## [Unreleased]

## [0.4.0] - 2026-08-10

### Changed

- Android Live Updates (promoted `ProgressStyle` notifications) are now the primary — and default — run-progress surface, with a standard live notification as the only fallback when promotion is unsupported or denied. The previous "Now Bar" placement option was a misnomer: Samsung exposes no third-party Now Bar API; One UI 8+ simply renders standard Live Updates in the Now Bar. Stored preferences migrate (`nowbar` → `live`, old `live` → `basic`).
- Every active agent now gets its own live notification (stable per-run notification ids, per-run pending intents, per-run dismissal memory) instead of a single shared notification that the most recent update overwrote. The foreground service anchors on one run and re-anchors when that run finishes or is dismissed, so remaining agents keep updating.
- The workbench projects **all** conversations with active agent runs over the bridge (`agentProjections`), not just the focused one, and the background agent socket subscribes to every active conversation, so multi-agent tracking keeps working while the app is idle.
- Bundled workbench picks up the post-0.3.1 chat/composer polish: icon-compact model/mode on narrow rows, action pills (dynamic status + custom quick actions), OLED-friendly dark theme defaults, larger touch targets, and Cloud Agents official icons instead of abbreviation badges.

### Added

- "Agent attention" high-importance notification channel: agents alert (heads-up/sound) exactly when they start needing input (permission/question) and when a watched run completes, fails, or is cancelled; routine progress updates stay silent on the low-importance runs channel. Interventions and completions also bypass a run's dismissed state.
- Completion/failure notifications now persist until dismissed instead of auto-cancelling ~15 s after the run ends.
- Predictive-back capable Android back stack: hardware / gesture back routes through in-WebView overlays (settings, rails, panes, modals) before WebView history or app exit (`enableOnBackInvokedCallback`).

### Fixed

- Voice orb is no longer always visible on Android. The packaged workbench now includes the Settings → General → Voice opt-in gate (`showVoiceOrb`, default off), so the floating mic stays hidden until the user enables it.
- Live notification projections resolve the focused conversation correctly (URL / agent view / chat tab), so background runs actually update the native notification surface instead of starving on a stale `new` tab id.
- Harness picker no longer auto-closes on Android touch taps (hover compat events were racing the open/toggle path); the whole harness row is tap-to-toggle and the model edit control stays visible on coarse pointers.
- Background agent/socket work no longer falls back into aggressive polling when the app is idle; terminal transport and bridge handoff waste less battery while backgrounded.
- Subagent cards no longer duplicate, lose transcripts, or leave stuck spinners; chat scroll jitter from stream updates is tamed; composer draft text no longer sticks after send / New Chat.

## [0.3.1] - 2026-07-30

### Fixed

- Termux one-command server install no longer aborts with `EBADPLATFORM: Unsupported platform for onnxruntime-node ... (current: {"os":"android"})`. The voice plane's `kokoro-js` dependency (whose `onnxruntime-node` transitive dependency ships no Android binaries) is now an `optionalDependency`, so the on-device `npm ci --omit=optional` skips it entirely, and the server compiles and runs without the module — the kokoro TTS engine simply reports unavailable.
- Termux installer now installs `espeak` (eSpeak NG), so the voice control plane keeps a working local TTS engine on-device; it becomes the default engine when kokoro is absent.

## [0.3.0] - 2026-07-30

### Added

- Live voice control plane in the bundled workbench: ambient draggable voice orb with transient caption bubbles, capture → VAD → endpointing → STT pipeline, TTS playback, and a pipeline self-test — backed by the server's voice controller (session tools + compaction) and TTS engine registry. The Android assistant now drives the same voice controller.
- Termux on-device server setup restored for the WebView app: the "Check Cesium server" screen and the server manager show a "Run the server on this phone" card with an F-Droid link, the one-command Termux installer, and a "Check and use this phone" button that connects to the local `127.0.0.1:9100` server.
- `openExternalUrl` WebView bridge message: workbench links such as the F-Droid page open in the system browser via `Linking.openURL` instead of navigating the bundled `file://` app away.

### Fixed

- The native shell (agent status polling, phone control, notifications, Wear) follows workbench server switches again: the workbench re-broadcasts `serverConfigured` whenever the active server changes. The WebView revert had dropped this wiring, leaving native services pointed at the launch-time server.
- Voice VAD assets resolve relative to the page on `file://` origins, so packaged builds can load Silero when the assets are bundled and fall back to the energy VAD cleanly when they are not.

## [0.2.1] - 2026-07-28

### Fixed

- App no longer crashes to "Cesium hit an unexpected UI error / Cesium web URL must use http or https" on first launch when no Cesium server is reachable. The hosted-web server installer card (`ServerSetupCommand`) threw on the packaged client's `file://` origin from both the connection-error screen and the server connections manager; it is now hidden in packaged (WebView/Electron) builds, so the "Check Cesium server" screen and server management work as intended.

## [0.2.0] - 2026-07-28

### Changed

- Replaced the divergent native React Native workbench with the bundled Vite WebView client used by Electron, restoring settings, harness/model selection, workspace/repository controls, Markdown, tool calls, and conversation parity.
- React Native now owns only the Android bridge and native services (live/Now Bar notifications, Wear, assistant, phone control, window insets, and runtime/image picker).
- Removed the obsolete `@cesium/ui-native` package and its NativeWind/Reanimated/MMKV dependency stack.

### Added

- Cesium launcher icon: adaptive (and themed monochrome) hexagon-mark icons for the phone and Wear apps. Previous releases shipped no `android:icon`, so Android showed the default placeholder.
- Brand notification small icon (`ic_stat_cesium`) for agent-run, phone-control, and Wear notifications, replacing the stock `stat_notify_sync` / `ic_dialog_info` system icons.

## [0.1.3] - 2026-07-17

### Fixed

- Native Android workbench send, stop, attachments, model/mode switching, slash directives, and settings now match the shared web/Electron flows.
- Same-submit slash directives (`/backend`, `/mode`, `/model`, `/set`) apply on create and prompt without racing draft state or dropping option overrides after a backend handoff.
- Android image picker uses the current React Native activity context so attachment uploads work on RN 0.86.
- Native server connections picker is restored when the phone cannot reach the Cesium backend.

### Changed

- Shared composer suggestion and directive helpers live in `@cesium/core` so web and native stay in sync.
- Create-and-prompt accepts a server `configOverride` so first-turn directive config is applied before the turn runs.

## [0.1.2] - 2026-07-16

### Fixed

- Termux installer no longer runs a second `npm ci --prefix server` against a stale nested lockfile (npm 11 `EUSAGE` / missing `@anthropic-ai/claude-agent-sdk`, `@cursor/sdk`, MCP, etc.).
- On-device install is lean: only `@cesium/core` + `cesium-server` with `--no-workspaces`, instead of the full monorepo `npm ci`.
- Regenerated `server/package-lock.json` so standalone server installs stay in sync with `server/package.json` (pin `@cursor/sdk` to `1.0.17`).
- Ignore forward-compatible Cursor SDK `usage` stream events during TypeScript builds.
- Installer waits for `/health` before declaring success.

## [0.1.1] - 2026-07-16

### Fixed

- Termux on-device server setup no longer dies on broken curl: bootstrap upgrades packages with `apt full-upgrade` before invoking curl (Termux `pkg` depends on curl).
- Termux installer skips native addons Android cannot build (`node-pty` / NDK), so `npm ci` can finish and the local backend can start.
- Setup copy and Android bundle updated with the repaired installer command and mirror guidance (`termux-change-repo`).

## [0.1.0] - 2026-07-16

### Added

- React Native phone app with Design 2.0 workbench shell.
- Native Android modules for live updates, window insets, and Wear companion relay.
- Wear OS companion app with tiles, complications, and phone sync.
- GitHub Actions workflows that build installable APKs on pull requests and publish tagged releases.
