/**
 * Native Windows engine installer + lifecycle.
 *
 * Bun runs on Windows. The bash installer and `scripts/cesium-server` do not
 * (systemd/launchd, `ps`/`kill`, bash `%q` env files). This module is the
 * slice that actually works natively:
 *   - install Bun into %USERPROFILE%\.cesium\runtime\bin
 *   - clone/build the engine
 *   - start/stop/status/health/logs/connect/credentials/update
 *   - add ~/.cesium\bin to the user PATH
 *
 * Honest blockers left on Windows:
 *   - localhost-run SSH tunnels (POSIX ssh + bash manager)
 *   - systemd/launchd autostart (we drop a Startup-folder cmd instead)
 * Named/public URL + optional cloudflared.exe still work when configured.
 */

import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envValue, parseEnvFile, serializeEnvFile } from "./env-file.mjs";

const CLI_VERSION = createRequire(import.meta.url)("../package.json").version;
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

export const WINDOWS_DESKTOP_INSTALL_DIR = "Cesium";
export const WINDOWS_STALE_NSIS_DIR = "@cesiumdesktop";
export const DEFAULT_REPO_URL = "https://github.com/BenItBuhner/Cesium.git";
export const BUN_RELEASE_BASE = "https://github.com/oven-sh/bun/releases/latest/download";

export function windowsDesktopInstallPath(localAppData) {
  return path.win32.join(localAppData, "Programs", WINDOWS_DESKTOP_INSTALL_DIR);
}

export function windowsStaleNsisInstallPath(localAppData) {
  return path.win32.join(localAppData, "Programs", WINDOWS_STALE_NSIS_DIR);
}

export function cesiumHome(env = process.env, home = homedir()) {
  const override = env.CESIUM_HOME?.trim();
  return override || path.join(home, ".cesium");
}

export function bunZipName(arch = process.arch) {
  return arch === "arm64" ? "bun-windows-aarch64.zip" : "bun-windows-x64.zip";
}

export function bunDownloadUrl(arch = process.arch) {
  return `${BUN_RELEASE_BASE}/${bunZipName(arch)}`;
}

export function managerPaths(home) {
  return {
    home,
    binDir: path.join(home, "bin"),
    runtimeBin: path.join(home, "runtime", "bin"),
    sourceDir: path.join(home, "source"),
    stateDir: path.join(home, "state"),
    logsDir: path.join(home, "logs"),
    runDir: path.join(home, "run"),
    envFile: path.join(home, "server.env"),
    bunBin: path.join(home, "runtime", "bin", "bun.exe"),
    cloudflaredBin: path.join(home, "runtime", "bin", "cloudflared.exe"),
    engineEntry: path.join(home, "source", "server", "src", "runtime", "bun-server.ts"),
    pidFile: path.join(home, "run", "server.pid"),
    serverLog: path.join(home, "logs", "server.log"),
    managerCmd: path.join(home, "bin", "cesium-server.cmd"),
    startupCmd: path.join(home, "bin", "cesium-engine-autostart.cmd"),
  };
}

export function userPathContains(pathValue, entry) {
  const parts = String(pathValue ?? "")
    .split(";")
    .map((part) => part.replace(/[/\\]+$/, "").toLowerCase())
    .filter(Boolean);
  const needle = entry.replace(/[/\\]+$/, "").toLowerCase();
  return parts.includes(needle);
}

export function mergeUserPath(pathValue, entry) {
  if (userPathContains(pathValue, entry)) {
    return { next: pathValue, changed: false };
  }
  const trimmed = String(pathValue ?? "").replace(/;+$/, "");
  return {
    next: trimmed ? `${trimmed};${entry}` : entry,
    changed: true,
  };
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function writeText(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, { encoding: "utf8" });
}

function loadEnv(paths) {
  if (!existsSync(paths.envFile)) {
    return null;
  }
  return parseEnvFile(readFileSync(paths.envFile, "utf8"));
}

function randomSecret(bytes) {
  return randomBytes(bytes).toString("base64url");
}

