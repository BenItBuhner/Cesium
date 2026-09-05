import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DATA_DIR } from "../persistence.js";
import { getStorage } from "../../storage/runtime.js";
import type { WorkspaceRecord } from "../workspace-registry.js";
import type { ExtensionHostStatus, ExtensionInstallRecord } from "./types.js";
import {
  isHostChildEvent,
  type EditorCommandContext,
  type EditorContextSyncReason,
  type HostChildEvent,
  type HostNotify,
  type UiClientEvent,
  type UiResponsePayload,
} from "./host-protocol.js";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type HostMetrics = {
  rss?: number;
  heapUsed?: number;
  cpuUserMicros?: number;
  cpuSystemMicros?: number;
  sampledAt?: number;
};

type WorkspaceHost = {
  workspace: WorkspaceRecord;
  child: ChildProcessWithoutNullStreams;
  startedAt: number;
  retainedBy: Set<string>;
  activatedExtensionIds: Set<string>;
  pending: Map<string, PendingRequest>;
  stdoutBuffer: string;
  stdinQueue: string[];
  stdinBlocked: boolean;
  lastError?: string;
  crashCount: number;
  stoppingExpected?: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  metrics: HostMetrics;
  /** Extensions whose activation is currently in flight (crash blame). */
  activationsInFlight: Set<string>;
  startupActivationsDone?: boolean;
  lastEditorContext?: { context: EditorCommandContext | null; reason: EditorContextSyncReason };
};

type RestartState = {
  attempts: number;
  timer?: ReturnType<typeof setTimeout>;
  lastCrashAt: number;
};

const hosts = new Map<string, WorkspaceHost>();
const restartStates = new Map<string, RestartState>();

const HOST_IDLE_TIMEOUT_MS = 60_000;
const HOST_MAX_OLD_SPACE_MB = 512;
const HOST_CRASH_DISABLE_THRESHOLD = 5;
const EXTENSION_CRASH_DISABLE_THRESHOLD = 3;
const HOST_STABLE_RESET_MS = 5 * 60_000;
const HOST_RESTART_MAX_ATTEMPTS = 5;
const HOST_RESTART_BASE_DELAY_MS = 1_000;
const HOST_RESTART_MAX_DELAY_MS = 30_000;

const REQUEST_TIMEOUTS_MS: Record<string, number> = {
  activate: 60_000,
  executeCommand: 30_000,
  resolveWebviewView: 30_000,
  deliverWebviewMessage: 10_000,
  updateWebviewTheme: 5_000,
  getTreeChildren: 15_000,
  uiResponse: 5_000,
  uiEvent: 5_000,
  provideLanguageFeature: 10_000,
  dispose: 3_000,
};
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/* ------------------------------------------------------------------ */
/* Listener registries                                                 */
/* ------------------------------------------------------------------ */

type HostEventListener = (workspaceId: string, event: HostChildEvent) => void;
type HostLifecycleListener = {
  onRestarted?: (workspace: WorkspaceRecord) => void;
  onCrashed?: (workspaceId: string, error: string) => void;
};

const hostEventListeners = new Set<HostEventListener>();
const hostLifecycleListeners = new Set<HostLifecycleListener>();

export function onExtensionHostEvent(listener: HostEventListener): () => void {
  hostEventListeners.add(listener);
  return () => hostEventListeners.delete(listener);
}

export function onExtensionHostLifecycle(listener: HostLifecycleListener): () => void {
  hostLifecycleListeners.add(listener);
  return () => hostLifecycleListeners.delete(listener);
}

