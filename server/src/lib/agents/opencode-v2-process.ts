import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { getOpenCodeAcpListenPort, openCodeAcpInternalBaseUrl } from "./opencode-acp-port.js";
import { buildCliInvocation, detectHarnessCli } from "./harness-runtime.js";
import { spawnSafeEnv } from "./spawn-env.js";
import {
  OpenCodeV2Client,
  openCodeV2AuthFromEnv,
} from "./opencode-v2-client.js";
import {
  RecentOutput,
  registerManagedServerShutdownHook,
  waitForManagedServerReady,
} from "./opencode-process-readiness.js";

export type OpenCodeV2Connection = {
  client: OpenCodeV2Client;
  managed: boolean;
  dispose: () => Promise<void>;
};

type ManagedServerPoolRow = {
  baseUrl: string;
  password: string;
  child: ChildProcess;
  ready: Promise<void>;
  refs: number;
  lingerTimer?: ReturnType<typeof setTimeout>;
};

const managedServerPool = new Map<string, ManagedServerPoolRow>();
registerManagedServerShutdownHook(() => stopAllManagedOpenCodeV2Servers());

/**
 * One v2 server hosts every workspace: the beta resolves the location of each
 * request from `x-opencode-directory` / the session, so a single `opencode2
 * serve` process is the intended "one server, many clients" topology. All
 * Cesium workspaces share this pool entry and just send their own directory.
 */
const SHARED_POOL_KEY = "opencode-v2-beta:shared";

/** Central detection (env override → PATH → `~/.opencode/bin` → common bins). */
export function resolveOpenCodeV2CommandPath(): string | null {
  return detectHarnessCli("opencode-v2")?.executablePath ?? null;
}

async function waitForHealth(client: OpenCodeV2Client): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const health = await client.health();
      if (health.healthy === true) {
        return;
      }
    } catch {
      // Keep polling while the beta server initializes its database and catalog.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`OpenCode v2 Beta did not become healthy at ${client.baseUrl}.`);
}

