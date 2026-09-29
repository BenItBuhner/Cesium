"use client";

import { useCallback, useMemo, useRef } from "react";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import {
  buildServerDisplayLabels,
  sameServerDisplayLabels,
  serverDisplayLabel,
  type ServerDisplayLabels,
} from "@/lib/server-display-labels";

/**
 * Sidebar label per saved server. Keeps the same map while the labels are
 * unchanged, so relabeled rail groups stay identity-stable across refreshes.
 */
export function useServerDisplayLabels(): ServerDisplayLabels {
  const { servers, engineNameById } = useServerConnections();
  const { settings } = useGlobalSettings();
  const appearances = settings.general.serverRailAppearances;
  const previousRef = useRef<ServerDisplayLabels>(new Map());
  return useMemo(() => {
    const next = buildServerDisplayLabels(servers, appearances, engineNameById);
    if (sameServerDisplayLabels(previousRef.current, next)) {
      return previousRef.current;
    }
    previousRef.current = next;
    return next;
  }, [appearances, engineNameById, servers]);
}

/** Names one server at a time the way the sidebar does. */
export function useServerDisplayLabel(): (server: {
  id: string;
  label: string;
  baseUrl: string;
}) => string {
  const { engineNameById } = useServerConnections();
  const { settings } = useGlobalSettings();
  const appearances = settings.general.serverRailAppearances;
  return useCallback(
    (server) => serverDisplayLabel(server, appearances, engineNameById),
    [appearances, engineNameById]
  );
}
