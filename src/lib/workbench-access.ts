"use client";

import { useMemo } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { useCloudContext } from "@/contexts/CloudContext";
import {
  deriveWorkbenchAccess,
  type WorkbenchAccess,
} from "@/lib/workbench-access-state";

export type {
  WorkbenchAccess,
  WorkbenchAccessInput,
  WorkbenchAccountKind,
  WorkbenchEngineKind,
} from "@/lib/workbench-access-state";
export { deriveWorkbenchAccess } from "@/lib/workbench-access-state";

export function useWorkbenchAccess(): WorkbenchAccess {
  const cloud = useCloudContext();
  const auth = useAuth();
  const { activeServer, serverStatusById } = useServerConnections();
  const health = serverStatusById[activeServer.id]?.health ?? "unknown";

  return useMemo(
    () =>
      deriveWorkbenchAccess({
        cloudMode: cloud.mode,
        cloudStatus: cloud.status,
        userName: cloud.userName,
        userEmail: cloud.userEmail,
        userImageUrl: cloud.userImageUrl,
        authReady: auth.ready,
        authEnabled: auth.enabled,
        authAuthenticated: auth.authenticated,
        authConnectionError: auth.connectionError,
        health,
        engineLabel: activeServer.label,
        engineBaseUrl: activeServer.baseUrl,
      }),
    [
      activeServer.baseUrl,
      activeServer.label,
      auth.authenticated,
      auth.connectionError,
      auth.enabled,
      auth.ready,
      cloud.mode,
      cloud.status,
      cloud.userEmail,
      cloud.userImageUrl,
      cloud.userName,
      health,
    ]
  );
}
