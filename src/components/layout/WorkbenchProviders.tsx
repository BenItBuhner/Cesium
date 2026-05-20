"use client";

import type { ReactNode } from "react";
import { WorkbenchNotificationProvider } from "@/components/notifications/WorkbenchNotificationProvider";
import { WorkspaceDirectoryProvider } from "@/contexts/WorkspaceDirectoryContext";
import { WorkspaceProvider } from "@/contexts/WorkspaceContext";

export function WorkbenchProviders({ children }: { children: ReactNode }) {
  return (
    <WorkbenchNotificationProvider>
      <WorkspaceDirectoryProvider>
        <WorkspaceProvider>{children}</WorkspaceProvider>
      </WorkspaceDirectoryProvider>
    </WorkbenchNotificationProvider>
  );
}
