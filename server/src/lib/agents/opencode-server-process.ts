import { spawn, type ChildProcess } from "node:child_process";
import { buildCliInvocation, detectHarnessCli } from "./harness-runtime.js";
import { getOpenCodeAcpListenPort, openCodeAcpInternalBaseUrl } from "./opencode-acp-port.js";
import { spawnSafeEnv } from "./spawn-env.js";
import { harnessLog } from "./harness-diagnostics.js";
import {
  RecentOutput,
  registerManagedServerShutdownHook,
  waitForManagedServerReady,
} from "./opencode-process-readiness.js";
import {
  OpenCodeServerClient,
  openCodeServerAuthFromEnv,
} from "./opencode-server-client.js";

export type OpenCodeServerProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type OpenCodeServerConnection = {
  client: OpenCodeServerClient;
  managed: boolean;
  /**
   * Registers a listener fired when the managed OpenCode process exits while
   * this connection is still attached. Returns an unsubscribe function.
   * External (unmanaged) connections never fire it.
   */
  onProcessExit: (listener: (exit: OpenCodeServerProcessExit) => void) => () => void;
  dispose: () => Promise<void>;
};

type ManagedServerPoolRow = {
  client: OpenCodeServerClient;
  child: ChildProcess;
  ready: Promise<void>;
  refs: number;
  exitListeners: Set<(exit: OpenCodeServerProcessExit) => void>;
  exited: OpenCodeServerProcessExit | null;
  lingerTimer?: ReturnType<typeof setTimeout>;
};

const managedServerPool = new Map<string, ManagedServerPoolRow>();
registerManagedServerShutdownHook(() => stopAllManagedOpenCodeServers());

/**
 * The runtime disposes idle conversation handles after a few seconds, so
 * without a grace period every prompt after a short pause paid a full server
 * boot (database open, plugin install, model catalog). Keep the process warm
 * for a while after the last session detaches and reuse it.
 */
export function managedServerLingerMs(): number {
  const raw = Number.parseInt(process.env.OPENCURSOR_OPENCODE_SERVER_LINGER_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10 * 60_000;
}

function stopManagedOpenCodeServer(poolKey: string, row: ManagedServerPoolRow, reason: string): void {
  if (managedServerPool.get(poolKey) === row) {
    managedServerPool.delete(poolKey);
  }
  if (!row.child.killed && row.child.exitCode == null) {
    harnessLog({
      backendId: "opencode-server",
      event: "process.stop",
      detail: `Stopping managed OpenCode Server (${reason}): ${row.client.baseUrl}`,
    });
    row.child.kill();
  }
}

function releaseManagedOpenCodeServer(poolKey: string, row: ManagedServerPoolRow): void {
  row.refs = Math.max(0, row.refs - 1);
  if (row.refs > 0) {
    return;
  }
  const linger = managedServerLingerMs();
  if (linger === 0) {
    stopManagedOpenCodeServer(poolKey, row, "last session detached");
    return;
  }
  clearTimeout(row.lingerTimer);
  row.lingerTimer = setTimeout(() => {
    row.lingerTimer = undefined;
    if (row.refs === 0) {
      stopManagedOpenCodeServer(poolKey, row, `idle for ${Math.round(linger / 1000)}s`);
    }
  }, linger);
  row.lingerTimer.unref?.();
}

/** Stop every lingering managed server (used by tests and shutdown). */
export function stopAllManagedOpenCodeServers(): void {
  for (const [poolKey, row] of [...managedServerPool.entries()]) {
    clearTimeout(row.lingerTimer);
    stopManagedOpenCodeServer(poolKey, row, "shutdown");
  }
}

function subscribeToRowExit(
  row: ManagedServerPoolRow,
  listener: (exit: OpenCodeServerProcessExit) => void
): () => void {
  if (row.exited) {
    // Deliver asynchronously so subscribers never re-enter their own setup.
    const exited = row.exited;
    queueMicrotask(() => listener(exited));
    return () => undefined;
  }
  row.exitListeners.add(listener);
  return () => {
    row.exitListeners.delete(listener);
  };
}

/**
 * Central detection (env override → PATH → `~/.opencode/bin` → common bins).
 * Falls back to the bare `opencode` name so the spawn error still names the
 * missing binary when nothing was detected.
 */
function resolveOpenCodeCommand(): string {
  return detectHarnessCli("opencode")?.executablePath ?? "opencode";
}

async function waitForHealth(client: OpenCodeServerClient): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const health = await client.health();
      if (health.healthy !== false) {
        return;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `OpenCode Server did not become healthy at ${client.baseUrl}.${
      lastError ? ` Last health error: ${lastError}` : ""
    }`
  );
}

function isOpenCodeStartupBanner(line: string): boolean {
  return (
    /OPENCODE_SERVER_PASSWORD is not set; server is unsecured/i.test(line) ||
    /^opencode server listening on /i.test(line)
  );
}

/**
 * First start on a machine can run database migrations, install plugin
 * dependencies and fetch the model catalog before the health route answers;
 * the old fixed 20s budget was tight for that. Startup failures no longer wait
 * for this budget - the process exiting fails the connect immediately.
 */