function dispatchHostEvent(workspaceId: string, event: HostChildEvent): void {
  for (const listener of hostEventListeners) {
    try {
      listener(workspaceId, event);
    } catch (error) {
      console.warn("[extensions] host event listener failed:", error);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Spawning                                                            */
/* ------------------------------------------------------------------ */

function serverPublicOrigin(): string {
  return (
    process.env.OPENCURSOR_SERVER_PUBLIC_ORIGIN?.trim() ||
    `http://localhost:${process.env.PORT ?? "9100"}`
  );
}

function resolveNodeExecutable(): string {
  const configured = process.env.OPENCURSOR_EXTENSION_HOST_NODE?.trim();
  if (configured) {
    return configured;
  }
  if (process.versions.bun) {
    return "node";
  }
  if (process.platform === "win32" && process.execPath.includes("fnm_multishells")) {
    const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
    for (const entry of pathEntries) {
      if (
        !entry ||
        entry.includes("fnm_multishells") ||
        entry.toLowerCase().includes(`${path.sep}cursor${path.sep}resources${path.sep}`)
      ) {
        continue;
      }
      const candidate = path.join(entry, "node.exe");
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return existsSync(process.execPath) ? process.execPath : "node";
}

function childScriptPath(): string {
  const current = fileURLToPath(import.meta.url);
  const filename = path.basename(current);
  return path.join(
    path.dirname(current),
    filename.endsWith(".ts") ? "extension-host-child.ts" : "extension-host-child.js"
  );
}

function childArgs(): string[] {
  const script = childScriptPath();
  const args = [`--max-old-space-size=${HOST_MAX_OLD_SPACE_MB}`];
  if (script.endsWith(".ts")) {
    const requireFromServer = createRequire(import.meta.url);
    args.push("--import", pathToFileURL(requireFromServer.resolve("tsx")).href);
  }
  args.push(script);
  return args;
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

function serializeHostStatus(host: WorkspaceHost | undefined, workspaceId: string): ExtensionHostStatus {
  if (!host) {
    return {
      workspaceId,
      running: false,
      retainedBy: [],
      activatedExtensionIds: [],
      crashCount: restartStates.get(workspaceId)?.attempts ?? 0,
    };
  }
  return {
    workspaceId,
    running: !host.child.killed,
    pid: host.child.pid,
    startedAt: host.startedAt,
    retainedBy: [...host.retainedBy],
    activatedExtensionIds: [...host.activatedExtensionIds],
    lastError: host.lastError,
    crashCount: host.crashCount,
    memoryRssBytes: host.metrics.rss,
    cpuUserMicros: host.metrics.cpuUserMicros,
    cpuSystemMicros: host.metrics.cpuSystemMicros,
  };
}

function scheduleIdleStop(host: WorkspaceHost): void {
  if (host.idleTimer) {
    clearTimeout(host.idleTimer);
  }
  if (host.retainedBy.size > 0) {
    return;
  }
  host.idleTimer = setTimeout(() => {
    const current = hosts.get(host.workspace.id);
    if (current && current.retainedBy.size === 0) {
      stopExtensionHost(host.workspace.id).catch(() => undefined);
    }
  }, HOST_IDLE_TIMEOUT_MS);
}

/* ------------------------------------------------------------------ */
/* stdin writing with backpressure                                     */
/* ------------------------------------------------------------------ */

function writeToChild(host: WorkspaceHost, line: string): void {
  if (host.child.killed || !host.child.stdin.writable) {
    return;
  }
  if (host.stdinBlocked) {
    host.stdinQueue.push(line);
    return;
  }
  const ok = host.child.stdin.write(line);
  if (!ok) {
    host.stdinBlocked = true;
    host.child.stdin.once("drain", () => {
      host.stdinBlocked = false;
      const queued = host.stdinQueue.splice(0, host.stdinQueue.length);
      for (const item of queued) {
        writeToChild(host, item);
      }
    });
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function handleChildEvent(host: WorkspaceHost, event: HostChildEvent): void {
  if (event.event === "metrics") {
    host.metrics = {
      rss: event.payload.rss,
      heapUsed: event.payload.heapUsed,
      cpuUserMicros: event.payload.cpuUserMicros,
      cpuSystemMicros: event.payload.cpuSystemMicros,
      sampledAt: Date.now(),
    };
    return;
  }
  if (event.event === "activation-started") {
    host.activationsInFlight.add(event.payload.extensionId);
  } else if (event.event === "activation-finished") {
    host.activationsInFlight.delete(event.payload.extensionId);
  }
  dispatchHostEvent(host.workspace.id, event);
}

function wireHost(host: WorkspaceHost): void {
  host.child.stdout.setEncoding("utf8");
  host.child.stdout.on("data", (chunk) => {
    host.stdoutBuffer += chunk;
    for (;;) {
      const index = host.stdoutBuffer.indexOf("\n");
      if (index < 0) return;
      const line = host.stdoutBuffer.slice(0, index).trim();
      host.stdoutBuffer = host.stdoutBuffer.slice(index + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (isHostChildEvent(message)) {
        handleChildEvent(host, message);
        continue;
      }
      const response = message as { id?: string; ok?: boolean; result?: unknown; error?: string };
      if (!response.id) continue;
      const pending = host.pending.get(response.id);
      if (!pending) continue;
      host.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.ok) {
        pending.resolve(response.result);
      } else {
        pending.reject(new Error(response.error || "Extension host request failed."));
      }
    }
  });
  host.child.stderr.setEncoding("utf8");
  host.child.stderr.on("data", (chunk) => {
    host.lastError = `${host.lastError ?? ""}${String(chunk)}`.slice(-8_000);
  });
  host.child.on("error", (error) => {
    host.lastError = `${host.lastError ?? ""}\n${error.message}`.slice(-8_000);
  });
  host.child.on("exit", (code, signal) => {
    if (host.idleTimer) {
      clearTimeout(host.idleTimer);
      host.idleTimer = undefined;
    }
    if (host.stoppingExpected) {
      void markWorkspaceExtensionsAfterGracefulStop(host).catch(() => undefined);
      for (const pending of host.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Extension host stopped."));
      }
      host.pending.clear();
      if (hosts.get(host.workspace.id) === host) {
        hosts.delete(host.workspace.id);
      }
      return;
    }
    const exitLabel = code ?? signal ?? "unknown";
    const stderr = host.lastError?.trim();
    const uptimeMs = Date.now() - host.startedAt;
    const wasStable = uptimeMs > HOST_STABLE_RESET_MS;
    host.lastError = stderr
      ? `Extension host exited (${exitLabel}): ${stderr}`
      : `Extension host exited (${exitLabel}).`;
    host.crashCount = wasStable ? 1 : host.crashCount + 1;
    const blamed = [...host.activationsInFlight];
    void markWorkspaceExtensionsAfterHostCrash(host, host.lastError, blamed).catch(() => undefined);
    for (const pending of host.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(host.lastError));
    }
    host.pending.clear();
    if (hosts.get(host.workspace.id) === host) {
      hosts.delete(host.workspace.id);
    }
    for (const listener of hostLifecycleListeners) {
      try {
        listener.onCrashed?.(host.workspace.id, host.lastError);
      } catch {
        /* listener errors must not break exit handling */
      }
    }
    maybeScheduleRestart(host);
  });
}

/* ------------------------------------------------------------------ */
/* Crash handling + auto-restart                                       */
/* ------------------------------------------------------------------ */

async function markWorkspaceExtensionsAfterGracefulStop(host: WorkspaceHost): Promise<void> {
  const storage = await getStorage();
  const records = await storage.listInstalledExtensions(host.workspace.id);
  const now = Date.now();
  await Promise.all(
    records.map((record) =>
      storage.upsertInstalledExtension({
        ...record,
        runtime: {
          ...record.runtime,
          hostRunning: false,
          activated: false,
        },
        updatedAt: now,
      })
    )
  );
}

async function markWorkspaceExtensionsAfterHostCrash(
  host: WorkspaceHost,
  error: string,
  blamedExtensionIds: string[]
): Promise<void> {
  const storage = await getStorage();
  const records = await storage.listInstalledExtensions(host.workspace.id);
  const now = Date.now();
  const blamed = new Set(blamedExtensionIds.map((id) => id.toLowerCase()));
  await Promise.all(
    records.map((record) => {
      const isBlamed = blamed.has(record.extensionId);
      // When a specific extension was activating during the crash it takes the
      // blame alone; otherwise the whole host shares a (higher) crash budget.
      const crashCount = isBlamed
        ? record.runtime.crashCount + 1
        : blamed.size > 0
          ? record.runtime.crashCount
          : Math.max(record.runtime.crashCount, host.crashCount);
      const disable = isBlamed
        ? crashCount >= EXTENSION_CRASH_DISABLE_THRESHOLD
        : blamed.size === 0 && crashCount >= HOST_CRASH_DISABLE_THRESHOLD;
      return storage.upsertInstalledExtension({
        ...record,
        enabled: disable ? false : record.enabled,
        runtime: {
          ...record.runtime,
          hostRunning: false,
          activated: false,
          lastError: isBlamed || blamed.size === 0 ? error : record.runtime.lastError,
          crashCount,
          disabledForCrashLoop: disable || record.runtime.disabledForCrashLoop,
        },
        updatedAt: now,
      });
    })
  );
}

function maybeScheduleRestart(host: WorkspaceHost): void {
  if (host.retainedBy.size === 0) {
    restartStates.delete(host.workspace.id);
    return;
  }
  const state = restartStates.get(host.workspace.id) ?? { attempts: 0, lastCrashAt: 0 };
  // A long stable run earns a fresh restart budget.
  if (state.lastCrashAt && Date.now() - state.lastCrashAt > HOST_STABLE_RESET_MS) {
    state.attempts = 0;
  }
  state.lastCrashAt = Date.now();
  if (state.attempts >= HOST_RESTART_MAX_ATTEMPTS) {
    restartStates.set(host.workspace.id, state);
    console.warn(
      `[extensions] host for workspace ${host.workspace.id} crashed ${state.attempts} times; waiting for manual restart.`
    );
    return;
  }
  const delay = Math.min(
    HOST_RESTART_BASE_DELAY_MS * 2 ** state.attempts,
    HOST_RESTART_MAX_DELAY_MS
  );
  state.attempts += 1;
  restartStates.set(host.workspace.id, state);
  const retainedBy = [...host.retainedBy];
  const activatedExtensionIds = [...host.activatedExtensionIds];
  const lastEditorContext = host.lastEditorContext;
  state.timer = setTimeout(() => {
    void (async () => {
      if (hosts.has(host.workspace.id)) {
        return;
      }
      try {
        const revived = await ensureHost(host.workspace);
        for (const retainId of retainedBy) {
          revived.retainedBy.add(retainId);
        }
        revived.lastEditorContext = lastEditorContext;
        if (lastEditorContext) {
          sendHostNotify(revived, {
            notify: "editorContext",
            params: lastEditorContext,
          });
        }
        for (const extensionId of activatedExtensionIds) {
          try {
            await activateExtension({ workspace: host.workspace, extensionId });
          } catch (error) {
            console.warn(
              `[extensions] failed to re-activate ${extensionId} after host restart:`,
              error instanceof Error ? error.message : error
            );
          }
        }
        for (const listener of hostLifecycleListeners) {
          try {
            listener.onRestarted?.(host.workspace);
          } catch {
            /* listener errors are non-fatal */
          }
        }
      } catch (error) {
        console.warn(
          `[extensions] host restart failed for workspace ${host.workspace.id}:`,
          error instanceof Error ? error.message : error
        );
      }
    })();
  }, delay);
}

/* ------------------------------------------------------------------ */
/* Host lifecycle                                                      */
/* ------------------------------------------------------------------ */

async function ensureHost(workspace: WorkspaceRecord): Promise<WorkspaceHost> {
  const existing = hosts.get(workspace.id);
  if (existing && !existing.child.killed) {
    return existing;
  }
  const child = spawn(resolveNodeExecutable(), childArgs(), {
    cwd: workspace.root,
    env: {
      ...process.env,
      OPENCURSOR_PROCESS_NAME: "extension-host",
      OPENCURSOR_EXTENSION_HOST: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const host: WorkspaceHost = {
    workspace,
    child,
    startedAt: Date.now(),
    retainedBy: new Set(),
    activatedExtensionIds: new Set(),
    pending: new Map(),
    stdoutBuffer: "",
    stdinQueue: [],
    stdinBlocked: false,
    crashCount: existing?.crashCount ?? 0,
    metrics: {},
    activationsInFlight: new Set(),
    lastEditorContext: existing?.lastEditorContext,
  };
  hosts.set(workspace.id, host);
  wireHost(host);
  if (host.lastEditorContext) {
    sendHostNotify(host, { notify: "editorContext", params: host.lastEditorContext });
  }
  void activateStartupExtensions(host).catch(() => undefined);
  return host;
}

async function activateStartupExtensions(host: WorkspaceHost): Promise<void> {
  if (host.startupActivationsDone) return;
  host.startupActivationsDone = true;
  const storage = await getStorage();
  const records = await storage.listInstalledExtensions(host.workspace.id);
  for (const record of records) {
    if (!record.enabled || record.runtime.disabledForCrashLoop) continue;
    const events = record.manifest.activationEvents ?? [];
    const wantsStartup = events.includes("*") || events.includes("onStartupFinished");
    if (!wantsStartup) continue;
    const trusted = record.permissions.some(
      (grant) => grant.permission === "workspace.trust" && grant.granted
    );
    if (record.manifest.main && !trusted) continue;
    try {
      await activateExtension({ workspace: host.workspace, extensionId: record.extensionId });
    } catch (error) {
      console.warn(
        `[extensions] startup activation failed for ${record.extensionId}:`,
        error instanceof Error ? error.message : error
      );
    }
  }
}

async function sendHostRequest(
  host: WorkspaceHost,
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  const id = randomUUID();
  const payload = JSON.stringify({ id, method, params: params ?? {} });
  const timeoutMs = REQUEST_TIMEOUTS_MS[method] ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      host.pending.delete(id);
      reject(new Error(`Extension host request '${method}' timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    host.pending.set(id, {
      resolve,
      reject,
      timer,
    });
    try {
      writeToChild(host, `${payload}\n`);
    } catch (error) {
      clearTimeout(timer);
      host.pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function sendHostNotify(host: WorkspaceHost, notify: HostNotify): void {
  try {
    writeToChild(host, `${JSON.stringify(notify)}\n`);
  } catch {
    /* notifies are best-effort */
  }
}

export async function retainExtensionHost(
  workspace: WorkspaceRecord,
  retainId: string
): Promise<ExtensionHostStatus> {
  const host = await ensureHost(workspace);
  host.retainedBy.add(retainId);
  if (host.idleTimer) {
    clearTimeout(host.idleTimer);
    host.idleTimer = undefined;
  }
  return serializeHostStatus(host, workspace.id);
}

export async function releaseExtensionHost(
  workspaceId: string,
  retainId: string
): Promise<ExtensionHostStatus> {
  const host = hosts.get(workspaceId);
  if (!host) {
    return serializeHostStatus(undefined, workspaceId);
  }
  host.retainedBy.delete(retainId);
  scheduleIdleStop(host);
  return serializeHostStatus(host, workspaceId);
}

export function getExtensionHostStatus(workspaceId: string): ExtensionHostStatus {
  return serializeHostStatus(hosts.get(workspaceId), workspaceId);
}

export async function stopExtensionHost(workspaceId: string): Promise<ExtensionHostStatus> {
  const restart = restartStates.get(workspaceId);
  if (restart?.timer) {
    clearTimeout(restart.timer);
  }
  restartStates.delete(workspaceId);
  const host = hosts.get(workspaceId);
  if (!host) {
    return serializeHostStatus(undefined, workspaceId);
  }
  host.stoppingExpected = true;
  try {
    await sendHostRequest(host, "dispose");
  } catch {
    host.child.kill();
  }
  hosts.delete(workspaceId);
  return serializeHostStatus(undefined, workspaceId);
}

/** Clears the crash-loop restart budget (user asked for a manual restart). */
export function resetExtensionHostRestartBudget(workspaceId: string): void {
  restartStates.delete(workspaceId);
}

/* ------------------------------------------------------------------ */
/* Editor context + config + theme sync                                */
/* ------------------------------------------------------------------ */

export function updateHostEditorContext(input: {
  workspaceId: string;
  context: EditorCommandContext | null;
  reason: EditorContextSyncReason;
}): boolean {
  const host = hosts.get(input.workspaceId);
  if (!host || host.child.killed) {
    return false;
  }
  host.lastEditorContext = { context: input.context, reason: input.reason };
  sendHostNotify(host, {
    notify: "editorContext",
    params: { context: input.context, reason: input.reason },
  });
  return true;
}

export function notifyHostConfigChanged(input: {
  workspaceId: string;
  extensionId: string;
  settings: Record<string, unknown>;
}): void {
  const host = hosts.get(input.workspaceId);
  if (!host || host.child.killed) return;
  sendHostNotify(host, {
    notify: "configChanged",
    params: { extensionId: input.extensionId, settings: input.settings },
  });
}

/* ------------------------------------------------------------------ */
/* High-level operations                                               */
/* ------------------------------------------------------------------ */

export async function activateExtension(input: {
  workspace: WorkspaceRecord;
  extensionId: string;
}): Promise<{ status: ExtensionHostStatus; result: unknown; record: ExtensionInstallRecord }> {
  const storage = await getStorage();
  const record = await storage.getInstalledExtension(
    input.workspace.id,
    input.extensionId.toLowerCase()
  );
  if (!record) {
    throw new Error(`Unknown extension: ${input.extensionId}`);
  }
  if (!record.enabled) {
    throw new Error(`Extension is disabled: ${input.extensionId}`);
  }
  if (record.runtime.disabledForCrashLoop) {
    throw new Error(`Extension is disabled after repeated host crashes: ${input.extensionId}`);
  }
  const trustGrant = record.permissions.find(
    (grant) => grant.permission === "workspace.trust" && grant.granted
  );
  if (record.manifest.main && !trustGrant) {
    throw new Error("Workspace trust must be granted before activating Node extension code.");
  }
  const host = await ensureHost(input.workspace);
  if (host.activatedExtensionIds.has(record.extensionId)) {
    return {
      status: serializeHostStatus(host, input.workspace.id),
      result: { activated: true, cached: true },
      record,
    };
  }
  host.retainedBy.add(`activation:${record.extensionId}`);
  const extensionStorageRoot = path.join(
    DATA_DIR,
    "extensions",
    "state",
    input.workspace.id,
    record.extensionId
  );
  await fs.mkdir(extensionStorageRoot, { recursive: true });
  let result: unknown;
  try {
    result = await sendHostRequest(host, "activate", {
      extensionId: record.extensionId,
      installPath: record.installPath,
      main: record.manifest.main,
      settings: record.settings,
      workspaceRoot: input.workspace.root,
      context: {
        extensionId: record.extensionId,
        extensionPath: path.join(record.installPath, "extension"),
        storagePath: path.join(extensionStorageRoot, "workspace"),
        globalStoragePath: path.join(DATA_DIR, "extensions", "global-state", record.extensionId),
        logPath: path.join(extensionStorageRoot, "logs"),
        resourceBaseUrl: `${serverPublicOrigin()}/api/workspaces/${encodeURIComponent(input.workspace.id)}/extensions/${encodeURIComponent(record.extensionId)}/resource`,
      },
    });
  } finally {
    host.retainedBy.delete(`activation:${record.extensionId}`);
    scheduleIdleStop(host);
  }
  host.activatedExtensionIds.add(record.extensionId);
  const updated: ExtensionInstallRecord = {
    ...record,
    runtime: {
      ...record.runtime,
      hostRunning: true,
      activated: true,
      activationEvents: record.manifest.activationEvents,
      lastActivatedAt: Date.now(),
      lastError: undefined,
      crashCount: record.runtime.crashCount,
    },
    updatedAt: Date.now(),
  };
  await storage.upsertInstalledExtension(updated);
  return {
    status: serializeHostStatus(host, input.workspace.id),
    result,
    record: updated,
  };
}

function recordContributesCommand(record: ExtensionInstallRecord, command: string): boolean {
  const raw = record.manifest.raw;
  if (!raw || typeof raw !== "object" || !("contributes" in raw)) {
    return false;
  }
  const contributes = (raw as { contributes?: unknown }).contributes;
  if (!contributes || typeof contributes !== "object" || !("commands" in contributes)) {
    return false;
  }
  const commands = (contributes as { commands?: unknown }).commands;
  return (
    Array.isArray(commands) &&
    commands.some(
      (item) =>
        item && typeof item === "object" && (item as { command?: unknown }).command === command
    )
  );
}

export async function executeExtensionCommand(input: {
  workspace: WorkspaceRecord;
  command: string;
  args?: unknown[];
  editorContext?: unknown;
  treeItem?: { viewId: string; handle: string };
}): Promise<{ status: ExtensionHostStatus; result: unknown; externalUrls: string[] }> {
  let host = await ensureHost(input.workspace);
  const storage = await getStorage();
  const records = await storage.listInstalledExtensions(input.workspace.id);
  const owner = records.find(
    (record) => record.enabled && recordContributesCommand(record, input.command)
  );
  if (owner && !host.activatedExtensionIds.has(owner.extensionId)) {
    await activateExtension({ workspace: input.workspace, extensionId: owner.extensionId });
    host = await ensureHost(input.workspace);
  }
  const rawResult = (await sendHostRequest(host, "executeCommand", {
    command: input.command,
    args: input.args ?? [],
    editorContext: input.editorContext,
    treeItem: input.treeItem,
  })) as { commandResult?: unknown; externalUrls?: unknown };
  scheduleIdleStop(host);
  return {
    status: serializeHostStatus(host, input.workspace.id),
    result:
      rawResult && typeof rawResult === "object" && "commandResult" in rawResult
        ? rawResult.commandResult
        : rawResult,
    externalUrls: Array.isArray(rawResult?.externalUrls)
      ? rawResult.externalUrls.filter((url): url is string => typeof url === "string")
      : [],
  };
}

export async function resolveExtensionSurface(input: {
  workspace: WorkspaceRecord;
  extensionId: string;
  surfaceId: string;
  title?: string;
  surfaceSessionId?: string;
  webviewState?: unknown;
  theme?: unknown;
  kind?: string;
}): Promise<{
  status: ExtensionHostStatus;
  html: string;
  messages: unknown[];
  externalUrls: string[];
  missingProvider: boolean;
  treeView: boolean;
  treeItems: unknown[];
  message?: string;
}> {
  await activateExtension({ workspace: input.workspace, extensionId: input.extensionId });
  const host = await ensureHost(input.workspace);
  const result = (await sendHostRequest(host, "resolveWebviewView", {
    extensionId: input.extensionId.toLowerCase(),
    surfaceId: input.surfaceId,
    surfaceSessionId: input.surfaceSessionId,
    title: input.title,
    state: input.webviewState,
    theme: input.theme,
    kind: input.kind,
  })) as {
    html?: unknown;
    messages?: unknown;
    externalUrls?: unknown;
    missingProvider?: unknown;
    treeView?: unknown;
    treeItems?: unknown;
    message?: unknown;
  };
  scheduleIdleStop(host);
  return {
    status: serializeHostStatus(host, input.workspace.id),
    html: typeof result.html === "string" ? result.html : "",
    messages: Array.isArray(result.messages) ? result.messages : [],
    externalUrls: Array.isArray(result.externalUrls)
      ? result.externalUrls.filter((url): url is string => typeof url === "string")
      : [],
    missingProvider: result.missingProvider === true,
    treeView: result.treeView === true,
    treeItems: Array.isArray(result.treeItems) ? result.treeItems : [],
    message: typeof result.message === "string" ? result.message : undefined,
  };
}

export async function deliverExtensionSurfaceMessage(input: {
  workspace: WorkspaceRecord;
  extensionId: string;
  surfaceId: string;
  surfaceSessionId?: string;
  message: unknown;
}): Promise<{
  status: ExtensionHostStatus;
  messages: unknown[];
  externalUrls: string[];
  missingWebview: boolean;
}> {
  const host = await ensureHost(input.workspace);
  const result = (await sendHostRequest(host, "deliverWebviewMessage", {
    extensionId: input.extensionId.toLowerCase(),
    surfaceId: input.surfaceId,
    surfaceSessionId: input.surfaceSessionId,
    message: input.message,
  })) as { messages?: unknown; externalUrls?: unknown; missingWebview?: unknown };
  scheduleIdleStop(host);
  return {
    status: serializeHostStatus(host, input.workspace.id),
    messages: Array.isArray(result.messages) ? result.messages : [],
    externalUrls: Array.isArray(result.externalUrls)
      ? result.externalUrls.filter((url): url is string => typeof url === "string")
      : [],
    missingWebview: result.missingWebview === true,
  };
}

export async function updateExtensionSurfaceThemeInHost(input: {
  workspace: WorkspaceRecord;
  extensionId: string;
  surfaceId: string;
  surfaceSessionId?: string;
  theme: unknown;
}): Promise<{
  status: ExtensionHostStatus;
  messages: unknown[];
  externalUrls: string[];
  missingWebview: boolean;
}> {
  const host = hosts.get(input.workspace.id);
  if (!host || host.child.killed) {
    return {
      status: serializeHostStatus(undefined, input.workspace.id),
      messages: [],
      externalUrls: [],
      missingWebview: true,
    };
  }
  sendHostNotify(host, { notify: "themeChanged", params: { theme: input.theme } });
  return {
    status: serializeHostStatus(host, input.workspace.id),
    messages: [],
    externalUrls: [],
    missingWebview: false,
  };
}

export async function getExtensionTreeChildren(input: {
  workspace: WorkspaceRecord;
  extensionId: string;
  viewId: string;
  parentHandle?: string;
}): Promise<{ items: unknown[]; missingProvider: boolean }> {
  await activateExtension({ workspace: input.workspace, extensionId: input.extensionId });
  const host = await ensureHost(input.workspace);
  const result = (await sendHostRequest(host, "getTreeChildren", {
    extensionId: input.extensionId.toLowerCase(),
    viewId: input.viewId,
    parentHandle: input.parentHandle,
  })) as { items?: unknown; missingProvider?: unknown };
  scheduleIdleStop(host);
  return {
    items: Array.isArray(result.items) ? result.items : [],
    missingProvider: result.missingProvider === true,
  };
}

export async function sendUiResponseToHost(input: {
  workspaceId: string;
  response: UiResponsePayload;
}): Promise<boolean> {
  const host = hosts.get(input.workspaceId);
  if (!host || host.child.killed) return false;
  const result = (await sendHostRequest(host, "uiResponse", input.response)) as {
    delivered?: unknown;
  };
  return result.delivered === true;
}

export async function sendUiEventToHost(input: {
  workspaceId: string;
  event: UiClientEvent;
}): Promise<boolean> {
  const host = hosts.get(input.workspaceId);
  if (!host || host.child.killed) return false;
  const result = (await sendHostRequest(host, "uiEvent", input.event)) as { delivered?: unknown };
  return result.delivered === true;
}

export async function provideExtensionLanguageFeature(input: {
  workspace: WorkspaceRecord;
  kind: "hover" | "completion" | "definition" | "formatting";
  uri: string;
  languageId: string;
  content?: string;
  position?: { line: number; character: number };
  formattingOptions?: { tabSize?: number; insertSpaces?: boolean };
  triggerCharacter?: string;
}): Promise<unknown> {
  const host = hosts.get(input.workspace.id);
  if (!host || host.child.killed) return null;
  return await sendHostRequest(host, "provideLanguageFeature", {
    kind: input.kind,
    uri: input.uri,
    languageId: input.languageId,
    content: input.content,
    position: input.position,
    formattingOptions: input.formattingOptions,
    triggerCharacter: input.triggerCharacter,
  });
}
