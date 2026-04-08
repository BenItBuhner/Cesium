import type { Metadata } from "next";
import { AuthGate } from "@/components/auth/AuthGate";
import { IDELayout } from "@/components/layout/IDELayout";
import { WorkbenchNotificationProvider } from "@/components/notifications/WorkbenchNotificationProvider";
import { GlobalSettingsProvider } from "@/components/preferences/GlobalSettingsProvider";
import { WorkspaceProvider } from "@/contexts/WorkspaceContext";

export const metadata: Metadata = {
  title: "Editor · OpenCursor",
};

export default function EditorPage() {
  return (
    <AuthGate>
      <WorkbenchNotificationProvider>
        <WorkspaceProvider>
          <GlobalSettingsProvider>
            <IDELayout />
          </GlobalSettingsProvider>
        </WorkspaceProvider>
      </WorkbenchNotificationProvider>
    </AuthGate>
  );
}