function parseInstallArgs(args) {
  const options = { webUrl: "" };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--web-url") {
      const value = args[i + 1];
      if (!value) {
        fail("--web-url requires a value, e.g. --web-url https://cesium.example.com");
      }
      options.webUrl = value;
      i += 1;
    } else {
      fail(`Unknown install option: ${args[i]}`);
    }
  }
  return options;
}

function commandExists(command) {
  const probe = spawnSync(command, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return probe.status === 0 || probe.status === null && Boolean(probe.stdout);
}

function runOrFail(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
    cwd: options.cwd,
    env: options.env ?? process.env,
    windowsHide: true,
    shell: Boolean(options.shell),
  });
  if ((result.status ?? 1) !== 0) {
    fail(options.errorMessage ?? `${command} failed with exit ${result.status ?? 1}`);
  }
  return result;
}

function readPid(pidFile) {
  if (!existsSync(pidFile)) {
    return null;
  }
  const raw = readFileSync(pidFile, "utf8").trim();
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  return Number(raw);
}

export function processLooksAlive(pid, platform = process.platform) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    if (platform === "win32") {
      const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], {
        encoding: "utf8",
        windowsHide: true,
      });
      return (result.stdout ?? "").includes(String(pid));
    }
    return false;
  }
}

async function downloadToFile(url, dest) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} downloading ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  writeText(dest, "");
  writeFileSync(dest, bytes);
}

function extractZip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath '${zipPath.replaceAll("'", "''")}' -DestinationPath '${destDir.replaceAll("'", "''")}' -Force`,
    ],
    { encoding: "utf8", windowsHide: true }
  );
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || "Expand-Archive failed");
  }
}

function findExtractedBun(extractRoot) {
  const candidates = [
    path.join(extractRoot, "bun.exe"),
    path.join(extractRoot, "bun-windows-x64", "bun.exe"),
    path.join(extractRoot, "bun-windows-aarch64", "bun.exe"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function ensureBun(paths) {
  if (existsSync(paths.bunBin)) {
    return;
  }
  mkdirSync(paths.runtimeBin, { recursive: true });
  const onPath = spawnSync("bun.exe", ["--version"], { encoding: "utf8", windowsHide: true });
  if (onPath.status === 0 && onPath.stdout) {
    const where = spawnSync("where.exe", ["bun.exe"], { encoding: "utf8", windowsHide: true });
    const first = (where.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (first && existsSync(first)) {
      copyFileSync(first, paths.bunBin);
      return;
    }
  }
  process.stdout.write(`Installing Bun (${bunZipName()}) into ${paths.runtimeBin}...\n`);
  const zipPath = path.join(tmpdir(), `cesium-bun-${process.pid}.zip`);
  const extractDir = path.join(tmpdir(), `cesium-bun-${process.pid}`);
  try {
    await downloadToFile(bunDownloadUrl(), zipPath);
    extractZip(zipPath, extractDir);
    const extracted = findExtractedBun(extractDir);
    if (!extracted) {
      throw new Error("Bun zip did not contain bun.exe");
    }
    copyFileSync(extracted, paths.bunBin);
  } finally {
    rmSync(zipPath, { force: true });
    rmSync(extractDir, { recursive: true, force: true });
  }
}

function writeManagerShims(paths) {
  const engineSource = path.join(THIS_DIR, "windows-engine.mjs");
  const envSource = path.join(THIS_DIR, "env-file.mjs");
  const engineDest = path.join(paths.binDir, "windows-engine.mjs");
  const envDest = path.join(paths.binDir, "env-file.mjs");
  mkdirSync(paths.binDir, { recursive: true });
  copyFileSync(engineSource, engineDest);
  copyFileSync(envSource, envDest);
  writeText(
    paths.managerCmd,
    [
      "@echo off",
      "setlocal",
      `set "CESIUM_HOME=${paths.home}"`,
      `"${paths.bunBin}" "${engineDest}" %*`,
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n")
  );
  writeText(
    paths.startupCmd,
    [
      "@echo off",
      "setlocal",
      `set "CESIUM_HOME=${paths.home}"`,
      `"${paths.bunBin}" "${engineDest}" start`,
      "",
    ].join("\r\n")
  );
}

function startupFolder(env = process.env) {
  const appData = env.APPDATA?.trim();
  if (!appData) {
    return null;
  }
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

export function installStartupShortcut(paths, env = process.env) {
  const folder = startupFolder(env);
  if (!folder) {
    return null;
  }
  const dest = path.join(folder, "Cesium Engine.cmd");
  mkdirSync(folder, { recursive: true });
  copyFileSync(paths.startupCmd, dest);
  return dest;
}

function addBinToUserPath(binDir) {
  const script = `