/** See the current-generation counterpart: first start can migrate the database and fetch catalogs. */
function managedServerStartupTimeoutMs(): number {
  const raw = Number.parseInt(process.env.OPENCURSOR_OPENCODE_STARTUP_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 1_000 ? raw : 60_000;
}

function stopManagedChild(child: ChildProcess): void {
  child.stdin?.end();
  if (child.exitCode != null) {
    return;
  }
  const forceTimer = setTimeout(() => {
    if (child.exitCode == null) {
      child.kill("SIGKILL");
    }
  }, 3_000);
  const terminateTimer = setTimeout(() => {
    if (child.exitCode == null) {
      child.kill("SIGTERM");
    }
  }, 1_500);
  child.once("exit", () => {
    clearTimeout(terminateTimer);
    clearTimeout(forceTimer);
  });
  terminateTimer.unref?.();
  forceTimer.unref?.();
}

function stopManagedServer(poolKey: string, row: ManagedServerPoolRow): void {
  if (managedServerPool.get(poolKey) === row) {
    managedServerPool.delete(poolKey);
  }
  stopManagedChild(row.child);
}

/** See the current-generation counterpart: keep the shared server warm between prompts. */
function managedServerLingerMs(): number {
  const raw = Number.parseInt(process.env.OPENCURSOR_OPENCODE_SERVER_LINGER_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10 * 60_000;
}

function releaseManagedServer(poolKey: string, row: ManagedServerPoolRow): void {
  row.refs = Math.max(0, row.refs - 1);
  if (row.refs > 0) {
    return;
  }
  const linger = managedServerLingerMs();
  if (linger === 0) {
    stopManagedServer(poolKey, row);
    return;
  }
  clearTimeout(row.lingerTimer);
  row.lingerTimer = setTimeout(() => {
    row.lingerTimer = undefined;
    if (row.refs === 0) {
      stopManagedServer(poolKey, row);
    }
  }, linger);
  row.lingerTimer.unref?.();
}

/** Stop every lingering managed v2 server (used by tests and shutdown). */
export function stopAllManagedOpenCodeV2Servers(): void {
  for (const [poolKey, row] of [...managedServerPool.entries()]) {
    clearTimeout(row.lingerTimer);
    stopManagedServer(poolKey, row);
  }
}

export async function connectOpenCodeV2(input: {
  workspaceRoot: string;
  onOutputLine?: (line: string) => void;
}): Promise<OpenCodeV2Connection> {
  const externalUrl = process.env.OPENCURSOR_OPENCODE_V2_SERVER_URL?.trim();
  if (externalUrl) {
    const client = new OpenCodeV2Client({
      baseUrl: externalUrl,
      directory: input.workspaceRoot,
      ...openCodeV2AuthFromEnv(),
    });
    await waitForHealth(client);
    return {
      client,
      managed: false,
      dispose: async () => undefined,
    };
  }

  const poolKey = SHARED_POOL_KEY;
  const existing = managedServerPool.get(poolKey);
  if (existing && existing.child.exitCode == null && !existing.child.killed) {
    existing.refs += 1;
    clearTimeout(existing.lingerTimer);
    existing.lingerTimer = undefined;
    try {
      await existing.ready;
    } catch (error) {
      releaseManagedServer(poolKey, existing);
      throw error;
    }
    return {
      // Each workspace gets its own client so its requests carry its directory.
      client: new OpenCodeV2Client({
        baseUrl: existing.baseUrl,
        password: existing.password,
        directory: input.workspaceRoot,
      }),
      managed: true,
      dispose: async () => releaseManagedServer(poolKey, existing),
    };
  }

  const port = await getOpenCodeAcpListenPort(poolKey);
  const baseUrl = openCodeAcpInternalBaseUrl(port);
  const password = randomBytes(32).toString("base64url");
  const executable = resolveOpenCodeV2CommandPath() ?? "opencode2";
  const invocation = buildCliInvocation(executable, [
    "serve",
    "--stdio",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ]);
  const directInvocation = invocation.command === executable;
  const configuredDirectory = process.env.OPENCURSOR_OPENCODE_V2_CONFIG_DIR?.trim();
  const child = spawn(
    invocation.command,
    invocation.args,
    {
      cwd: input.workspaceRoot,
      env: spawnSafeEnv({
        OPENCODE_PASSWORD: password,
        OPENCODE_CLIENT: "cesium-opencode-v2-beta",
        ...(configuredDirectory ? { OPENCODE_CONFIG_DIR: path.resolve(configuredDirectory) } : {}),
        ...(process.env.OPENCURSOR_OPENCODE_V2_DB?.trim()
          ? { OPENCODE_DB: process.env.OPENCURSOR_OPENCODE_V2_DB.trim() }
          : {}),
        OPENCURSOR_PROCESS_NAME: `Cesium Agent - OpenCode v2 Beta :${port}`,
      }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(directInvocation
        ? { argv0: `Cesium Agent - OpenCode v2 Beta :${port}` }
        : {}),
    }
  );
  const recentOutput = new RecentOutput();
  const reportLines = (chunk: unknown) => {
    for (const trimmed of recentOutput.push(chunk)) {
      // `--stdio` mode announces readiness with a single {"url": ...} line.
      if (!trimmed.startsWith('{"url":')) {
        input.onOutputLine?.(trimmed);
      }
    }
  };
  child.stdout?.on("data", reportLines);
  child.stderr?.on("data", reportLines);

  const client = new OpenCodeV2Client({
    baseUrl,
    password,
    directory: input.workspaceRoot,
  });
  const row: ManagedServerPoolRow = {
    baseUrl,
    password,
    child,
    refs: 1,
    ready: waitForManagedServerReady({
      child,
      label: `OpenCode v2 Beta at ${baseUrl}`,
      probe: async () => (await client.health()).healthy === true,
      timeoutMs: managedServerStartupTimeoutMs(),
      intervalMs: 250,
      recentOutput: () => recentOutput.snapshot(),
    }),
  };
  managedServerPool.set(poolKey, row);
  child.once("exit", () => {
    if (managedServerPool.get(poolKey) === row) {
      managedServerPool.delete(poolKey);
    }
  });
  try {
    await row.ready;
  } catch (error) {
    managedServerPool.delete(poolKey);
    stopManagedChild(child);
    throw error;
  }
  return {
    client,
    managed: true,
    dispose: async () => releaseManagedServer(poolKey, row),
  };
}

export function openCodeV2ConfiguredCommand(): string {
  return resolveOpenCodeV2CommandPath() ?? "opencode2";
}
