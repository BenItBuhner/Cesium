"use client";

import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "@/components/auth/AuthProvider";
import { WorkbenchProviders } from "@/components/layout/WorkbenchProviders";
import { GlobalSettingsProvider } from "@/components/preferences/GlobalSettingsProvider";
import { ServerConnectionsProvider } from "@/components/preferences/ServerConnectionsProvider";
import { UserPreferencesProvider } from "@/components/preferences/UserPreferencesProvider";
import { ThemeProvider } from "@/components/theme/ThemeProvider";

function ThemedAuthBoundary({ children }: { children: ReactNode }) {
  const { ready, enabled, authenticated, connectionError } = useAuth();
  const engineSettingsEnabled =
    ready && !connectionError && (!enabled || authenticated);

  return (
    <GlobalSettingsProvider serverSettingsEnabled={engineSettingsEnabled}>
      <ThemeProvider>
        <UserPreferencesProvider>{children}</UserPreferencesProvider>
      </ThemeProvider>
    </GlobalSettingsProvider>
  );
}

export function WorkbenchRouteProviders({ children }: { children: ReactNode }) {
  return (
    <ServerConnectionsProvider>
      <AuthProvider>
        <ThemedAuthBoundary>
          <WorkbenchProviders>{children}</WorkbenchProviders>
        </ThemedAuthBoundary>
      </AuthProvider>
    </ServerConnectionsProvider>
  );
}
