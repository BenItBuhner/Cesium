"use client";

import type { ReactNode } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { WorkbenchProviders } from "@/components/layout/WorkbenchProviders";
import { GlobalSettingsProvider } from "@/components/preferences/GlobalSettingsProvider";
import { ServerConnectionsProvider } from "@/components/preferences/ServerConnectionsProvider";
import { UserPreferencesProvider } from "@/components/preferences/UserPreferencesProvider";
import { ThemeProvider } from "@/components/theme/ThemeProvider";

export function WorkbenchRouteProviders({ children }: { children: ReactNode }) {
  return (
    <ServerConnectionsProvider>
      <AuthProvider>
        <AuthGate>
          <GlobalSettingsProvider>
            <ThemeProvider>
              <UserPreferencesProvider>
                <WorkbenchProviders>{children}</WorkbenchProviders>
              </UserPreferencesProvider>
            </ThemeProvider>
          </GlobalSettingsProvider>
        </AuthGate>
      </AuthProvider>
    </ServerConnectionsProvider>
  );
}
