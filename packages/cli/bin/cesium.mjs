#!/usr/bin/env node
/**
 * cesium — one CLI for the Cesium engine.
 *
 * Install it, run it without the desktop app, and doctor a broken machine.
 * Lifecycle commands delegate to ~/.cesium/bin/cesium-server so this wrapper
 * never drifts from the installed engine. `doctor` inspects that tree (and
 * the live /health endpoint) from Node so it still works when the manager
 * itself is missing or half-installed.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import { runDoctor, formatDoctorReport, parseDoctorArgs } from "../lib/doctor.mjs";
import { renderHelp } from "../lib/help.mjs";
import { runInstall } from "../lib/install.mjs";
import { cesiumHome, managerPath } from "../lib/paths.mjs";

const CLI_VERSION = createRequire(import.meta.url)("../package.json").version;

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

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function requirePosix(action) {
  if (process.platform === "win32") {
    fail(
      `${action} requires Linux or macOS (the engine runs on Bun/POSIX).\n` +
        "On Windows, run this command inside WSL — or use the Cesium desktop app, " +
        "which bundles the engine natively."
    );
  }
}

function delegate(command, args) {
  requirePosix(`cesium ${command}`);
  const manager = managerPath();
  if (!existsSync(manager)) {
    fail(
      `The Cesium engine is not installed (missing ${manager}).\n` +
        "CLI-only path: run `cesium install` then `cesium start`.\n" +
        "Something already installed? `cesium doctor` will say what broke."
    );
  }
  const result = spawnSync(manager, [command, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

async function runDoctorCommand(args) {
  requirePosix("cesium doctor");
  let options;
  try {
    options = parseDoctorArgs(args);
  } catch (error) {
    fail(`${error instanceof Error ? error.message : error}\n\n${renderHelp(CLI_VERSION)}`);
  }
  const report = await runDoctor({ applyFixes: options.applyFixes });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatDoctorReport(report));
  }
  process.exit(report.exitCode);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${renderHelp(CLI_VERSION)}\n`);
    return;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${CLI_VERSION}\n`);
    return;
  }
  if (command === "install") {
    requirePosix("cesium install");
    await runInstall(args, { version: CLI_VERSION, fail });
    return;
  }
  if (command === "doctor") {
    await runDoctorCommand(args);
    return;
  }
  if (MANAGED_COMMANDS.includes(command)) {
    delegate(command, args);
    return;
  }
  fail(
    `Unknown command: ${command}\n` +
      `Try \`cesium help\` or \`cesium doctor\` (home: ${cesiumHome()}).\n\n` +
      renderHelp(CLI_VERSION)
  );
}

await main();
