"use client";

/**
 * Frontend orchestration for harness auth sync.
 *
 * Combines three sources into one per-harness view:
 * - the engine's sync readiness (installed / signed in / exportable),
 * - the account vault's sealed snapshots (from the cloud bootstrap),
 * - this device's per-harness opt-in decisions.
 *
 * All secret material is sealed/opened locally with the account wrapping
 * key; the cloud only ever stores AES-256-GCM ciphertext.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getClientPlatform,
  harnessAuthSyncDecision,
  HARNESS_AUTH_SYNC_PREFS_EVENT,
  listHarnessAuthCloudRecords,
  openHarnessAuthSnapshot,
  readHarnessAuthSyncPrefs,
  sealHarnessAuthSnapshot,
  setHarnessAuthSyncEnabled,
  harnessAuthCloudKind,
  type HarnessAuthSyncPrefs,
} from "@cesium/client";
import {
  exportHarnessAuthSnapshotFromServer,
  fetchHarnessAuthSyncStates,
  importHarnessAuthSnapshotToServer,
  type HarnessAuthSyncEngineState,
  type HarnessAuthSyncId,
  type ServerRequestContext,
} from "@/lib/server-api";
import { useCloudContext } from "@/contexts/CloudContext";
import { notifyAgentBackendsChanged } from "@/lib/agent-backend-events";

export type HarnessAuthSyncItem = {
  syncId: HarnessAuthSyncId;
  label: string;
  engine: HarnessAuthSyncEngineState | null;
  /** Sealed snapshot present in the account vault (metadata only). */
  cloud: { updatedAt: number } | null;
  /** Per-device opt-in: true/false once decided, null while undecided. */
  decision: boolean | null;
};

export type HarnessAuthSyncApi = {
  /** Cloud identity is signed in and the vault is reachable. */
  cloudReady: boolean;
  /** Engine states loaded (null while loading or when engine unreachable). */
  engineStates: HarnessAuthSyncEngineState[] | null;
  items: HarnessAuthSyncItem[];
  refresh: () => Promise<void>;
  /** Capture the engine's sign-in, seal it locally, upload to the vault. */
  pushToCloud: (syncId: HarnessAuthSyncId) => Promise<void>;
  /** Open the vault snapshot locally and apply it to the engine. */
  applyToEngine: (syncId: HarnessAuthSyncId) => Promise<{ applied: number }>;
  /** Record the per-device opt-in decision. */
  setEnabled: (syncId: HarnessAuthSyncId, enabled: boolean) => void;
  /** Delete the sealed snapshot from the account vault. */
  removeFromCloud: (syncId: HarnessAuthSyncId) => Promise<void>;
};

