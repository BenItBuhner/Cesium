#!/usr/bin/env node
/**
 * cesium — bare-bones CLI for the Cesium engine.
 *
 * POSIX: `cesium install` runs the official installer (scripts/install-cesium-server.sh)
 * and every other command delegates to ~/.cesium/bin/cesium-server.
 *
 * Windows: the bash installer is not used. The native manager in
 * packages/cli/lib/windows-engine.mjs installs Bun, builds the engine, and
 * handles start/stop/status without WSL.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { runWindowsCommand, windowsHelpExtra } from "../lib/windows-engine.mjs";

const CLI_VERSION = createRequire(import.meta.url)("../package.json").version;
const INSTALLER_URL =
  "https://raw.githubusercontent.com/BenItBuhner/Cesium/main/scripts/install-cesium-server.sh";

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

function cliPlatform() {
  return process.env.CESIUM_CLI_PLATFORM?.trim() || process.platform;
}

function isWindows() {
  return cliPlatform() === "win32";
}

const HELP = `cesium ${CLI_VERSION} — local Cesium engine manager

Usage:
  cesium install [--web-url <url>]   Install (or repair) the engine under ~/.cesium
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
  --web-url <url>   The Cesium web deployment this engine should register with
                    (sets CESIUM_WEB_URL; enables tunnel + rendezvous discovery).

Environment:
  CESIUM_HOME       Install root (default: ~/.cesium)
  All CESIUM_* installer variables pass through to \`cesium install\`.
${windowsHelpExtra()}`;

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

async function runInstall(args) {
  if (isWindows()) {
    await runWindowsCommand("install", args);
    return;
  }
  const env = { ...process.env };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--web-url") {
      const value = args[i + 1];
      if (!value) {
        fail("--web-url requires a value, e.g. --web-url https://cesium.example.com");
      }
      env.CESIUM_WEB_URL = value;
      i += 1;
    } else {
      fail(`Unknown install option: ${args[i]}\n\n${HELP}`);
    }
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
  if (isWindows()) {
    return runWindowsCommand(command, args);
  }
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
    await delegate(command, args);
    return;
  }
  fail(`Unknown command: ${command}\n\n${HELP}`);
}

await main();
