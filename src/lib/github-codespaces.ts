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
  | "updating-engine"
  | "ready";

export type CodespaceWakeResult =
  | {
      ok: true;
      /**
       * Non-fatal problem worth telling the user about (keep-alive missing or
       * failing, engine update failed). The wake still succeeded.
       */
      warning?: string;
    }
  | {
      ok: false;
      reason: "deleted" | "failed" | "timeout" | "error";
      message: string;
    };

/**
 * What the engine's `/health` says about its codespace keep-alive service.
 *
 * - `unsupported`: health answered but had no `codespace` snapshot - the
 *   engine predates the keep-alive and WILL be stopped by GitHub's idle
 *   timeout mid-run. Fixable in place via the engine's self-update API,
 *   which every codespace engine has shipped since before Codespaces
 *   pairing existed.
 * - `reported`: the snapshot exists; `enabled`/`consecutiveFailures` say
 *   whether heartbeats are actually protecting the codespace.
 * - `unknown`: the probe failed (engine restarting/unreachable) - no verdict.
 */
export type CodespaceEngineKeepaliveProbe =
  | { status: "unknown" }
  | { status: "unsupported" }
  | {
      status: "reported";
      enabled: boolean;
      lastError: string | null;
      consecutiveFailures: number;
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
  /**
   * Inspect the engine's keep-alive support/health. Optional together with
   * `applyEngineUpdate`; when either is missing the wake flow skips the
   * stale-engine remediation entirely.
   */
  probeEngineKeepalive?(baseUrl: string): Promise<CodespaceEngineKeepaliveProbe>;
  /** Kick the engine's in-place self-update (requires a minted session). */
  applyEngineUpdate?(baseUrl: string): Promise<{ ok: boolean; error?: string }>;
  sleep(ms: number): Promise<void>;
  now(): number;
};

export type CodespaceWakeTimeouts = {
  codespaceAvailableMs: number;
  engineHealthyMs: number;
  /** How long the updated engine gets to reinstall + restart before we give up waiting. */
  engineUpdateMs: number;
  pollIntervalMs: number;
};

export const DEFAULT_WAKE_TIMEOUTS: CodespaceWakeTimeouts = {
  // Cold resume: container start + engine supervisor boot.
  codespaceAvailableMs: 5 * 60_000,
  // postStart reinstall paths can be slow on first boot after rebuild.
  engineHealthyMs: 10 * 60_000,
  // Self-update re-runs the installer (git pull + bun install + package builds).
  engineUpdateMs: 10 * 60_000,
  pollIntervalMs: 4_000,
};

/** Heartbeat failures at/above this count are surfaced as a wake warning. */
const KEEPALIVE_FAILURE_WARNING_THRESHOLD = 3;

/**
 * Post-sign-in guard: make sure the engine actually holds the codespace
 * awake. Engines installed before the keep-alive shipped never receive it
 * otherwise - the bootstrap's install marker freezes them at creation-time
 * code, and GitHub cannot raise a codespace's idle timeout after creation -
 * so a stale engine is updated in place through its own update API and the
 * wake waits for the new engine to come back.
 *
 * Returns a user-facing warning when the engine could not be brought up to
 * date (or its keep-alive is failing); never blocks the wake outright.
 */
async function ensureKeepaliveCapableEngine(input: {
  device: Pick<CodespaceDevice, "baseUrl" | "engineAuth">;
  deps: CodespaceWakeDeps;
  timeouts: CodespaceWakeTimeouts;
  phase: (value: CodespaceWakePhase) => void;
}): Promise<string | undefined> {
  const { device, deps, timeouts, phase } = input;
  if (!deps.probeEngineKeepalive || !deps.applyEngineUpdate) {
    return undefined;
  }
  let probe = await deps.probeEngineKeepalive(device.baseUrl);
  if (probe.status === "unsupported") {
    phase("updating-engine");
    let updateError: string | null = null;
    try {
      const update = await deps.applyEngineUpdate(device.baseUrl);
      if (!update.ok) {
        updateError = update.error ?? "the engine rejected the update";
      }
    } catch (error) {
      updateError = error instanceof Error ? error.message : String(error);
    }
    if (updateError) {
      return (
        "This codespace runs an outdated Cesium engine without the keep-alive, " +
        "so GitHub may stop it mid-run. Updating it failed: " +
        `${updateError}. Recreate the codespace to fix this permanently.`
      );
    }
    // The manager CLI stops the engine right after the stream closes; wait
    // for the rebuilt engine to come back and report keep-alive support.
    const deadline = deps.now() + timeouts.engineUpdateMs;
    for (;;) {
      await deps.sleep(timeouts.pollIntervalMs);
      probe = await deps.probeEngineKeepalive(device.baseUrl);
      if (probe.status === "reported") {
        break;
      }
      if (deps.now() > deadline) {
        return (
          "The codespace engine update did not come back in time. It may still " +
          "be installing - check /workspaces/.cesium/logs in the codespace, or " +
          "recreate it if this persists."
        );
      }
    }
    // The restart may have invalidated the session that authorized the update.
    phase("signing-in");
    await deps.ensureEngineSession(device.baseUrl, device.engineAuth);
  }
  if (probe.status === "reported") {
    if (!probe.enabled) {
      return (
        "The codespace engine's keep-alive is not active, so GitHub may stop " +
        "the codespace mid-run. Restart the codespace; recreate it if this persists."
      );
    }
    if (probe.consecutiveFailures >= KEEPALIVE_FAILURE_WARNING_THRESHOLD) {
      return (
        "The codespace engine's keep-alive heartbeats are failing" +
        `${probe.lastError ? ` (${probe.lastError})` : ""}, so GitHub may stop ` +
        "the codespace mid-run. Restart the codespace; recreate it if this persists."
      );
    }
  }
  return undefined;
}

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
      const warning = await ensureKeepaliveCapableEngine({ device, deps, timeouts, phase });
      phase("ready");
      return warning ? { ok: true, warning } : { ok: true };
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
    const warning = await ensureKeepaliveCapableEngine({ device, deps, timeouts, phase });
    phase("ready");
    return warning ? { ok: true, warning } : { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/* ------------------------------ meta helpers ------------------------------ */

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
