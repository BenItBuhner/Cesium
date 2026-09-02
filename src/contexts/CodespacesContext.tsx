"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { setStoredSessionToken } from "@cesium/client";
import { useCloudContext } from "@/contexts/CloudContext";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import {
  checkEngineHealth,
  getEngineAuthStatus,
  loginToEngine,
} from "@/lib/onboarding/engine-api";
import {
  categorizeCodespaceState,
  codespacePairingMeta,
  deriveCodespaceDevices,
  wakeCodespaceDevice,
  type CodespaceDevice,
  type CodespaceEngineAuth,
  type CodespaceWakePhase,
} from "@/lib/github-codespaces";

/**
 * Shared GitHub Codespaces controller.
 *
 * One wake state machine for the whole workbench: the device picker, the
 * rail (opening a cached conversation of a sleeping codespace) and the
 * composer all need to start the same codespace, watch the same progress and
 * agree on its last known state. Hook-local state could not do that, so the
 * former `useGithubCodespaces` hook now reads from this provider.
 */

export type CodespaceWakeStatus = {
  deviceKey: string;
  phase: CodespaceWakePhase;
};

export type CodespaceWakeFailure = {
  deviceKey: string;
  reason: "deleted" | "failed" | "timeout" | "error";
  message: string;
};

export type CodespacesContextValue = {
  /** Paired codespace devices (empty outside cloud mode). */
  devices: CodespaceDevice[];
  /** Whether the GitHub proxy is usable (cloud identity active). */
  available: boolean;
  wakeStatus: CodespaceWakeStatus | null;
  wakeFailure: CodespaceWakeFailure | null;
  /**
   * Wake the codespace (if needed), mint an engine session, ensure a local
   * connection exists, and resolve its local server id - or null on failure.
   */
  connectDevice: (device: CodespaceDevice) => Promise<string | null>;
  dismissFailure: () => void;
  /** Failure of the most recent wake attempt, readable right after `connectDevice` resolves null. */
  getLastWakeFailure: () => CodespaceWakeFailure | null;
  /** Device paired to a local connection id, if any. */
  deviceForServerId: (serverId: string) => CodespaceDevice | null;
  /**
   * Lazily re-read each pairing's state from GitHub (throttled). Cheap
   * enough to call whenever the picker opens; the result also lands on the
   * account so every device agrees whether a codespace is running.
   */
  refreshDeviceStates: (options?: { force?: boolean }) => Promise<void>;
  /** When the last successful state refresh ran, null if never. */
  lastStateRefreshAt: number | null;
};

const DISABLED_VALUE: CodespacesContextValue = {
  devices: [],
  available: false,
  wakeStatus: null,
  wakeFailure: null,
  connectDevice: async () => null,
  dismissFailure: () => undefined,
  getLastWakeFailure: () => null,
  deviceForServerId: () => null,
  refreshDeviceStates: async () => undefined,
  lastStateRefreshAt: null,
};

const CodespacesContext = createContext<CodespacesContextValue>(DISABLED_VALUE);

export function useCodespaces(): CodespacesContextValue {
  return useContext(CodespacesContext);
}

const ENGINE_PROBE_TIMEOUT_MS = 8_000;
/** Minimum gap between lazy GitHub state refreshes. */
export const CODESPACE_STATE_REFRESH_MIN_GAP_MS = 60_000;

