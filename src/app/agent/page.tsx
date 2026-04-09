import type { Metadata } from "next";
import { AgentLayout } from "@/components/layout/AgentLayout";
import { WorkbenchNotificationProvider } from "@/components/notifications/WorkbenchNotificationProvider";
import { GlobalSettingsProvider } from "@/components/preferences/GlobalSettingsProvider";
import { WorkspaceProvider } from "@/contexts/WorkspaceContext";

export const metadata: Metadata = {
  title: "Agent · OpenCursor",
};

export default function AgentPage() {
  return (
    <WorkbenchNotificationProvider>
      <WorkspaceProvider>
        <GlobalSettingsProvider>
          <AgentLayout />
        </GlobalSettingsProvider>
      </WorkspaceProvider>
    </WorkbenchNotificationProvider>
  );
}