function managedServerStartupTimeoutMs(): number {
  const raw = Number.parseInt(process.env.OPENCURSOR_OPENCODE_STARTUP_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 1_000 ? raw : 60_000;
}

export async function connectOpenCodeServer(input: {
  workspaceRoot: string;
  onStderrLine?: (line: string) => void;
}): Promise<OpenCodeServerConnection> {
  const auth = openCodeServerAuthFromEnv();
  const externalUrl = process.env.OPENCURSOR_OPENCODE_SERVER_URL?.trim();
  if (externalUrl) {
    // Shared/external servers host many workspaces from one process, so the
    // client must pin every request to this workspace's directory: the server
    // cwd fallback would run the chat in the wrong directory.
    const client = new OpenCodeServerClient({
      baseUrl: externalUrl,
      directory: input.workspaceRoot,
      ...auth,
    });
    await waitForHealth(client);
    return {
      client,
      managed: false,
      onProcessExit: () => () => undefined,
      dispose: async () => undefined,
    };
  }

  const poolKey = `opencode-server:${input.workspaceRoot}`;
  const existing = managedServerPool.get(poolKey);
  if (existing && !existing.exited) {
    existing.refs += 1;
    clearTimeout(existing.lingerTimer);
    existing.lingerTimer = undefined;
    try {
      await existing.ready;
    } catch (error) {
      releaseManagedOpenCodeServer(poolKey, existing);
      throw error;
    }
    return {
      client: existing.client,
      managed: true,
      onProcessExit: (listener) => subscribeToRowExit(existing, listener),
      dispose: async () => {
        releaseManagedOpenCodeServer(poolKey, existing);
      },
    };
  }

  const port = await getOpenCodeAcpListenPort(poolKey);
  const baseUrl = openCodeAcpInternalBaseUrl(port);
  const command = resolveOpenCodeCommand();
  const invocation = buildCliInvocation(command, [
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ]);
  const directInvocation = invocation.command === command;
  const spawnedAt = Date.now();
  const child = spawn(
    invocation.command,
    invocation.args,
    {
      cwd: input.workspaceRoot,
      env: spawnSafeEnv({
        OPENCURSOR_PROCESS_NAME: `Cesium Agent - OpenCode Server :${port}`,
        // Per-generation database override: both OpenCode generations default to
        // the same ~/.local/share/opencode/opencode.db (see opencode-process-readiness).
        ...(process.env.OPENCURSOR_OPENCODE_DB?.trim()
          ? { OPENCODE_DB: process.env.OPENCURSOR_OPENCODE_DB.trim() }
          : {}),
      }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(directInvocation
        ? { argv0: `Cesium Agent - OpenCode Server :${port}` }
        : {}),
    }
  );
  harnessLog({
    backendId: "opencode-server",
    event: "process.spawn",
    detail: `Spawned OpenCode Server at ${baseUrl}`,
    data: { command, port, pid: child.pid ?? null, workspaceRoot: input.workspaceRoot },
  });
  const recentOutput = new RecentOutput();
  const reportOutput = (stream: "stdout" | "stderr") => (chunk: unknown) => {
    for (const trimmed of recentOutput.push(chunk)) {
      harnessLog({
        level: "debug",
        backendId: "opencode-server",
        event: `process.${stream}`,
        detail: trimmed,
      });
      // The startup banner is expected for a loopback server Cesium manages
      // itself; only forward genuine diagnostics into the conversation.
      if (stream === "stderr" && !isOpenCodeStartupBanner(trimmed)) {
        input.onStderrLine?.(trimmed);
      }
    }
  };
  child.stderr.on("data", reportOutput("stderr"));
  // `opencode serve` prints fatal startup errors ("Database is not empty and
  // has no session table", ...) on stdout, not stderr; keep them for the
  // readiness failure message.
  child.stdout?.on("data", reportOutput("stdout"));
  const client = new OpenCodeServerClient({
    baseUrl,
    directory: input.workspaceRoot,
    ...auth,
  });
  const row: ManagedServerPoolRow = {
    client,
    child,
    refs: 1,
    ready: waitForManagedServerReady({
      child,
      label: `OpenCode Server at ${baseUrl}`,
      probe: async () => (await client.health()).healthy !== false,
      timeoutMs: managedServerStartupTimeoutMs(),
      intervalMs: 250,
      recentOutput: () => recentOutput.snapshot(),
    }),
    exitListeners: new Set(),
    exited: null,
  };
  managedServerPool.set(poolKey, row);
  child.once("exit", (code, signal) => {
    const exit: OpenCodeServerProcessExit = { code, signal };
    row.exited = exit;
    const wasPooled = managedServerPool.get(poolKey) === row;
    if (wasPooled) {
      managedServerPool.delete(poolKey);
    }
    // `child.kill()` from an intentional dispose also lands here; listeners are
    // only interesting for sessions still attached (refs > 0 and pooled).
    const unexpected = wasPooled && row.refs > 0;
    harnessLog({
      level: unexpected ? "error" : "info",
      backendId: "opencode-server",
      event: unexpected ? "process.exit_unexpected" : "process.exit",
      detail: `OpenCode Server at ${baseUrl} exited (code ${code ?? "null"}, signal ${signal ?? "null"}) after ${Math.round((Date.now() - spawnedAt) / 1000)}s.`,
      data: { code, signal, attachedSessions: row.refs },
    });
    if (unexpected) {
      for (const listener of [...row.exitListeners]) {
        try {
          listener(exit);
        } catch {
          // Listener failures must not break other subscribers.
        }
      }
    }
    row.exitListeners.clear();
  });
  try {
    await row.ready;
    harnessLog({
      backendId: "opencode-server",
      event: "process.healthy",
      detail: `OpenCode Server at ${baseUrl} became healthy in ${Date.now() - spawnedAt}ms.`,
    });
  } catch (error) {
    managedServerPool.delete(poolKey);
    if (!child.killed) {
      child.kill();
    }
    harnessLog({
      level: "error",
      backendId: "opencode-server",
      event: "process.health_timeout",
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  return {
    client,
    managed: true,
    onProcessExit: (listener) => subscribeToRowExit(row, listener),
    dispose: async () => {
      releaseManagedOpenCodeServer(poolKey, row);
    },
  };
}

export function killOpenCodeServerChild(child: ChildProcess | null): void {
  if (child && !child.killed) {
    child.kill();
  }
}
