"use client";

import { getServerConnectionKey } from "@cesium/client";
import type { CloudCodespaceMeta, CloudServer } from "@/contexts/CloudContext";

/**
 * GitHub Codespaces as Cesium devices - client-side model and orchestration.
 *
 * A codespace device is a normal remote engine whose lifetime is managed
 * through GitHub: the durable identity is the (user, repository) pairing
 * stored on the Convex `servers` row, while the codespace itself is
 * disposable. Everything here is pure or dependency-injected so the wake
 * state machine is unit-testable without GitHub or an engine.
 */

export type GithubRepoInfo = {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string | null;
  description: string | null;
};

export type GithubMachineInfo = {
  name: string;
  displayName: string;
  cpus: number;
  memoryInBytes: number;
  storageInBytes: number;
  prebuildAvailability: string | null;
};

export type GithubCodespaceInfo = {
  name: string;
  displayName: string | null;
  state: string;
  repositoryFullName: string | null;
  machine: string | null;
  gitRef: string | null;
  lastUsedAt: string | null;
  webUrl: string | null;
  idleTimeoutMinutes: number | null;
  retentionExpiresAt: string | null;
};

export type CodespaceEngineAuth = { username: string; password: string };

export type CodespaceDevice = {
  /** Stable UI identity for the pairing (repo-keyed, survives recreation). */
  key: string;
  repoFullName: string;
  repositoryId: number;
  codespaceName: string;
  label: string;
  baseUrl: string;
  lastKnownState: string | null;
  machine: string | null;
  devcontainerPath: string;
  engineAuth: CodespaceEngineAuth | null;
  /** Matching local ServerConnection id once cloud merge ran, else null. */
  localServerId: string | null;
};

export function codespaceDeviceKey(repoFullName: string): string {
  return `codespace:${repoFullName}`;
}

/**
 * Where GitHub checks the repository out inside its codespace. Codespaces
 * always clone to `/workspaces/<repo-name>` (the name half of `owner/repo`,
 * case preserved), and the Cesium bootstrap points the engine's workspace
 * root at `/workspaces`, so this is the folder to register as the device's
 * workspace.
 */
export function codespaceRepoWorkspaceRoot(repoFullName: string): string {
  const repo = repoFullName.split("/").pop()?.trim() || repoFullName.trim();
  return `/workspaces/${repo}`;
}

export function codespaceRepoWorkspaceName(repoFullName: string): string {
  return repoFullName.split("/").pop()?.trim() || repoFullName.trim();
}

/** Label for the device pill / rail when the active server is a codespace. */
export const CODESPACE_DEVICE_LABEL = "GitHub Codespace";

export function deriveCodespaceDevices(
  cloudServers: CloudServer[],
  localServers: Array<{ id: string; baseUrl: string }>
): CodespaceDevice[] {
  const localByKey = new Map<string, string>();
  for (const server of localServers) {
    try {
      localByKey.set(getServerConnectionKey(server.baseUrl), server.id);
    } catch {
      continue;
    }
  }
  const devices: CodespaceDevice[] = [];
  for (const server of cloudServers) {
    const meta = server.codespace;
    if (server.kind !== "codespace" || !meta) {
      continue;
    }
    let localServerId: string | null = null;
    try {
      localServerId = localByKey.get(getServerConnectionKey(server.baseUrl)) ?? null;
    } catch {
      localServerId = null;
    }
    devices.push({
      key: codespaceDeviceKey(meta.repoFullName),
      repoFullName: meta.repoFullName,
      repositoryId: meta.repositoryId,
      codespaceName: meta.codespaceName,
      label: server.name || meta.repoFullName,
      baseUrl: server.baseUrl,
      lastKnownState: meta.lastKnownState ?? null,
      machine: meta.machine ?? null,
      devcontainerPath: meta.devcontainerPath,
      engineAuth:
        meta.engineUsername && meta.enginePassword
          ? { username: meta.engineUsername, password: meta.enginePassword }
          : null,
      localServerId,
    });
  }
  return devices.sort((a, b) => a.repoFullName.localeCompare(b.repoFullName));
}

/** Base URL keys of codespace devices (to dedupe them out of plain lists). */
export function codespaceBaseUrlKeys(devices: CodespaceDevice[]): Set<string> {
  const keys = new Set<string>();
  for (const device of devices) {
    try {
      keys.add(getServerConnectionKey(device.baseUrl));
    } catch {
      continue;
    }
  }
  return keys;
}