export async function probeEngineHealthy(baseUrl: string): Promise<boolean> {
  // checkEngineHealth has no timeout of its own; an unreachable forwarded
  // port can hang a fetch for ages, so race it against a short deadline.
  try {
    await Promise.race([
      checkEngineHealth(baseUrl),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), ENGINE_PROBE_TIMEOUT_MS)
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function ensureEngineSession(
  baseUrl: string,
  auth: CodespaceEngineAuth | null
): Promise<void> {
  const status = await getEngineAuthStatus(baseUrl);
  if (!status.enabled || status.authenticated) {
    return;
  }
  if (!auth) {
    throw new Error(
      "The codespace engine requires sign-in, but no stored credentials were found. Re-run Codespace setup."
    );
  }
  const { token } = await loginToEngine(baseUrl, auth.username, auth.password);
  setStoredSessionToken(token, null, baseUrl);
}

export function CodespacesProvider({ children }: { children: ReactNode }) {
  const cloud = useCloudContext();
  const { servers, saveServer } = useServerConnections();
  const [wakeStatus, setWakeStatus] = useState<CodespaceWakeStatus | null>(null);
  const [wakeFailure, setWakeFailure] = useState<CodespaceWakeFailure | null>(null);
  /** Fresh GitHub states by device key, layered over the account copy. */
  const [stateOverrides, setStateOverrides] = useState<Record<string, string>>({});
  const [lastStateRefreshAt, setLastStateRefreshAt] = useState<number | null>(null);
  const wakingRef = useRef(false);
  const lastWakeFailureRef = useRef<CodespaceWakeFailure | null>(null);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const lastRefreshAtRef = useRef(0);

  const baseDevices = useMemo(
    () => deriveCodespaceDevices(cloud.bootstrap?.servers ?? [], servers),
    [cloud.bootstrap?.servers, servers]
  );
  const devices = useMemo(
    () =>
      baseDevices.map((device) =>
        stateOverrides[device.key]
          ? { ...device, lastKnownState: stateOverrides[device.key]! }
          : device
      ),
    [baseDevices, stateOverrides]
  );
  const devicesRef = useRef(devices);
  devicesRef.current = devices;

  // A wake or a pairing change makes GitHub's answer authoritative again.
  useEffect(() => {
    setStateOverrides({});
  }, [cloud.bootstrap?.servers]);

  const available = cloud.github !== null;

  const persistPairing = useCallback(
    (device: CodespaceDevice, lastKnownState: string) => {
      void cloud.actions
        ?.saveServer({
          name: device.label,
          baseUrl: device.baseUrl,
          kind: "codespace",
          markConnected: lastKnownState === "Available",
          codespace: codespacePairingMeta(device, { lastKnownState }),
        })
        .catch(() => undefined);
    },
    [cloud.actions]
  );

  const connectDevice = useCallback(
    async (device: CodespaceDevice): Promise<string | null> => {
      const github = cloud.github;
      if (!github || wakingRef.current) {
        return null;
      }
      wakingRef.current = true;
      lastWakeFailureRef.current = null;
      setWakeFailure(null);
      setWakeStatus({ deviceKey: device.key, phase: "checking-engine" });
      try {
        const result = await wakeCodespaceDevice({
          device,
          deps: {
            checkEngineHealthy: probeEngineHealthy,
            getCodespace: (name) => github.getCodespace(name),
            startCodespace: (name) => github.startCodespace(name),
            ensureEngineSession,
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            now: () => Date.now(),
          },
          onPhase: (phase) => setWakeStatus({ deviceKey: device.key, phase }),
        });
        if (!result.ok) {
          const failure: CodespaceWakeFailure = {
            deviceKey: device.key,
            reason: result.reason,
            message: result.message,
          };
          lastWakeFailureRef.current = failure;
          setWakeFailure(failure);
          if (result.reason === "deleted") {
            setStateOverrides((current) => ({ ...current, [device.key]: "Deleted" }));
          }
          return null;
        }
        const saved = saveServer({
          id: device.localServerId ?? undefined,
          label: device.label,
          baseUrl: device.baseUrl,
        });
        setStateOverrides((current) => ({ ...current, [device.key]: "Available" }));
        // Refresh pairing bookkeeping (state + last connect) in the account.
        persistPairing(device, "Available");
        return saved.id;
      } finally {
        wakingRef.current = false;
        setWakeStatus(null);
      }
    },
    [cloud.github, persistPairing, saveServer]
  );

  const refreshDeviceStates = useCallback(
    async (options?: { force?: boolean }) => {
      const github = cloud.github;
      if (!github) {
        return;
      }
      if (refreshInFlightRef.current) {
        return refreshInFlightRef.current;
      }
      const now = Date.now();
      if (!options?.force && now - lastRefreshAtRef.current < CODESPACE_STATE_REFRESH_MIN_GAP_MS) {
        return;
      }
      lastRefreshAtRef.current = now;
      const run = (async () => {
        const snapshot = devicesRef.current;
        const results = await Promise.all(
          snapshot.map(async (device) => {
            try {
              const info = await github.getCodespace(device.codespaceName);
              return { device, state: info?.state ?? "Deleted" };
            } catch {
              return null;
            }
          })
        );
        const next: Record<string, string> = {};
        for (const result of results) {
          if (!result) {
            continue;
          }
          next[result.device.key] = result.state;
          // Only write back real transitions so the account row is not
          // churned once a minute for every picker open.
          if (
            result.device.lastKnownState !== result.state &&
            categorizeCodespaceState(result.state) !== "unknown"
          ) {
            persistPairing(result.device, result.state);
          }
        }
        setStateOverrides((current) => ({ ...current, ...next }));
        setLastStateRefreshAt(Date.now());
      })().finally(() => {
        refreshInFlightRef.current = null;
      });
      refreshInFlightRef.current = run;
      return run;
    },
    [cloud.github, persistPairing]
  );

  const deviceForServerId = useCallback(
    (serverId: string) =>
      devicesRef.current.find((device) => device.localServerId === serverId) ?? null,
    []
  );

  const dismissFailure = useCallback(() => setWakeFailure(null), []);
  const getLastWakeFailure = useCallback(() => lastWakeFailureRef.current, []);

  const value = useMemo<CodespacesContextValue>(
    () => ({
      devices,
      available,
      wakeStatus,
      wakeFailure,
      connectDevice,
      dismissFailure,
      getLastWakeFailure,
      deviceForServerId,
      refreshDeviceStates,
      lastStateRefreshAt,
    }),
    [
      available,
      connectDevice,
      deviceForServerId,
      devices,
      dismissFailure,
      getLastWakeFailure,
      lastStateRefreshAt,
      refreshDeviceStates,
      wakeFailure,
      wakeStatus,
    ]
  );

  return <CodespacesContext.Provider value={value}>{children}</CodespacesContext.Provider>;
}
