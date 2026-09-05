"use client";

import { useMemo } from "react";
import { useOptionalAuth } from "@/components/auth/AuthProvider";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useCloudContext } from "@/contexts/CloudContext";
import { isUnconfiguredServerConnection } from "@cesium/client";
import {
  getServerDisplayLabel,
  getServerRailAppearance,
} from "@/lib/server-rail-appearance";

/**
 * The identity source currently backing this client, in priority order:
 *
 * - `clerk` - production cloud account (Clerk sign-in), signed in.
 * - `clerk-signed-out` - production cloud build, but nobody is signed in.
 * - `device` - cloud sync under a per-browser device key (no real account).
 * - `engine` - password session on the active engine server
 *   (`OPENCURSOR_AUTH_*`); the local-only / self-hosted posture.
 * - `local` - local-first mode; no account of any kind is configured.
 */
export type AccountIdentityKind =
  | "clerk"
  | "clerk-signed-out"
  | "device"
  | "engine"
  | "local";

export type AccountIdentity = {
  kind: AccountIdentityKind;
  signedIn: boolean;
  /** Primary line: user name, email, username, or a mode label. */
  title: string;
  /** Secondary line: email or the active server label. */
  subtitle: string;
  /** Short badge describing the identity mode. */
  modeLabel: string;
  imageUrl: string | null;
  /** Display label of the active server (always resolved). */
  serverLabel: string;
};

/**
 * Merges the two account systems (cloud account via Clerk/device sync, and
 * the engine password session) into one presentable identity summary for
 * account previews and the Account settings panel.
 */
export function useAccountIdentity(): AccountIdentity {
  const cloud = useCloudContext();
  const auth = useOptionalAuth();
  const { activeServer, servers } = useServerConnections();
  const { settings } = useGlobalSettings();

  const serverLabel = useMemo(() => {
    if (isUnconfiguredServerConnection(activeServer)) {
      return "No server";
    }
    const appearance = getServerRailAppearance(
      settings.general.serverRailAppearances,
      activeServer.id,
      servers.findIndex((server) => server.id === activeServer.id)
    );
    return getServerDisplayLabel(activeServer, appearance);
  }, [activeServer, servers, settings.general.serverRailAppearances]);

  return useMemo<AccountIdentity>(() => {
    if (cloud.mode === "clerk") {
      if (cloud.status === "signed-out") {
        return {
          kind: "clerk-signed-out",
          signedIn: false,
          title: "Not signed in",
          subtitle: "Sign in to use your account",
          modeLabel: "Signed out",
          imageUrl: null,
          serverLabel,
        };
      }
      const title =
        cloud.userName ??
        cloud.userEmail ??
        (cloud.status === "loading" ? "Connecting…" : "Signed in");
      return {
        kind: "clerk",
        signedIn: cloud.status === "ready",
        title,
        subtitle:
          cloud.userEmail && cloud.userEmail !== title
            ? cloud.userEmail
            : "Signed in",
        modeLabel: "Signed in",
        imageUrl: cloud.bootstrap?.user.imageUrl ?? null,
        serverLabel,
      };
    }
    if (cloud.mode === "device") {
      return {
        kind: "device",
        signedIn: cloud.status === "ready",
        title: "Device sync",
        subtitle: "Synced on this browser",
        modeLabel: "Device",
        imageUrl: null,
        serverLabel,
      };
    }
    if (auth?.enabled && auth.authenticated && auth.session) {
      return {
        kind: "engine",
        signedIn: true,
        title: auth.session.username,
        subtitle: "Signed in to the engine",
        modeLabel: "Server session",
        imageUrl: null,
        serverLabel,
      };
    }
    return {
      kind: "local",
      signedIn: false,
      title: "Local workspace",
      subtitle: "No cloud account",
      modeLabel: "Local",
      imageUrl: null,
      serverLabel,
    };
  }, [auth, cloud, serverLabel]);
}