/* ------------------------------ state labels ----------------------------- */

const RUNNING_STATES = new Set(["available"]);
const STOPPED_STATES = new Set(["shutdown", "archived", "stopped"]);
const TRANSITIONAL_STATES = new Set([
  "queued",
  "provisioning",
  "starting",
  "awaiting",
  "rebuilding",
  "created",
  "shuttingdown",
  "exporting",
]);
const GONE_STATES = new Set(["deleted", "moved"]);

export type CodespaceStateCategory =
  | "running"
  | "stopped"
  | "transitional"
  | "gone"
  | "failed"
  | "unknown";

export function categorizeCodespaceState(
  state: string | null | undefined
): CodespaceStateCategory {
  const normalized = (state ?? "").trim().toLowerCase();
  if (!normalized) return "unknown";
  if (RUNNING_STATES.has(normalized)) return "running";
  if (STOPPED_STATES.has(normalized)) return "stopped";
  if (TRANSITIONAL_STATES.has(normalized)) return "transitional";
  if (GONE_STATES.has(normalized)) return "gone";
  if (normalized === "failed" || normalized === "unavailable") return "failed";
  return "unknown";
}

export function codespaceStateLabel(state: string | null | undefined): string {
  switch (categorizeCodespaceState(state)) {
    case "running":
      return "Running";
    case "stopped":
      return "Stopped";
    case "transitional":
      return "Starting…";
    case "gone":
      return "Deleted";
    case "failed":
      return "Failed";
    default:
      return "Unknown";
  }
}

/* ------------------------------ engine creds ------------------------------ */

export function generateEngineCredentials(): CodespaceEngineAuth {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const password = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return { username: "cesium", password };
}

/** Reuse one credential pair per account: Codespaces user secrets are global. */
export function pickExistingEngineAuth(
  devices: Array<{ engineAuth: CodespaceEngineAuth | null }>
): CodespaceEngineAuth | null {
  for (const device of devices) {
    if (device.engineAuth) {
      return device.engineAuth;
    }
  }
  return null;
}

/* ------------------------------- wake flow -------------------------------- */

export type CodespaceWakePhase =
  | "checking-engine"
  | "checking-codespace"
  | "starting-codespace"
  | "waiting-engine"
  | "signing-in"
  | "ready";

export type CodespaceWakeResult =
  | { ok: true }
  | {
      ok: false;
      reason: "deleted" | "failed" | "timeout" | "error";
      message: string;
    };

export type CodespaceWakeDeps = {
  checkEngineHealthy(baseUrl: string): Promise<boolean>;
  getCodespace(codespaceName: string): Promise<GithubCodespaceInfo | null>;
  startCodespace(codespaceName: string): Promise<GithubCodespaceInfo>;
  /** Mint/refresh the engine session when auth is enabled and we hold creds. */
  ensureEngineSession(
    baseUrl: string,
    auth: CodespaceEngineAuth | null
  ): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
};

export type CodespaceWakeTimeouts = {
  codespaceAvailableMs: number;
  engineHealthyMs: number;
  pollIntervalMs: number;
};

export const DEFAULT_WAKE_TIMEOUTS: CodespaceWakeTimeouts = {
  // Cold resume: container start + engine supervisor boot.
  codespaceAvailableMs: 5 * 60_000,
  // postStart reinstall paths can be slow on first boot after rebuild.
  engineHealthyMs: 10 * 60_000,
  pollIntervalMs: 4_000,
};

/**
 * Bring a paired codespace engine online:
 * healthy engine -> session; stopped codespace -> start -> wait -> session.
 * Deleted codespaces surface `reason: "deleted"` so the caller can offer the
 * one-click recreate flow from the stored pairing.
 */
