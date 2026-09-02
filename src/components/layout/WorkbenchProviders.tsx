"use client";

import type { ReactNode } from "react";
import { ServerShareNotifier } from "@/components/notifications/ServerShareNotifier";
import { WorkbenchNotificationProvider } from "@/components/notifications/WorkbenchNotificationProvider";
import { WorkspaceDirectoryProvider } from "@/contexts/WorkspaceDirectoryContext";
import { WorkspaceProvider } from "@/contexts/WorkspaceContext";

export function WorkbenchProviders({ children }: { children: ReactNode }) {
  return (
    <WorkbenchNotificationProvider>
      <ServerShareNotifier />
      <WorkspaceDirectoryProvider>
        <WorkspaceProvider>{children}</WorkspaceProvider>
      </WorkspaceDirectoryProvider>
    </WorkbenchNotificationProvider>
  );
}
