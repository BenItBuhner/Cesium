/**
 * Unified help text for the cesium CLI. One product: install the engine,
 * run it without the desktop app, and doctor a broken machine.
 */

export function renderHelp(version) {
  return `cesium ${version} — the Cesium engine on this machine

The desktop app is optional. This CLI installs and operates the engine on
Linux, macOS, or WSL — local-only, or registered with a Cesium web deploy.

Install
  cesium install [options]     Put the engine under ~/.cesium and start it
    --web-url <url>            Register with a web deploy (tunnel + pairing)
    --from-source <dir>        Install from a local checkout instead of git
    --no-start                 Install only; you start it later with \`cesium start\`
    --skip-tunnel              CLI-only / LAN: do not start a public tunnel

Operate (no desktop required)
  cesium start | run           Start the engine (and tunnel when configured)
  cesium stop                  Stop the engine
  cesium restart               Restart the engine

Inspect
  cesium status                Engine / tunnel / rendezvous at a glance
  cesium health                Hit the local /health endpoint
  cesium logs [target]         Tail server | tunnel | rendezvous | supervisor
  cesium connect               URL + how to attach a client
  cesium credentials           Print the engine username and password

Maintain
  cesium update                Pull the latest engine and restart
  cesium doctor [--check] [--json]
                               Diagnose this machine. Safe repairs run by
                               default (dirs, permissions, stale pid files).
                               --check is read-only. --json is for scripts.

  cesium help                  This story
  cesium version               CLI version

Environment
  CESIUM_HOME                  Install root (default: ~/.cesium)
  CESIUM_INSTALLER             Path to install-cesium-server.sh (skips download)
  All CESIUM_* installer variables pass through to \`cesium install\`.

Windows: run this CLI inside WSL. The desktop app bundles its own engine.`;
}
