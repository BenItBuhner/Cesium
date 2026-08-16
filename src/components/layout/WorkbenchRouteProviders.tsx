"use client";

import { Fragment, type ReactNode } from "react";
import { AuthProvider, useAuth } from "@/components/auth/AuthProvider";
import { WelcomeOverlay } from "@/components/auth/WelcomeOverlay";
import { WorkbenchProviders } from "@/components/layout/WorkbenchProviders";
import { GlobalSettingsProvider } from "@/components/preferences/GlobalSettingsProvider";
import { ServerConnectionsProvider } from "@/components/preferences/ServerConnectionsProvider";
import { UserPreferencesProvider } from "@/components/preferences/UserPreferencesProvider";
import { ThemeProvider } from "@/components/theme/ThemeProvider";

/**
 * The workbench shell always renders — there is no full-app auth wall. When
 * the active engine is unreachable or asking for credentials, the
 * {@link WelcomeOverlay} floats above the shell (sign in with your account,
 * connect an engine as a guest, or unlock the engine inline). Remounting the
 * subtree when the engine becomes usable gives every data provider a fresh
 * fetch instead of stale 401/offline state.
 */
function ThemedAuthBoundary({ children }: { children: ReactNode }) {
  const { ready, enabled, authenticated, connectionError } = useAuth();
  const engineUsable = ready && !connectionError && (!enabled || authenticated);

  return (
    <GlobalSettingsProvider serverSettingsEnabled={engineUsable}>
      <ThemeProvider>
        <UserPreferencesProvider>
          <Fragment key={engineUsable ? "engine-usable" : "engine-blocked"}>
            {children}
          </Fragment>
          <WelcomeOverlay />
        </UserPreferencesProvider>
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
