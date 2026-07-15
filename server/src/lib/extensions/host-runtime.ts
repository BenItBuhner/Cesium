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

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type WorkspaceHost = {
  workspace: WorkspaceRecord;
  child: ChildProcessWithoutNullStreams;
  startedAt: number;
  retainedBy: Set<string>;
  activatedExtensionIds: Set<string>;
  pending: Map<string, PendingRequest>;
  stdoutBuffer: string;
  lastError?: string;
  crashCount: number;
  stoppingExpected?: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
};

const hosts = new Map<string, WorkspaceHost>();
const HOST_REQUEST_TIMEOUT_MS = 15_000;
const HOST_IDLE_TIMEOUT_MS = 60_000;
const HOST_MAX_OLD_SPACE_MB = 256;

function serverPublicOrigin(): string {
  return process.env.OPENCURSOR_SERVER_PUBLIC_ORIGIN?.trim() || `http://localhost:${process.env.PORT ?? "9100"}`;
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
  return path.join(path.dirname(current), filename.endsWith(".ts") ? "extension-host-child.ts" : "extension-host-child.js");
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

function serializeHostStatus(host: WorkspaceHost | undefined, workspaceId: string): ExtensionHostStatus {
  if (!host) {
    return {
      workspaceId,
      running: false,
      retainedBy: [],
      activatedExtensionIds: [],
      crashCount: 0,
    };
  }
  const usage = host.child.pid ? process.memoryUsage() : undefined;
  const cpu = process.cpuUsage();
  return {
    workspaceId,
    running: !host.child.killed,
    pid: host.child.pid,
    startedAt: host.startedAt,
    retainedBy: [...host.retainedBy],
    activatedExtensionIds: [...host.activatedExtensionIds],
    lastError: host.lastError,
    crashCount: host.crashCount,
    memoryRssBytes: usage?.rss,
    cpuUserMicros: cpu.user,
    cpuSystemMicros: cpu.system,
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
      let message: { id?: string; ok?: boolean; result?: unknown; error?: string };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        continue;
      }
      if (!message.id) continue;
      const pending = host.pending.get(message.id);
      if (!pending) continue;
      host.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error || "Extension host request failed."));
      }
    }
  });
  host.child.stderr.setEncoding("utf8");
  host.child.stderr.on("data", (chunk) => {
    host.lastError = `${host.lastError ?? ""}${String(chunk)}`.slice(-8_000);
  });
  host.child.on("exit", (code, signal) => {
    if (host.stoppingExpected) {
      void markWorkspaceExtensionsAfterGracefulStop(host).catch(() => undefined);
      for (const pending of host.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Extension host stopped."));
      }
      host.pending.clear();
      hosts.delete(host.workspace.id);
      return;
    }
    const exitLabel = code ?? signal ?? "unknown";
    const stderr = host.lastError?.trim();
    host.lastError = stderr
      ? `Extension host exited (${exitLabel}): ${stderr}`
      : `Extension host exited (${exitLabel}).`;
    host.crashCount += 1;
    void markWorkspaceExtensionsAfterHostExit(host, host.lastError).catch(() => undefined);
    for (const pending of host.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(host.lastError));
    }
    host.pending.clear();
    hosts.delete(host.workspace.id);
  });
}

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

async function markWorkspaceExtensionsAfterHostExit(
  host: WorkspaceHost,
  error: string
): Promise<void> {
  const storage = await getStorage();
  const records = await storage.listInstalledExtensions(host.workspace.id);
  const now = Date.now();
  await Promise.all(
    records.map((record) => {
      const crashCount = Math.max(record.runtime.crashCount, host.crashCount);
      return storage.upsertInstalledExtension({
        ...record,
        enabled: crashCount >= 3 ? false : record.enabled,
        runtime: {
          ...record.runtime,
          hostRunning: false,
          activated: false,
          lastError: error,
          crashCount,
          disabledForCrashLoop: crashCount >= 3,
        },
        updatedAt: now,
      });
    })
  );
}

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
    crashCount: existing?.crashCount ?? 0,
  };
  hosts.set(workspace.id, host);
  wireHost(host);
  return host;
}

async function sendHostRequest(
  host: WorkspaceHost,
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  const id = randomUUID();
  const payload = JSON.stringify({ id, method, params: params ?? {} });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      host.pending.delete(id);
      reject(new Error(`Extension host request '${method}' timed out.`));
    }, HOST_REQUEST_TIMEOUT_MS);
    host.pending.set(id, {
      resolve,
      reject,
      timer,
    });
    host.child.stdin.write(`${payload}\n`, (error) => {
      if (!error) return;
      clearTimeout(timer);
      host.pending.delete(id);
      reject(error);
    });
  });
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
      crashCount: host.crashCount,
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
        item &&
        typeof item === "object" &&
        (item as { command?: unknown }).command === command
    )
  );
}

export async function executeExtensionCommand(input: {
  workspace: WorkspaceRecord;
  command: string;
  args?: unknown[];
  editorContext?: unknown;
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
  const rawResult = await sendHostRequest(host, "executeCommand", {
    command: input.command,
    args: input.args ?? [],
    editorContext: input.editorContext,
  }) as { commandResult?: unknown; externalUrls?: unknown };
  scheduleIdleStop(host);
  return {
    status: serializeHostStatus(host, input.workspace.id),
    result: rawResult && typeof rawResult === "object" && "commandResult" in rawResult
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
}): Promise<{
  status: ExtensionHostStatus;
  html: string;
  messages: unknown[];
  externalUrls: string[];
  missingProvider: boolean;
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
  })) as {
    html?: unknown;
    messages?: unknown;
    externalUrls?: unknown;
    missingProvider?: unknown;
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
  const host = await ensureHost(input.workspace);
  const result = (await sendHostRequest(host, "updateWebviewTheme", {
    extensionId: input.extensionId.toLowerCase(),
    surfaceId: input.surfaceId,
    surfaceSessionId: input.surfaceSessionId,
    theme: input.theme,
  })) as { messages?: unknown; externalUrls?: unknown; missingWebview?: unknown };
  return {
    status: serializeHostStatus(host, input.workspace.id),
    messages: Array.isArray(result.messages) ? result.messages : [],
    externalUrls: Array.isArray(result.externalUrls)
      ? result.externalUrls.filter((url): url is string => typeof url === "string")
      : [],
    missingWebview: result.missingWebview === true,
  };
}
