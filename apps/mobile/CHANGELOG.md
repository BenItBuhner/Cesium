# Changelog

All notable changes to the Cesium native Android app (`@cesium/mobile`) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases are tagged as `mobile-vX.Y.Z` on GitHub.

## [Unreleased]

### Changed

- Replaced the divergent native React Native workbench with the bundled Vite WebView client used by Electron, restoring settings, harness/model selection, workspace/repository controls, Markdown, tool calls, and conversation parity.
- React Native now owns only the Android bridge and native services (live/Now Bar notifications, Wear, assistant, phone control, window insets, and runtime/image picker).
- Removed the obsolete `@cesium/ui-native` package and its NativeWind/Reanimated/MMKV dependency stack.

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
