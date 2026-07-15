import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const resourcesRoot = process.resourcesPath || repoRoot;
const packagedServerHostExe = resolve(dirname(process.execPath), "Cesium Server.exe");
const packagedNodeExe = resolve(resourcesRoot, "server/node.exe");
const packagedServerEntry = resolve(resourcesRoot, "server/dist/index.js");
const repoServerEntry = resolve(repoRoot, "server/dist/index.js");
const usingPackagedResources = Boolean(process.resourcesPath) && existsSync(packagedServerEntry);
const serverEntry = usingPackagedResources ? packagedServerEntry : repoServerEntry;
const HEALTH_TIMEOUT_MS = usingPackagedResources ? 90_000 : 45_000;
const HEALTH_POLL_MS = 150;
const BACKEND_PID_FILE_NAME = ".cesium-backend.pid";
const DESKTOP_BACKEND_MARKER = "OPENCURSOR_DESKTOP_BACKEND";
const BACKEND_LOG_LIMIT = 12_000;
const DESKTOP_BACKEND_PROCESS_NAME = "Cesium Server";
// Packaged installs must never inherit a developer shell DATABASE_URL / Redis URL.
const USE_EXTERNAL_SERVICES =
  usingPackagedResources
    ? false
    : process.env.OPENCURSOR_DESKTOP_USE_EXTERNAL_SERVICES === "1";

function resolveDesktopBackendEnv() {
  if (USE_EXTERNAL_SERVICES) {
    return {
      OPENCURSOR_STORAGE_DRIVER: process.env.OPENCURSOR_STORAGE_DRIVER ?? "",
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      REDIS_URL: process.env.REDIS_URL ?? "",
    };
  }
  return {
    OPENCURSOR_STORAGE_DRIVER: "legacy-json",
    DATABASE_URL: "",
    REDIS_URL: "",
  };
}

function appendRecentOutput(current, chunk) {
  const next = `${current}${chunk.toString()}`;
  if (next.length <= BACKEND_LOG_LIMIT) {
    return next;
  }
  return next.slice(next.length - BACKEND_LOG_LIMIT);
}

function formatBackendFailure(message, output) {
  const parts = [message];
  const stderr = output?.stderr?.trim();
  const stdout = output?.stdout?.trim();
  if (stderr) {
    parts.push(`Recent backend stderr:\n${stderr}`);
  }
  if (stdout) {
    parts.push(`Recent backend stdout:\n${stdout}`);
  }
  return parts.join("\n\n");
}

async function getFreePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

function backendPidFile(dataDir) {
  return resolve(dataDir ?? repoRoot, BACKEND_PID_FILE_NAME);
}

function parseBackendPidFile(raw) {
  const trimmed = raw.trim();
  // Current format: JSON { pid, bin, startedAt }. Legacy format: bare integer.
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const pid = Number.parseInt(String(parsed?.pid), 10);
      return Number.isFinite(pid) && pid > 0
        ? { pid, bin: typeof parsed?.bin === "string" ? parsed.bin : null }
        : null;
    } catch {
      return null;
    }
  }
  const pid = Number.parseInt(trimmed, 10);
  return Number.isFinite(pid) && pid > 0 ? { pid, bin: null } : null;
}

function expectedBackendBinNames() {
  const names = new Set(["node", "node.exe"]);
  for (const bin of [packagedNodeExe, packagedServerHostExe, process.execPath]) {
    try {
      names.add(basename(bin).toLowerCase());
    } catch {
      // ignore
    }
  }
  return names;
}

/**
 * The OS recycles PIDs; a stale pidfile must never get an unrelated process
 * killed. Only report a match when the live process actually looks like our
 * backend (image name on Windows, command line on POSIX).
 */
function processLooksLikeBackend(pid, recordedBin) {
  if (process.platform === "win32") {
    const out =
      spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        windowsHide: true,
      }).stdout ?? "";
    const image = out.split(",")[0]?.replace(/"/g, "").trim().toLowerCase();
    if (!image || image.includes("no tasks")) {
      return false;
    }
    if (recordedBin && image === recordedBin.toLowerCase()) {
      return true;
    }
    return expectedBackendBinNames().has(image);
  }
  const out =
    spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" }).stdout ?? "";
  const args = out.trim();
  if (!args) {
    return false;
  }
  return (
    args.includes(serverEntry) ||
    args.includes(DESKTOP_BACKEND_PROCESS_NAME) ||
    (recordedBin ? args.includes(recordedBin) : false)
  );
}

function reapStaleDesktopBackend(pidFile) {
  let raw = null;
  try {
    raw = readFileSync(pidFile, "utf8");
  } catch {
    return;
  }
  const record = parseBackendPidFile(raw);
  if (record) {
    try {
      process.kill(record.pid, 0);
      if (processLooksLikeBackend(record.pid, record.bin)) {
        killProcessTree(record.pid);
      }
    } catch {
      // already gone
    }
  }
  try {
    unlinkSync(pidFile);
  } catch {
    // ignore
  }
}

