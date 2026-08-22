/**
 * Cloud execution pseudo-devices for the device picker.
 *
 * A backend that advertises `supportsCloudExecution` (e.g. Cursor via
 * `@cursor/sdk` cloud agents) contributes one pseudo-device to the device
 * system. Selecting it does not switch the active engine — conversation
 * records stay on the active server — it marks new conversations to execute
 * on the vendor's hosted infrastructure (`executionTarget: "cloud"`).
 */

import type { AgentBackendId, AgentBackendInfo } from "@/lib/agent-types";

export type CloudExecutionDevice = {
  /** Pseudo-device id, e.g. "cloud:cursor-sdk". Never collides with server ids. */
  id: string;
  backendId: AgentBackendId;
  label: string;
  description: string;
};

const CLOUD_EXECUTION_DEVICE_ID_PREFIX = "cloud:";

export const ACTIVE_CLOUD_EXECUTION_DEVICE_STORAGE_KEY =
  "opencursor.cloud-execution-device";

/** Friendly labels per backend; falls back to "<Backend label> Cloud". */
const CLOUD_EXECUTION_DEVICE_LABELS: Partial<Record<AgentBackendId, string>> = {
  "cursor-sdk": "Cursor Cloud",
};

const CLOUD_EXECUTION_DEVICE_DESCRIPTIONS: Partial<Record<AgentBackendId, string>> = {
  "cursor-sdk": "Runs on Cursor's cloud infrastructure",
};

export function cloudExecutionDeviceId(backendId: AgentBackendId): string {
  return `${CLOUD_EXECUTION_DEVICE_ID_PREFIX}${backendId}`;
}

export function isCloudExecutionDeviceId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(CLOUD_EXECUTION_DEVICE_ID_PREFIX);
}

export function parseCloudExecutionDeviceBackendId(
  id: string | null | undefined
): string | null {
  if (!isCloudExecutionDeviceId(id)) {
    return null;
  }
  const backendId = (id as string).slice(CLOUD_EXECUTION_DEVICE_ID_PREFIX.length);
  return backendId.length > 0 ? backendId : null;
}

export function backendSupportsCloudExecution(backend: AgentBackendInfo): boolean {
  return backend.capabilities.supportsCloudExecution === true;
}

/**
 * One pseudo-device per cloud-capable, credentialed backend. Unavailable
 * backends (e.g. Cursor without an API key) contribute nothing, so the cloud
 * device disappears from the picker until credentials are configured.
 */
export function deriveCloudExecutionDevices(
  backends: AgentBackendInfo[]
): CloudExecutionDevice[] {
  return backends
    .filter((backend) => backendSupportsCloudExecution(backend) && backend.available)
    .map((backend) => ({
      id: cloudExecutionDeviceId(backend.id),
      backendId: backend.id,
      label: CLOUD_EXECUTION_DEVICE_LABELS[backend.id] ?? `${backend.label} Cloud`,
      description:
        CLOUD_EXECUTION_DEVICE_DESCRIPTIONS[backend.id] ??
        "Runs on the harness vendor's cloud infrastructure",
    }));
}

// --- Persisted active pseudo-device (localStorage + external-store bridge) ---

let activeIdSnapshot: string | null = null;
let activeIdSnapshotLoaded = false;

const listeners = new Set<() => void>();

function emitActiveCloudDeviceChanged() {
  activeIdSnapshotLoaded = false;
  for (const listener of listeners) {
    listener();
  }
}

export function getActiveCloudExecutionDeviceIdSnapshot(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  if (!activeIdSnapshotLoaded) {
    const raw = window.localStorage.getItem(ACTIVE_CLOUD_EXECUTION_DEVICE_STORAGE_KEY);
    activeIdSnapshot = raw && isCloudExecutionDeviceId(raw) ? raw : null;
    activeIdSnapshotLoaded = true;
  }
  return activeIdSnapshot;
}

export function subscribeActiveCloudExecutionDeviceId(
  onStoreChange: () => void
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

export function writeActiveCloudExecutionDeviceId(id: string | null): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (id && isCloudExecutionDeviceId(id)) {
      window.localStorage.setItem(ACTIVE_CLOUD_EXECUTION_DEVICE_STORAGE_KEY, id);
    } else {
      window.localStorage.removeItem(ACTIVE_CLOUD_EXECUTION_DEVICE_STORAGE_KEY);
    }
  } catch {
    return;
  }
  emitActiveCloudDeviceChanged();
}
