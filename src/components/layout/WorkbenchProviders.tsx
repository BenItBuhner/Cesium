"use client";

import type { ReactNode } from "react";
import { WorkbenchNotificationProvider } from "@/components/notifications/WorkbenchNotificationProvider";
import { GlobalSettingsProvider } from "@/components/preferences/GlobalSettingsProvider";
import { WorkspaceProvider } from "@/contexts/WorkspaceContext";

export function WorkbenchProviders({ children }: { children: ReactNode }) {
  return (
    <WorkbenchNotificationProvider>
      <WorkspaceProvider>
        <GlobalSettingsProvider>{children}</GlobalSettingsProvider>
      </WorkspaceProvider>
    </WorkbenchNotificationProvider>
  );
}