function rememberBackendPid(pidFile, pid, bin) {
  try {
    writeFileSync(
      pidFile,
      JSON.stringify({ pid, bin: bin ? basename(bin) : null, startedAt: Date.now() }),
      "utf8"
    );
  } catch {
    // non-fatal
  }
}

function forgetBackendPid(pidFile) {
  try {
    unlinkSync(pidFile);
  } catch {
    // ignore
  }
}

async function readHealthPayload(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function healthIsReady(payload) {
  return payload?.ok === true && payload?.bootstrapping !== true;
}

export async function startCesiumBackend(options = {}) {
  const dataDir = options.dataDir?.trim();
  const pidFile = backendPidFile(dataDir ?? options.cwd ?? repoRoot);
  reapStaleDesktopBackend(pidFile);
  const port = await getFreePort();
  const nodeBin = usingPackagedResources
    ? existsSync(packagedNodeExe)
      ? packagedNodeExe
      : existsSync(packagedServerHostExe)
        ? packagedServerHostExe
        : process.execPath
    : process.env.OPENCURSOR_NODE_BIN || "node";
  const spawnCwd = usingPackagedResources
    ? resourcesRoot
    : (options.cwd ?? repoRoot);
  const child = spawn(nodeBin, [serverEntry], {
    cwd: spawnCwd,
    env: {
      ...process.env,
      ...(usingPackagedResources ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      ...(dataDir ? { OPENCURSOR_DATA_DIR: dataDir } : {}),
      HOST: "127.0.0.1",
      PORT: String(port),
      NODE_PATH: usingPackagedResources
        ? resolve(resourcesRoot, "server/node_modules")
        : process.env.NODE_PATH,
      [DESKTOP_BACKEND_MARKER]: "1",
      ...(usingPackagedResources ? { OPENCURSOR_DESKTOP_IMPORT_LEGACY_DATA: "1" } : {}),
      OPENCURSOR_PROCESS_NAME: `${DESKTOP_BACKEND_PROCESS_NAME} :${port}`,
      OPENCURSOR_DESKTOP_PARENT_PID: String(process.pid),
      ...resolveDesktopBackendEnv(),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // POSIX: become a process-group leader so killProcessTree's `kill(-pid)`
    // reaps grandchildren (pty shells, MCP servers). The backend's parent-pid
    // watchdog still self-exits if Electron dies without cleanup.
    detached: process.platform !== "win32",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  let spawnError = null;
  let recentStdout = "";
  let recentStderr = "";

  child.once("error", (error) => {
    spawnError = error;
  });

  child.stdout?.on("data", (chunk) => {
    recentStdout = appendRecentOutput(recentStdout, chunk);
    process.stdout.write(`[cesium-server] ${chunk}`);
  });
  child.stderr?.on("data", (chunk) => {
    recentStderr = appendRecentOutput(recentStderr, chunk);
    process.stderr.write(`[cesium-server] ${chunk}`);
  });

  await waitForHealth(baseUrl, child, () => spawnError, () => ({
    stdout: recentStdout,
    stderr: recentStderr,
  }));
  rememberBackendPid(pidFile, child.pid, nodeBin);

  return {
    port,
    baseUrl,
    child,
    stop() {
      forgetBackendPid(pidFile);
      killProcessTree(child.pid);
    },
  };
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

async function waitForHealth(baseUrl, child, getSpawnError, getOutput) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = null;

  while (Date.now() < deadline) {
    const spawnError = getSpawnError?.();
    if (spawnError) {
      throw new Error(formatBackendFailure(
        `Cesium backend failed to launch: ${spawnError.message}`,
        getOutput?.()
      ));
    }
    if (child.exitCode !== null) {
      throw new Error(formatBackendFailure(
        `Cesium backend exited before becoming healthy (${child.exitCode}).`,
        getOutput?.()
      ));
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { cache: "no-store" });
      if (response.ok) {
        const payload = await readHealthPayload(response);
        if (healthIsReady(payload)) {
          return;
        }
        lastError = new Error("Health endpoint is still bootstrapping.");
      } else {
        lastError = new Error(`Health returned ${response.status}.`);
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }

  killProcessTree(child.pid);
  throw new Error(formatBackendFailure(
    `Cesium backend did not become healthy at ${baseUrl}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    getOutput?.()
  ));
}

const runningInsideElectron = Boolean(process.versions.electron);

if (!runningInsideElectron && process.argv.includes("--check")) {
  console.log("Cesium desktop scaffold is ready.");
} else if (!runningInsideElectron && process.argv.includes("--smoke")) {
  const backend = await startCesiumBackend();
  console.log(`Cesium backend smoke passed at ${backend.baseUrl}`);
  backend.stop();
} else if (!runningInsideElectron && process.env.OPENCURSOR_DESKTOP_START_BACKEND === "1") {
  const backend = await startCesiumBackend();
  console.log(`Cesium backend listening at ${backend.baseUrl}`);
}
