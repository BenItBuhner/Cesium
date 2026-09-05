"use client";

import { useCallback, useRef } from "react";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import {
  getLastWorkspaceForServer,
  withLastWorkspaceForServer,
} from "@/lib/per-server-workspace-memory";

/**
 * Account-wide "last opened workspace per server" memory. Remembering is a
 * settings edit (synced to every device); recalling reads the latest map
 * through a ref so the returned callbacks stay referentially stable.
 */
export function useLastWorkspaceMemory(): {
  rememberLastWorkspaceForServer: (serverId: string, workspaceId: string) => void;
  getLastWorkspaceForServer: (serverId: string) => string | null;
} {
  const { settings, updateSettings } = useGlobalSettings();
  const mapRef = useRef(settings.general.lastWorkspaceByServer);
  mapRef.current = settings.general.lastWorkspaceByServer;

  const rememberLastWorkspaceForServer = useCallback(
    (serverId: string, workspaceId: string) => {
      updateSettings((current) => {
        const next = withLastWorkspaceForServer(
          current.general.lastWorkspaceByServer,
          serverId,
          workspaceId
        );
        return next === current.general.lastWorkspaceByServer
          ? current
          : { ...current, general: { ...current.general, lastWorkspaceByServer: next } };
      });
    },
    [updateSettings]
  );

  const recall = useCallback(
    (serverId: string) => getLastWorkspaceForServer(mapRef.current, serverId),
    []
  );

  return { rememberLastWorkspaceForServer, getLastWorkspaceForServer: recall };
}
