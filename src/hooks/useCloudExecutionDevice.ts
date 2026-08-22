"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { AgentBackendInfo } from "@/lib/agent-types";
import {
  deriveCloudExecutionDevices,
  getActiveCloudExecutionDeviceIdSnapshot,
  subscribeActiveCloudExecutionDeviceId,
  writeActiveCloudExecutionDeviceId,
  type CloudExecutionDevice,
} from "@/lib/cloud-execution-devices";

export type CloudExecutionDeviceState = {
  /** Pseudo-devices contributed by cloud-capable, credentialed backends. */
  cloudDevices: CloudExecutionDevice[];
  /**
   * The active cloud pseudo-device, or null when new chats run locally. A
   * stored selection whose backend became unavailable resolves to null.
   */
  activeCloudDevice: CloudExecutionDevice | null;
  setActiveCloudDeviceId: (id: string | null) => void;
};

export function useCloudExecutionDevice(
  backends: AgentBackendInfo[]
): CloudExecutionDeviceState {
  const activeId = useSyncExternalStore(
    subscribeActiveCloudExecutionDeviceId,
    getActiveCloudExecutionDeviceIdSnapshot,
    () => null
  );
  const cloudDevices = useMemo(() => deriveCloudExecutionDevices(backends), [backends]);
  const activeCloudDevice = useMemo(
    () => cloudDevices.find((device) => device.id === activeId) ?? null,
    [activeId, cloudDevices]
  );
  const setActiveCloudDeviceId = useCallback((id: string | null) => {
    writeActiveCloudExecutionDeviceId(id);
  }, []);
  return { cloudDevices, activeCloudDevice, setActiveCloudDeviceId };
}
