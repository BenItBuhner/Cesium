"use client";

import type { ReactNode } from "react";
import { WorkbenchNotificationProvider } from "@/components/notifications/WorkbenchNotificationProvider";
import { GlobalSettingsProvider } from "@/components/preferences/GlobalSettingsProvider";
import { useServerConnections } from "@/components/server/ServerConnectionsProvider";
import { WorkspaceProvider } from "@/contexts/WorkspaceContext";

export function WorkbenchProviders({ children }: { children: ReactNode }) {
  const { activeConnection, ready } = useServerConnections();
  const workspaceProviderKey = ready ? activeConnection.id : "workspace-bootstrap";

  return (
    <WorkbenchNotificationProvider>
      <WorkspaceProvider key={workspaceProviderKey}>
        <GlobalSettingsProvider>{children}</GlobalSettingsProvider>
      </WorkspaceProvider>
    </WorkbenchNotificationProvider>
  );
}
