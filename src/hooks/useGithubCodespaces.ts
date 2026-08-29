"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { setStoredSessionToken } from "@cesium/client";
import { useCloudContext } from "@/contexts/CloudContext";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import {
  checkEngineHealth,
  getEngineAuthStatus,
  loginToEngine,
} from "@/lib/onboarding/engine-api";
import {
  deriveCodespaceDevices,
  wakeCodespaceDevice,
  type CodespaceDevice,
  type CodespaceEngineAuth,
  type CodespaceWakePhase,
} from "@/lib/github-codespaces";

export type CodespaceWakeStatus = {
  deviceKey: string;
  phase: CodespaceWakePhase;
};

export type CodespaceWakeFailure = {
  deviceKey: string;
  reason: "deleted" | "failed" | "timeout" | "error";
  message: string;
};

const ENGINE_PROBE_TIMEOUT_MS = 8_000;

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

/**
 * GitHub Codespace devices for the device picker: derives the paired
 * codespaces from the account's cloud servers and orchestrates the
 * select -> wake -> connect flow. Safe to call in every cloud mode; devices
 * are empty (and selection is a no-op) unless a Clerk account is active.
 */
export function useGithubCodespaces() {
  const cloud = useCloudContext();
  const { servers, saveServer } = useServerConnections();
  const [wakeStatus, setWakeStatus] = useState<CodespaceWakeStatus | null>(null);
  const [wakeFailure, setWakeFailure] = useState<CodespaceWakeFailure | null>(null);
  const wakingRef = useRef(false);

  const devices = useMemo(
    () => deriveCodespaceDevices(cloud.bootstrap?.servers ?? [], servers),
    [cloud.bootstrap?.servers, servers]
  );

  const available = cloud.github !== null;

  /**
   * Wake the codespace (if needed), mint an engine session, make sure a
   * local connection exists, and return its local server id so the caller
   * can run the standard server-switch path.
   */
  const connectDevice = useCallback(
    async (device: CodespaceDevice): Promise<string | null> => {
      const github = cloud.github;
      if (!github || wakingRef.current) {
        return null;
      }
      wakingRef.current = true;
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
          setWakeFailure({
            deviceKey: device.key,
            reason: result.reason,
            message: result.message,
          });
          return null;
        }
        const saved = saveServer({
          id: device.localServerId ?? undefined,
          label: device.label,
          baseUrl: device.baseUrl,
        });
        // Refresh pairing bookkeeping (state + last connect) in the account.
        void cloud.actions
          ?.saveServer({
            name: device.label,
            baseUrl: device.baseUrl,
            kind: "codespace",
            markConnected: true,
            codespace: {
              repoFullName: device.repoFullName,
              repositoryId: device.repositoryId,
              codespaceName: device.codespaceName,
              ...(device.machine ? { machine: device.machine } : {}),
              devcontainerPath: device.devcontainerPath,
              lastKnownState: "Available",
              lastSyncedAt: Date.now(),
              ...(device.engineAuth
                ? {
                    engineUsername: device.engineAuth.username,
                    enginePassword: device.engineAuth.password,
                  }
                : {}),
            },
          })
          .catch(() => undefined);
        return saved.id;
      } finally {
        wakingRef.current = false;
        setWakeStatus(null);
      }
    },
    [cloud.actions, cloud.github, saveServer]
  );

  const dismissFailure = useCallback(() => setWakeFailure(null), []);

  return {
    /** Paired codespace devices (empty outside Clerk cloud mode). */
    devices,
    /** Whether the GitHub proxy is usable (Clerk account signed in). */
    available,
    wakeStatus,
    wakeFailure,
    connectDevice,
    dismissFailure,
  };
}
