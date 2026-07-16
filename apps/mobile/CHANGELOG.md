# Changelog

All notable changes to the Cesium native Android app (`@cesium/mobile`) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases are tagged as `mobile-vX.Y.Z` on GitHub.

## [Unreleased]

## [0.1.3] - 2026-07-16

### Fixed

- Termux installer now starts `runsvdir` / `service-daemon` before `sv up`, fixing `unable to open supervise/ok`.
- Falls back to direct `nohup node` mode when runit cannot supervise, so `/health` still comes up after a successful build.
- `cesium-server start|stop|status|logs` works in both runit and direct modes.

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
