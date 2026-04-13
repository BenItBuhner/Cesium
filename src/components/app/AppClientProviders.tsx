"use client";

import type { ReactNode } from "react";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { AuthGate } from "@/components/auth/AuthGate";
import { UserPreferencesProvider } from "@/components/preferences/UserPreferencesProvider";
import { RegisterServiceWorker } from "@/components/pwa/RegisterServiceWorker";
import {
  ServerConnectionsProvider,
  useServerConnections,
} from "@/components/server/ServerConnectionsProvider";
import { ThemeProvider } from "@/components/theme/ThemeProvider";

function AppProvidersContent({ children }: { children: ReactNode }) {
  const { activeConnection, ready } = useServerConnections();
  const authKey = ready ? activeConnection.id : "server-connections-bootstrap";

  return (
    <>
      <RegisterServiceWorker />
      <ThemeProvider>
        <AuthProvider key={authKey}>
          <AuthGate>
            <UserPreferencesProvider>{children}</UserPreferencesProvider>
          </AuthGate>
        </AuthProvider>
      </ThemeProvider>
    </>
  );
}

export function AppClientProviders({ children }: { children: ReactNode }) {
  return (
    <ServerConnectionsProvider>
      <AppProvidersContent>{children}</AppProvidersContent>
    </ServerConnectionsProvider>
  );
}
