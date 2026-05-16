import React from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "@/components/auth/AuthGate";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { GlobalSettingsProvider } from "@/components/preferences/GlobalSettingsProvider";
import { ServerConnectionsProvider } from "@/components/preferences/ServerConnectionsProvider";
import { UserPreferencesProvider } from "@/components/preferences/UserPreferencesProvider";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { WorkbenchApp } from "@/components/layout/WorkbenchApp";
import { WorkbenchProviders } from "@/components/layout/WorkbenchProviders";
import { initializeDesktopRuntime } from "./desktop-runtime";
import "./styles.css";

function DesktopRoot() {
  return (
    <ServerConnectionsProvider>
      <AuthProvider>
        <AuthGate>
          <GlobalSettingsProvider>
            <ThemeProvider>
              <UserPreferencesProvider>
                <WorkbenchProviders>
                  <WorkbenchApp />
                </WorkbenchProviders>
              </UserPreferencesProvider>
            </ThemeProvider>
          </GlobalSettingsProvider>
        </AuthGate>
      </AuthProvider>
    </ServerConnectionsProvider>
  );
}

void initializeDesktopRuntime().finally(() => {
  const root = document.getElementById("root");
  if (!root) {
    throw new Error("Missing root element.");
  }
  createRoot(root).render(
    <React.StrictMode>
      <DesktopRoot />
    </React.StrictMode>
  );
});
