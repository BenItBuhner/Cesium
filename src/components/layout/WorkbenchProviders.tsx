"use client";

import type { ReactNode } from "react";
import { WorkbenchNotificationProvider } from "@/components/notifications/WorkbenchNotificationProvider";
import { GlobalSettingsProvider } from "@/components/preferences/GlobalSettingsProvider";
import { useServerConnections } from "@/components/server/ServerConnectionsProvider";
import { WorkspaceProvider } from "@/contexts/WorkspaceContext";

export function WorkbenchProviders({ children }: { children: ReactNode }) {
  const { activeServer } = useServerConnections();

  return (
    <WorkbenchNotificationProvider>
      <WorkspaceProvider key={activeServer.id}>
        <GlobalSettingsProvider>{children}</GlobalSettingsProvider>
      </WorkspaceProvider>
    </WorkbenchNotificationProvider>
  );
}
