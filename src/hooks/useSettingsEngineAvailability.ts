"use client";

import { useMemo } from "react";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import {
  resolveSettingsEngineAvailability,
  settingsEnginePagesVisible,
  type SettingsEngineAvailability,
} from "@/lib/settings-availability";

export function useSettingsEngineAvailability(): {
  availability: SettingsEngineAvailability;
  enginePagesVisible: boolean;
  engineConnected: boolean;
} {
  const { hasServer, servers, onlineServers, serverStatusById } = useServerConnections();
  const availability = useMemo(
    () =>
      resolveSettingsEngineAvailability({
        hasServer,
        servers,
        onlineCount: onlineServers.length,
        statusById: serverStatusById,
      }),
    [hasServer, onlineServers.length, serverStatusById, servers]
  );
  return {
    availability,
    enginePagesVisible: settingsEnginePagesVisible(availability),
    engineConnected: availability === "connected",
  };
}
