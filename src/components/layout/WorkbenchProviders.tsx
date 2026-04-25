"use client";

import type { ReactNode } from "react";
import { WorkbenchNotificationProvider } from "@/components/notifications/WorkbenchNotificationProvider";
import { WorkspaceProvider } from "@/contexts/WorkspaceContext";

export function WorkbenchProviders({ children }: { children: ReactNode }) {
  return (
    <WorkbenchNotificationProvider>
      <WorkspaceProvider>{children}</WorkspaceProvider>
    </WorkbenchNotificationProvider>
  );
}
