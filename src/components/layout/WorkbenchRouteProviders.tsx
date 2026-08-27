"use client";

import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "@/components/auth/AuthProvider";
import { FirstRunAccountGate } from "@/components/auth/FirstRunAccountGate";
import { WorkbenchProviders } from "@/components/layout/WorkbenchProviders";
import { GlobalSettingsProvider } from "@/components/preferences/GlobalSettingsProvider";
import { ServerConnectionsProvider } from "@/components/preferences/ServerConnectionsProvider";
import { UserPreferencesProvider } from "@/components/preferences/UserPreferencesProvider";
import { ThemeProvider } from "@/components/theme/ThemeProvider";

function ThemedAuthBoundary({ children }: { children: ReactNode }) {
  const { ready, enabled, authenticated, connectionError, hasServerStatus } = useAuth();
  // Once the server has answered an auth-status request, a later transient
  // connection error must not flip this flag: toggling it makes
  // GlobalSettingsProvider drop to defaults and refetch, which visibly resets
  // theme/settings state mid-session.
  const serverSettingsEnabled =
    ready && (hasServerStatus || !connectionError) && (!enabled || authenticated);

  return (
    <GlobalSettingsProvider serverSettingsEnabled={serverSettingsEnabled}>
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
          <FirstRunAccountGate>
            <WorkbenchProviders>{children}</WorkbenchProviders>
          </FirstRunAccountGate>
        </ThemedAuthBoundary>
      </AuthProvider>
    </ServerConnectionsProvider>
  );
}
