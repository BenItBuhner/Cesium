# Changelog

All notable changes to the Cesium native Android app (`@cesium/mobile`) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases are tagged as `mobile-vX.Y.Z` on GitHub.

## [Unreleased]

## [0.6.0] - 2026-08-17

### Added

- Notification alert settings: completion and needs-input alerts are gated on app foreground state with per-category preferences (default: completions post only while the app is in the background), configurable from mobile Settings. The server also interrupts leftover busy conversations at boot and watchdogs runs whose provider runtime died without settling the turn.
- Standalone no-workspace chat: fresh installs no longer auto-seed a `default` workspace from `WORKSPACE_ROOT`. The landing composer and Android share-sheet intake submit through the standalone sandbox when no workspace is active, onboarding offers "No workspace — just chat", and deleting the last durable workspace returns to the empty shell instead of a dead workspace id.

### Changed

- Theme-agnostic UI: missing tokens (`--bg-deep`, `--status-{success,warning,error}`, adaptive plus-button aliases) are defined, hardcoded colors across modals / dropdowns / editor / status UI now resolve through theme tokens, and Monaco is driven from those tokens with unique theme names so live preset switches apply.
- Soft keyboard no longer pans the whole window on SDK 35+ (React Native force-enables edge-to-edge, which made `adjustResize` a no-op). The activity pads its content view by IME height via `WindowInsetsCompat` / `WindowInsetsAnimationCompat`, so the React root and WebView shrink and the workbench reflows above the keyboard.
- Chat user-turn headers use real CSS `position: sticky` inside each virtual row instead of a JS overlay clone. Android WebView no longer paints a duplicate pinned message (the overlay lagged compositor-driven scroll), and editing a pinned turn mounts one composer.
- Mobile right workbench drawer uses the same frosted treatment as the left rail.
- Composer attach menu drops the Link option; pasting an `http(s)` URL into the composer still creates a link pill.
- Bundled workbench picks up the post-0.5.0 shell: workspace-first agent rail, Chromium 83 layout fallbacks (`inset` longhands + `overflow:hidden` before `overflow:clip` so the absolutely-positioned mobile shell and drawers do not collapse on stock Android 11), theme-token sweep, no-workspace landing, and notification alert settings.

### Fixed

- Settings crash loop and `file://` reload dead-end on the packaged WebView: workspace URL sync no longer rewrites a `file://` document to `/agent` (`net::ERR_FILE_NOT_FOUND`), Reload Cesium returns to the boot document and forces the next launch into new-chat, a panel-scoped error boundary contains Settings render crashes, and malformed update-state payloads no longer take down the Updates panel. The native shell also keeps the Retry UI after a failed load (`onLoad` vs `onLoadEnd`).
- Stale Live Updates / "Working" notifications: persisted ongoing runs expire on foreground-service restore and reconcile against the authoritative projection set, so orphaned chronometer chips cancel. Projection `startedAt` anchors to the current run after the latest terminal boundary instead of the first running event in the loaded window.
- Workbench layout on legacy Android WebViews (Chromium 83): without the `inset` / `overflow:clip` fallbacks the mobile shell and drawers collapsed into normal flow; programmatic scroll of the shell is pinned to the origin so focus heuristics cannot drag the UI into parked drawer overflow.
- Server installers: existing clones retarget the fetch refspec so `git checkout` of the requested branch no longer dies with `pathspec did not match`; both installers build `@cesium/contracts`; the isolated bun installer deletes stale nested `@cesium` copies that shadowed built workspace packages; `callMcpToolRich` wraps the artifacts MCP branch so `tsc` builds (Termux) succeed.

## [0.5.0] - 2026-08-17

### Added

- Gradual predictive back: the Android back gesture now streams its progress into the app (native `OnBackPressedCallback` with progressive members registered above React Native's plain callback, forwarded over the WebView bridge as `backStarted` / `backProgressed` / `backCancelled`). The mobile workspace rail and workbench pane follow the finger 1:1 through the existing drawer spring engine, and the full-screen settings view runs a Material-style scale/shift/corner preview — committing pops the layer, cancelling springs it back. Older Androids and 3-button navigation keep the previous discrete behavior.
- Android share-sheet intake: share text, links, and files from other apps into a new or existing chat. The intake sheet is WebView-83-safe (stock Android 11), drains shares that arrive while Cesium is already foreground, and still opens when the only shared item was unreadable or oversized so the skip notice is visible.

### Changed

- Live Updates now actually render as a status-bar chip / Now Bar promotion: silent `IMPORTANCE_DEFAULT` channel (`cesium-agent-runs-v2`), chip text that stays populated when no countdown owns it, explicit ProgressStyle segments for terminal/unknown kinds, promote-flag + native preference combined (not overridden), and per-device Settings copy (Android 16 vs QPR1+ vs Samsung Now Bar) plus a best-effort Now Bar settings deep link.
- WebView bridge protocol moved to `@cesium/core` with a version handshake; polyfills ship in the renderer bundle; first-paint theme is stamped into the Android asset copy.
- Bundled workbench picks up the post-0.4.0 shell: full-screen voice agent sessions (launch surfaces + hardened lifecycle), customizable new-chat landing, settings account/breadcrumb shell, Aurora Borealis conversation backdrop, GitHub/npm update panel, mobile swipe gestures / instant chat spawn, agent capability profiles, harness OAuth / Grok Build device login, and the PR review tab.

### Fixed

- In-WebView back handling now works on Android 13–15 with gesture navigation. React Native 0.86 only registers its back callback on Android 16+, so with `enableOnBackInvokedCallback` opted in, every back gesture on 13–15 previously invoked the system default (exit the app) instead of popping open in-app layers. The new always-registered predictive callback intercepts back whenever the app has something to pop.
- Live Updates chip presentation no longer leaves an empty status-bar chip on short ETAs; the notifyDirectly fallback persists run state for service restore.

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