$entry = $env:CESIUM_PATH_ENTRY
$old = [Environment]::GetEnvironmentVariable('Path', 'User')
if ([string]::IsNullOrEmpty($old)) { $old = '' }
$parts = @($old -split ';' | Where-Object { $_ -ne '' })
$match = $parts | Where-Object { $_.TrimEnd('\\/') -ieq $entry.TrimEnd('\\/') }
if ($match) { Write-Output 'unchanged'; exit 0 }
$next = if ($old.Trim() -eq '') { $entry } else { ($old.TrimEnd(';') + ';' + $entry) }
[Environment]::SetEnvironmentVariable('Path', $next, 'User')
Write-Output 'updated'
`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, CESIUM_PATH_ENTRY: binDir },
    }
  );
  if ((result.status ?? 1) !== 0) {
    process.stderr.write(
      `Could not add ${binDir} to the user PATH. Add it manually if \`cesium-server\` is not found.\n`
    );
    return false;
  }
  return (result.stdout ?? "").includes("updated");
}

function writeServerEnv(paths, options) {
  const existing = existsSync(paths.envFile) ? loadEnv(paths) ?? {} : {};
  const webUrl = options.webUrl || envValue(existing, "CESIUM_WEB_URL");
  let webOrigin = "";
  if (webUrl) {
    try {
      webOrigin = new URL(webUrl).origin;
    } catch {
      fail("CESIUM_WEB_URL must be an absolute http(s) URL.");
    }
  }
  const workspaceRoot =
    process.env.CESIUM_WORKSPACE_ROOT?.trim() ||
    envValue(existing, "WORKSPACE_ROOT") ||
    process.cwd();
  const values = {
    CESIUM_HOME: paths.home,
    CESIUM_SOURCE_DIR: paths.sourceDir,
    CESIUM_BUN_BIN: paths.bunBin,
    CESIUM_CLOUDFLARED_BIN: paths.cloudflaredBin,
    CESIUM_WEB_URL: webUrl,
    CESIUM_SERVER_ID: envValue(existing, "CESIUM_SERVER_ID") || randomSecret(24),
    CESIUM_SERVER_LABEL: envValue(existing, "CESIUM_SERVER_LABEL") || "Cesium server",
    CESIUM_RENDEZVOUS_URL:
      envValue(existing, "CESIUM_RENDEZVOUS_URL") ||
      (webOrigin ? `${webOrigin}/api/rendezvous` : ""),
    CESIUM_RENDEZVOUS_READ_SECRET:
      envValue(existing, "CESIUM_RENDEZVOUS_READ_SECRET") || randomSecret(32),
    CESIUM_RENDEZVOUS_WRITE_SECRET:
      envValue(existing, "CESIUM_RENDEZVOUS_WRITE_SECRET") || randomSecret(32),
    CESIUM_SERVICE_MANAGER: "detached",
    CESIUM_TUNNEL_ENABLED: "0",
    HOST: "127.0.0.1",
    PORT: process.env.CESIUM_PORT?.trim() || envValue(existing, "PORT", "9100"),
    NODE_ENV: "production",
    OPENCURSOR_PROCESS_NAME: "Cesium Server",
    OPENCURSOR_STORAGE_DRIVER: "legacy-json",
    OPENCURSOR_DATA_DIR: process.env.CESIUM_STATE_DIR?.trim() || paths.stateDir,
    OPENCURSOR_AUTH_USERNAME:
      process.env.CESIUM_AUTH_USERNAME?.trim() ||
      envValue(existing, "OPENCURSOR_AUTH_USERNAME", "cesium"),
    OPENCURSOR_AUTH_PASSWORD:
      process.env.CESIUM_AUTH_PASSWORD?.trim() ||
      envValue(existing, "OPENCURSOR_AUTH_PASSWORD") ||
      randomSecret(24),
    ALLOWED_ORIGINS: webOrigin
      ? `${webOrigin},http://localhost:3000,http://127.0.0.1:3000`
      : "http://localhost:3000,http://127.0.0.1:3000",
    WORKSPACE_ALLOWED_ROOTS: workspaceRoot,
    WORKSPACE_ROOT: workspaceRoot,
  };
  writeText(paths.envFile, serializeEnvFile(values));
  try {
    chmodSync(paths.envFile, 0o600);
  } catch {
    // Windows may ignore POSIX modes; the file still lives under the user profile.
  }
  return values;
}

