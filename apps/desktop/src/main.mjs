import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const resourcesRoot = process.resourcesPath || repoRoot;
const packagedServerEntry = resolve(resourcesRoot, "server/dist/index.js");
const repoServerEntry = resolve(repoRoot, "server/dist/index.js");
const usingPackagedResources = Boolean(process.resourcesPath) && existsSync(packagedServerEntry);
const serverEntry = usingPackagedResources ? packagedServerEntry : repoServerEntry;
const HEALTH_TIMEOUT_MS = 20_000;
const DESKTOP_BACKEND_MARKER = "OPENCURSOR_DESKTOP_BACKEND";
const BACKEND_LOG_LIMIT = 12_000;
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

export async function startCesiumBackend(options = {}) {
  reapStaleDesktopBackends();
  const port = await getFreePort();
  const nodeBin = usingPackagedResources
    ? process.execPath
    : process.env.OPENCURSOR_NODE_BIN || "node";
  const cwd = options.cwd ?? (usingPackagedResources ? resourcesRoot : repoRoot);
  const dataDir = options.dataDir?.trim();
  const child = spawn(nodeBin, [serverEntry], {
    cwd,
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
      OPENCURSOR_DESKTOP_PARENT_PID: String(process.pid),
      ...resolveDesktopBackendEnv(),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
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

  return {
    port,
    baseUrl,
    child,
    stop() {
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

function reapStaleDesktopBackends() {
  if (process.platform !== "win32") return;
  try {
    const output = execFileSync(
      "wmic",
      [
        "process",
        "where",
        `CommandLine like '%${serverEntry.replace(/\\/g, "\\\\")}%'`,
        "get",
        "ProcessId,CommandLine",
        "/format:csv",
      ],
      { encoding: "utf8", windowsHide: true }
    );
    for (const line of output.split(/\r?\n/)) {
      if (!line.includes("server/dist/index.js") && !line.includes("server\\dist\\index.js")) {
        continue;
      }
      const pid = line.match(/,(\d+)\s*$/)?.[1];
      if (pid && Number(pid) !== process.pid) {
        killProcessTree(Number(pid));
      }
    }
  } catch {
    // WMIC may be unavailable; normal quit hooks still clean the active backend.
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
        return;
      }
      lastError = new Error(`Health returned ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
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