export async function wakeCodespaceDevice(input: {
  device: Pick<CodespaceDevice, "codespaceName" | "baseUrl" | "engineAuth">;
  deps: CodespaceWakeDeps;
  timeouts?: Partial<CodespaceWakeTimeouts>;
  onPhase?: (phase: CodespaceWakePhase) => void;
}): Promise<CodespaceWakeResult> {
  const { device, deps } = input;
  const timeouts = { ...DEFAULT_WAKE_TIMEOUTS, ...input.timeouts };
  const phase = (value: CodespaceWakePhase) => input.onPhase?.(value);

  try {
    phase("checking-engine");
    if (await deps.checkEngineHealthy(device.baseUrl)) {
      phase("signing-in");
      await deps.ensureEngineSession(device.baseUrl, device.engineAuth);
      phase("ready");
      return { ok: true };
    }

    phase("checking-codespace");
    let codespace = await deps.getCodespace(device.codespaceName);
    if (!codespace || categorizeCodespaceState(codespace.state) === "gone") {
      return {
        ok: false,
        reason: "deleted",
        message:
          "This codespace no longer exists on GitHub (retention expired or it was deleted). Recreate it to continue.",
      };
    }
    if (categorizeCodespaceState(codespace.state) === "failed") {
      return {
        ok: false,
        reason: "failed",
        message: `GitHub reports the codespace as ${codespace.state}.`,
      };
    }

    if (categorizeCodespaceState(codespace.state) === "stopped") {
      phase("starting-codespace");
      codespace = await deps.startCodespace(device.codespaceName);
    }

    const availableDeadline = deps.now() + timeouts.codespaceAvailableMs;
    while (categorizeCodespaceState(codespace.state) !== "running") {
      if (categorizeCodespaceState(codespace.state) === "gone") {
        return {
          ok: false,
          reason: "deleted",
          message: "The codespace was deleted while starting.",
        };
      }
      if (categorizeCodespaceState(codespace.state) === "failed") {
        return {
          ok: false,
          reason: "failed",
          message: `GitHub reports the codespace as ${codespace.state}.`,
        };
      }
      if (deps.now() > availableDeadline) {
        return {
          ok: false,
          reason: "timeout",
          message: "Timed out waiting for the codespace to start.",
        };
      }
      await deps.sleep(timeouts.pollIntervalMs);
      const next = await deps.getCodespace(device.codespaceName);
      if (!next) {
        return {
          ok: false,
          reason: "deleted",
          message: "The codespace disappeared while starting.",
        };
      }
      codespace = next;
    }

    phase("waiting-engine");
    const engineDeadline = deps.now() + timeouts.engineHealthyMs;
    while (!(await deps.checkEngineHealthy(device.baseUrl))) {
      if (deps.now() > engineDeadline) {
        return {
          ok: false,
          reason: "timeout",
          message:
            "The codespace is running but its Cesium engine never became healthy. Check the bootstrap logs in /workspaces/.cesium/logs.",
        };
      }
      await deps.sleep(timeouts.pollIntervalMs);
    }

    phase("signing-in");
    await deps.ensureEngineSession(device.baseUrl, device.engineAuth);
    phase("ready");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/* ------------------------------ meta helpers ------------------------------ */

/**
 * Account-row codespace metadata for an already-derived device. Used by the
 * pairing bookkeeping writes (state transitions, renames) so every caller
 * persists the same shape and none of them drops the engine credentials.
 */
export function codespacePairingMeta(
  device: Pick<
    CodespaceDevice,
    | "repoFullName"
    | "repositoryId"
    | "codespaceName"
    | "machine"
    | "devcontainerPath"
    | "engineAuth"
    | "lastKnownState"
  >,
  overrides?: { lastKnownState?: string }
): CloudCodespaceMeta {
  const lastKnownState = overrides?.lastKnownState ?? device.lastKnownState ?? undefined;
  return {
    repoFullName: device.repoFullName,
    repositoryId: device.repositoryId,
    codespaceName: device.codespaceName,
    ...(device.machine ? { machine: device.machine } : {}),
    devcontainerPath: device.devcontainerPath,
    ...(lastKnownState ? { lastKnownState } : {}),
    lastSyncedAt: Date.now(),
    ...(device.engineAuth
      ? {
          engineUsername: device.engineAuth.username,
          enginePassword: device.engineAuth.password,
        }
      : {}),
  };
}

export function buildCodespaceMeta(input: {
  repoFullName: string;
  repositoryId: number;
  codespace: GithubCodespaceInfo;
  devcontainerPath: string;
  engineAuth: CodespaceEngineAuth;
}): CloudCodespaceMeta {
  return {
    repoFullName: input.repoFullName,
    repositoryId: input.repositoryId,
    codespaceName: input.codespace.name,
    ...(input.codespace.displayName
      ? { displayName: input.codespace.displayName }
      : {}),
    ...(input.codespace.machine ? { machine: input.codespace.machine } : {}),
    devcontainerPath: input.devcontainerPath,
    lastKnownState: input.codespace.state,
    lastSyncedAt: Date.now(),
    engineUsername: input.engineAuth.username,
    enginePassword: input.engineAuth.password,
  };
}