function syncSource(paths) {
  const repoUrl = process.env.CESIUM_REPO_URL?.trim() || DEFAULT_REPO_URL;
  const branch = process.env.CESIUM_REPO_BRANCH?.trim() || "main";
  if (existsSync(path.join(paths.sourceDir, ".git"))) {
    process.stdout.write(`Updating Cesium source in ${paths.sourceDir}...\n`);
    runOrFail("git", ["-C", paths.sourceDir, "remote", "set-branches", "origin", branch]);
    runOrFail("git", ["-C", paths.sourceDir, "fetch", "origin", branch]);
    runOrFail("git", ["-C", paths.sourceDir, "checkout", "-B", branch, `refs/remotes/origin/${branch}`]);
    return;
  }
  process.stdout.write(`Downloading Cesium source (${branch})...\n`);
  rmSync(paths.sourceDir, { recursive: true, force: true });
  runOrFail("git", ["clone", "--depth", "1", "--branch", branch, repoUrl, paths.sourceDir]);
}

function buildEngine(paths) {
  process.stdout.write("Installing Cesium server dependencies...\n");
  const env = {
    ...process.env,
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    PUPPETEER_SKIP_DOWNLOAD: "1",
    ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
  runOrFail(
    paths.bunBin,
    [
      "install",
      "--filter",
      "@cesium/core",
      "--filter",
      "cesium-server",
      "--ignore-scripts",
      "--no-save",
    ],
    { cwd: paths.sourceDir, env }
  );
  runOrFail(paths.bunBin, ["run", "--cwd", "packages/core", "build"], {
    cwd: paths.sourceDir,
    env,
  });
  runOrFail(paths.bunBin, ["run", "--cwd", "packages/contracts", "build"], {
    cwd: paths.sourceDir,
    env,
  });
  rmSync(path.join(paths.sourceDir, "server", "node_modules", "cesium"), { force: true });
  rmSync(path.join(paths.sourceDir, "server", "node_modules", "@cesium"), {
    recursive: true,
    force: true,
  });
  if (!existsSync(paths.engineEntry)) {
    fail(`Server runtime is missing after installation: ${paths.engineEntry}`);
  }
}

function processEnvFromFile(values) {
  return { ...process.env, ...values };
}

async function fetchHealth(values) {
  const host = envValue(values, "HOST", "127.0.0.1");
  const port = envValue(values, "PORT", "9100");
  const url = `http://${host}:${port}/health`;
  try {
    const response = await fetch(url);
    return { url, ok: response.ok, status: response.status };
  } catch (error) {
    return { url, ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

function printConnect(values) {
  const host = envValue(values, "HOST", "127.0.0.1");
  const port = envValue(values, "PORT", "9100");
  const username = envValue(values, "OPENCURSOR_AUTH_USERNAME", "cesium");
  const password = envValue(values, "OPENCURSOR_AUTH_PASSWORD");
  process.stdout.write(`URL: http://${host}:${port}\n`);
  process.stdout.write(`Username: ${username}\n`);
  process.stdout.write(`Password: ${password}\n`);
  const webUrl = envValue(values, "CESIUM_WEB_URL");
  if (webUrl) {
    process.stdout.write(`Web app: ${webUrl}\n`);
  }
}

async function cmdInstall(args, home) {
  const options = parseInstallArgs(args);
  if (!commandExists("git")) {
    fail(
      "git is required to install the Cesium engine on Windows.\n" +
        "Install Git for Windows (https://git-scm.com/download/win) and re-run `cesium install`."
    );
  }
  const paths = managerPaths(home);
  mkdirSync(paths.binDir, { recursive: true });
  mkdirSync(paths.runtimeBin, { recursive: true });
  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  mkdirSync(paths.runDir, { recursive: true });
  await ensureBun(paths);
  syncSource(paths);
  buildEngine(paths);
  const values = writeServerEnv(paths, options);
  writeManagerShims(paths);
  const pathChanged = addBinToUserPath(paths.binDir);
  const startup = process.env.CESIUM_SKIP_AUTOSTART === "1"
    ? null
    : installStartupShortcut(paths);
  process.stdout.write(`\nCesium server installed in ${paths.home}.\n`);
  process.stdout.write("Lifecycle: detached (native Windows)\n");
  if (pathChanged) {
    process.stdout.write(`Added ${paths.binDir} to the user PATH (new terminals pick this up).\n`);
  }
  if (startup) {
    process.stdout.write(`Login autostart: ${startup}\n`);
  }
  process.stdout.write(
    "Tunnels: localhost-run is POSIX-only. Set CESIUM_PUBLIC_URL for a named host, or use Cesium Desktop.\n"
  );
  if (process.env.CESIUM_SKIP_AUTOSTART === "1") {
    process.stdout.write("Start it with: cesium start\n");
    return;
  }
  await cmdStart(home, values);
}

function requireInstalled(paths) {
  if (!existsSync(paths.envFile) || !existsSync(paths.engineEntry) || !existsSync(paths.bunBin)) {
    fail(
      `The Cesium engine is not installed (missing ${paths.envFile}).\n` +
        "Run `cesium install` first."
    );
  }
}

async function cmdStart(home, existingValues) {
  const paths = managerPaths(home);
  requireInstalled(paths);
  const values = existingValues ?? loadEnv(paths);
  if (!values) {
    fail(`The Cesium engine is not installed (missing ${paths.envFile}).`);
  }
  const existingPid = readPid(paths.pidFile);
  if (existingPid && processLooksAlive(existingPid)) {
    process.stdout.write(`Already running (pid ${existingPid}).\n`);
    printConnect(values);
    return;
  }
  mkdirSync(paths.logsDir, { recursive: true });
  mkdirSync(paths.runDir, { recursive: true });
  const child = spawn(paths.bunBin, [paths.engineEntry], {
    cwd: path.join(paths.sourceDir, "server"),
    env: processEnvFromFile(values),
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  if (!child.pid) {
    fail("Failed to start the Cesium engine process.");
  }
  writeText(paths.pidFile, `${child.pid}\n`);
  child.unref();
  process.stdout.write(`Started Cesium engine (pid ${child.pid}).\n`);
  printConnect(values);
}

function cmdStop(home) {
  const paths = managerPaths(home);
  const pid = readPid(paths.pidFile);
  if (!pid || !processLooksAlive(pid)) {
    process.stdout.write("Cesium engine is not running.\n");
    return;
  }
  const killed = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if ((killed.status ?? 1) !== 0) {
    try {
      process.kill(pid);
    } catch {
      fail(`Could not stop pid ${pid}.`);
    }
  }
  rmSync(paths.pidFile, { force: true });
  process.stdout.write(`Stopped Cesium engine (pid ${pid}).\n`);
}

async function cmdStatus(home) {
  const paths = managerPaths(home);
  requireInstalled(paths);
  const values = loadEnv(paths);
  const pid = readPid(paths.pidFile);
  const running = Boolean(pid && processLooksAlive(pid));
  const health = running ? await fetchHealth(values) : { ok: false, url: "", status: 0 };
  process.stdout.write(`Install: ${paths.home}\n`);
  process.stdout.write(`Process: ${running ? `running (pid ${pid})` : "stopped"}\n`);
  process.stdout.write(`Health: ${health.ok ? `ok ${health.url}` : "unavailable"}\n`);
  process.stdout.write("Tunnel: not managed on native Windows (use CESIUM_PUBLIC_URL or Cesium Desktop)\n");
}

async function cmdHealth(home) {
  const paths = managerPaths(home);
  requireInstalled(paths);
  const health = await fetchHealth(loadEnv(paths));
  if (!health.ok) {
    fail(`Health check failed for ${health.url}${health.error ? ` (${health.error})` : ""}`);
  }
  process.stdout.write(`ok ${health.url}\n`);
}

function cmdLogs(home, args) {
  const paths = managerPaths(home);
  requireInstalled(paths);
  const logFile = paths.serverLog;
  if (!existsSync(logFile)) {
    process.stdout.write(`No log file yet (${logFile}).\n`);
    return;
  }
  if (args.includes("-f") || args.includes("--follow")) {
    fail("Log follow is not implemented on native Windows yet. Open the log file instead:\n" + logFile);
  }
  process.stdout.write(readFileSync(logFile, "utf8"));
}

function cmdConnect(home) {
  const paths = managerPaths(home);
  requireInstalled(paths);
  printConnect(loadEnv(paths));
}

function cmdCredentials(home, args) {
  const paths = managerPaths(home);
  requireInstalled(paths);
  const values = loadEnv(paths);
  if (args[0] === "rotate") {
    values.OPENCURSOR_AUTH_PASSWORD = randomSecret(24);
    writeText(paths.envFile, serializeEnvFile(values));
    process.stdout.write("Rotated OPENCURSOR_AUTH_PASSWORD.\n");
  }
  process.stdout.write(`Username: ${envValue(values, "OPENCURSOR_AUTH_USERNAME", "cesium")}\n`);
  process.stdout.write(`Password: ${envValue(values, "OPENCURSOR_AUTH_PASSWORD")}\n`);
}

async function cmdUpdate(home) {
  const paths = managerPaths(home);
  requireInstalled(paths);
  syncSource(paths);
  buildEngine(paths);
  process.stdout.write("Engine source updated. Run `cesium restart` to load it.\n");
}

export function windowsHelpExtra() {
  return [
    "",
    "Windows (native):",
    "  cesium install/start/stop/status work without WSL. Git for Windows is required.",
    "  Install root: %USERPROFILE%\\.cesium  (override with CESIUM_HOME)",
    "  Autostart: Startup folder `Cesium Engine.cmd` (not systemd/launchd).",
    "  Tunnels: localhost-run is POSIX-only; set CESIUM_PUBLIC_URL or use Cesium Desktop.",
    "",
    "Windows desktop installer:",
    "  Per-user one-click setup, no admin. Builds are unsigned — SmartScreen may warn.",
    "  Choose More info → Run anyway. There is no code-signing cert on these builds.",
  ].join("\n");
}

export async function runWindowsCommand(command, args, env = process.env) {
  const home = cesiumHome(env);
  if (command === "install") {
    await cmdInstall(args, home);
    return;
  }
  if (command === "start" || command === "run") {
    await cmdStart(home);
    return;
  }
  if (command === "stop") {
    cmdStop(home);
    return;
  }
  if (command === "restart") {
    cmdStop(home);
    await cmdStart(home);
    return;
  }
  if (command === "status") {
    await cmdStatus(home);
    return;
  }
  if (command === "health") {
    await cmdHealth(home);
    return;
  }
  if (command === "logs") {
    cmdLogs(home, args);
    return;
  }
  if (command === "connect") {
    cmdConnect(home);
    return;
  }
  if (command === "credentials") {
    cmdCredentials(home, args);
    return;
  }
  if (command === "update") {
    await cmdUpdate(home);
    return;
  }
  if (command === "supervise") {
    fail(
      "cesium supervise is a POSIX service helper (systemd/launchd).\n" +
        "On Windows the engine runs detached — use `cesium start` and the Startup-folder cmd."
    );
  }
  fail(`Unknown command: ${command}`);
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    process.stdout.write(`cesium-server ${CLI_VERSION} (Windows manager)\n`);
    process.exit(0);
  }
  void runWindowsCommand(command, args).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  });
}