export function useHarnessAuthSync(options?: {
  /** Target a specific engine; defaults to the active server connection. */
  server?: ServerRequestContext;
  /** Skip engine probing entirely (cloud-only consumers). */
  skipEngine?: boolean;
}): HarnessAuthSyncApi {
  const cloud = useCloudContext();
  const skipEngine = options?.skipEngine === true;
  // Key the request target on primitives so inline `server={{ baseUrl }}`
  // props do not retrigger the fetch effect on every render.
  const serverId = options?.server?.serverId;
  const serverBaseUrl = options?.server?.baseUrl;
  const serverWorkspaceId = options?.server?.workspaceId;
  const server = useMemo<ServerRequestContext | undefined>(
    () =>
      serverBaseUrl
        ? { serverId, baseUrl: serverBaseUrl, workspaceId: serverWorkspaceId }
        : undefined,
    [serverId, serverBaseUrl, serverWorkspaceId]
  );

  const [engineStates, setEngineStates] = useState<
    HarnessAuthSyncEngineState[] | null
  >(null);
  const [prefs, setPrefs] = useState<HarnessAuthSyncPrefs | null>(null);

  useEffect(() => {
    setPrefs(readHarnessAuthSyncPrefs());
    return getClientPlatform().addEventListener(HARNESS_AUTH_SYNC_PREFS_EVENT, () =>
      setPrefs(readHarnessAuthSyncPrefs())
    );
  }, []);

  const refresh = useCallback(async () => {
    if (skipEngine) {
      return;
    }
    try {
      setEngineStates(await fetchHarnessAuthSyncStates(server));
    } catch {
      setEngineStates(null);
    }
  }, [server, skipEngine]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const cloudRecords = useMemo(
    () => listHarnessAuthCloudRecords(cloud.bootstrap?.secrets ?? []),
    [cloud.bootstrap]
  );

  const cloudReady = cloud.status === "ready" && cloud.actions != null;

  const items = useMemo<HarnessAuthSyncItem[]>(() => {
    const bySyncId = new Map<HarnessAuthSyncId, HarnessAuthSyncItem>();
    for (const state of engineStates ?? []) {
      bySyncId.set(state.syncId, {
        syncId: state.syncId,
        label: state.label,
        engine: state,
        cloud: null,
        decision: prefs ? harnessAuthSyncDecision(state.syncId, prefs) : null,
      });
    }
    for (const record of cloudRecords) {
      const existing = bySyncId.get(record.syncId);
      if (existing) {
        existing.cloud = { updatedAt: record.updatedAt };
      } else {
        bySyncId.set(record.syncId, {
          syncId: record.syncId,
          label: record.syncId,
          engine: null,
          cloud: { updatedAt: record.updatedAt },
          decision: prefs ? harnessAuthSyncDecision(record.syncId, prefs) : null,
        });
      }
    }
    return [...bySyncId.values()];
  }, [engineStates, cloudRecords, prefs]);

  const pushToCloud = useCallback(
    async (syncId: HarnessAuthSyncId) => {
      if (!cloud.actions) {
        throw new Error("Sign in to your Cesium account to sync agent sign-ins.");
      }
      const snapshot = await exportHarnessAuthSnapshotFromServer(syncId, server);
      if (!snapshot) {
        throw new Error("Nothing to sync: no sign-in found on the engine host.");
      }
      const sealed = await sealHarnessAuthSnapshot(snapshot);
      await cloud.actions.saveSecret({
        kind: harnessAuthCloudKind(syncId),
        payload: sealed,
        updatedAt: snapshot.capturedAt,
      });
    },
    [cloud.actions, server]
  );

  const applyToEngine = useCallback(
    async (syncId: HarnessAuthSyncId) => {
      const record = cloudRecords.find((entry) => entry.syncId === syncId);
      if (!record) {
        throw new Error("No synced sign-in found in your account for this agent.");
      }
      const snapshot = await openHarnessAuthSnapshot(record.payload, syncId);
      if (!snapshot) {
        throw new Error(
          "Could not decrypt the synced sign-in on this device. Sign in on the source device once so the encryption key syncs."
        );
      }
      const result = await importHarnessAuthSnapshotToServer(syncId, snapshot, server);
      if (result.errors.length > 0 && result.applied === 0) {
        throw new Error(result.errors.join(" "));
      }
      notifyAgentBackendsChanged();
      await refresh();
      return { applied: result.applied };
    },
    [cloudRecords, refresh, server]
  );

  const setEnabled = useCallback(
    (syncId: HarnessAuthSyncId, enabled: boolean) => {
      setPrefs(setHarnessAuthSyncEnabled(syncId, enabled));
    },
    []
  );

  const removeFromCloud = useCallback(
    async (syncId: HarnessAuthSyncId) => {
      if (!cloud.actions) {
        return;
      }
      await cloud.actions.removeSecret({ kind: harnessAuthCloudKind(syncId) });
    },
    [cloud.actions]
  );

  return {
    cloudReady,
    engineStates,
    items,
    refresh,
    pushToCloud,
    applyToEngine,
    setEnabled,
    removeFromCloud,
  };
}
