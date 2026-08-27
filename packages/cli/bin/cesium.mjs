#!/usr/bin/env node
/**
 * cesium - bare-bones CLI for the Cesium engine.
 *
 * `cesium install` runs the official installer (scripts/install-cesium-server.sh),
 * which sets up the Bun runtime, credentials, tunnel, and autostart under
 * ~/.cesium. Every other command delegates to the `cesium-server` manager the
 * installer drops at ~/.cesium/bin/cesium-server, so this CLI stays a thin,
 * dependency-free wrapper that never drifts from the installed engine.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import process from "node:process";

const CLI_VERSION = createRequire(import.meta.url)("../package.json").version;
const INSTALLER_URL =
  "https://raw.githubusercontent.com/BenItBuhner/Cesium/main/scripts/install-cesium-server.sh";
const DEFAULT_PRODUCTION_WEB_URL = "https://cesium.techlitnow.com";

const MANAGED_COMMANDS = [
  "start",
  "run",
  "stop",
  "restart",
  "status",
  "health",
  "logs",
  "connect",
  "credentials",
  "update",
  "supervise",
];

const HELP = `cesium ${CLI_VERSION} - local Cesium engine manager

Usage:
  cesium install [--web-url <url>] [--local]
                                 Install (or repair) the engine under ~/.cesium.
                                 Defaults to production Cesium (Clerk sign-in +
                                 tunnel). Pass --local for loopback-only.
  cesium start                       Start the engine (plus tunnel when configured)
  cesium stop                        Stop the engine
  cesium restart                     Restart the engine
  cesium status                      Show engine / tunnel / rendezvous status
  cesium health                      Check the local health endpoint
  cesium logs [server|tunnel|...]    Tail engine logs
  cesium connect                     Print the URL + credentials to connect a client
  cesium credentials                 Show or rotate access credentials
  cesium update                      Update the engine to the latest release
  cesium help                        Show this help
  cesium version                     Show the CLI version

Options for install:
  --web-url <url>   Cesium web origin to register with (default:
                    ${DEFAULT_PRODUCTION_WEB_URL}). Enables tunnel + rendezvous.
  --local           Loopback only. No tunnel, no public URL. Auth is still
                    generated so the engine is never left open.

A pasted URL is never enough to expose this machine. Public access requires
engine authentication (generated on install) and a tunnel or a reverse proxy
that proves it reaches this process.

Environment:
  CESIUM_HOME       Install root (default: ~/.cesium)
  All CESIUM_* installer variables pass through to \`cesium install\`.

Windows is supported through WSL: run this CLI inside a WSL distribution.
The desktop app needs none of this - it ships with an embedded engine.`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function cesiumHome() {
  return process.env.CESIUM_HOME?.trim() || path.join(homedir(), ".cesium");
}

function managerPath() {
  return path.join(cesiumHome(), "bin", "cesium-server");
}

function requirePosix(action) {
  if (process.platform === "win32") {
    fail(
      `${action} requires Linux or macOS (the engine runs on Bun/POSIX).\n` +
        "On Windows, run this command inside WSL - or use the Cesium desktop app, " +
        "which bundles the engine natively."
    );
  }
}

async function runInstall(args) {
  requirePosix("cesium install");
  const env = { ...process.env };
  let localOnly = env.CESIUM_LOCAL_ONLY === "1";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--web-url") {
      const value = args[i + 1];
      if (!value) {
        fail("--web-url requires a value, e.g. --web-url https://cesium.example.com");
      }
      env.CESIUM_WEB_URL = value;
      i += 1;
    } else if (args[i] === "--local") {
      localOnly = true;
    } else {
      fail(`Unknown install option: ${args[i]}\n\n${HELP}`);
    }
  }
  if (localOnly) {
    env.CESIUM_LOCAL_ONLY = "1";
    delete env.CESIUM_WEB_URL;
  } else if (!env.CESIUM_WEB_URL?.trim()) {
    env.CESIUM_WEB_URL = DEFAULT_PRODUCTION_WEB_URL;
  }

  let script;
  try {
    const response = await fetch(INSTALLER_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    script = await response.text();
  } catch (error) {
    fail(
      `Could not download the Cesium installer (${error?.message ?? error}).\n` +
        `Fetch it manually from ${INSTALLER_URL}`
    );
  }

  const scriptPath = path.join(mkdtempSync(path.join(tmpdir(), "cesium-install-")), "install.sh");
  writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptPath], { stdio: "inherit", env });
  process.exit(result.status ?? 1);
}

function delegate(command, args) {
  requirePosix(`cesium ${command}`);
  const manager = managerPath();
  if (!existsSync(manager)) {
    fail(
      `The Cesium engine is not installed (missing ${manager}).\n` +
        "Run `cesium install` first."
    );
  }
  const result = spawnSync(manager, [command, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${CLI_VERSION}\n`);
    return;
  }
  if (command === "install") {
    await runInstall(args);
    return;
  }
  if (MANAGED_COMMANDS.includes(command)) {
    delegate(command, args);
    return;
  }
  fail(`Unknown command: ${command}\n\n${HELP}`);
}

await main();
