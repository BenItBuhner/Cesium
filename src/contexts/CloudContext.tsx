"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ClerkProvider, useAuth, useUser } from "@clerk/nextjs";
import {
  ConvexProvider,
  ConvexReactClient,
  useConvex,
  useConvexAuth,
  useMutation,
  useQuery,
} from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import {
  clientKeyValueStore,
  getClientPlatform,
  getConfiguredServerBaseUrl,
  getStoredSessionToken,
  readStoredServerConnectionsState,
  SERVER_CONNECTIONS_EVENT,
  setStoredSessionToken,
  upsertServerConnection,
  writeStoredServerConnectionsState,
} from "@cesium/client";
import { api } from "@convex/_generated/api";
import {
  getClerkPublishableKey,
  getCloudMode,
  getConvexUrl,
  getOrCreateDeviceKey,
  type CloudMode,
} from "@/lib/cloud/cloud-env";
import {
  applyPersonalizationPayload,
  collectPersonalizationPayload,
} from "@/lib/cloud/personalization";

/**
 * Cesium Cloud Context — the client side of the cross-device user context.
 *
 * Local-first remains the source of truth for the running session; the cloud
 * (Convex, identity via Clerk or a gated device key) is a mirror that makes a
 * fresh sign-in anywhere feel like sitting back down at your own desk:
 * servers, personalization, agent setup, onboarding progress, and portable
 * conversation snapshots are all restored automatically.
 */

export type CloudServer = {
  name: string;
  baseUrl: string;
  kind: "remote" | "local";
  sessionToken: string | null;
  notes: string | null;
  lastConnectedAt: number | null;
};

export type CloudSnapshotMeta = {
  snapshotKey: string;
  title: string;
  backendId: string;
  modelId: string | null;
  modelName: string | null;
  workspaceName: string | null;
  serverName: string | null;
  messageCount: number;
  sourceUpdatedAt: number;
  updatedAt: number;
};

export type CloudSnapshot = CloudSnapshotMeta & {
  recordJson: string;
  eventsJson: string;
};

export type CloudBootstrap = {
  user: {
    key: string;
    name: string | null;
    email: string | null;
    imageUrl: string | null;
    createdAt: number;
  };
  servers: CloudServer[];
  preferencesPayload: string | null;
  agentPrefs: Array<{
    backendId: string;
    enabled: boolean;
    defaultModelId: string | null;
    defaultModelName: string | null;
    configuredAt: number;
  }>;
  onboarding: {
    platform: string;
    completedSteps: string[];
    completedAt: number | null;
  } | null;
  snapshots: CloudSnapshotMeta[];
};

export type CloudActions = {
  saveServer(input: {
    name: string;
    baseUrl: string;
    kind: "remote" | "local";
    sessionToken?: string;
    notes?: string;
    markConnected?: boolean;
  }): Promise<void>;
  removeServer(baseUrl: string): Promise<void>;
  savePreferences(payload: string): Promise<void>;
  saveAgentPref(input: {
    backendId: string;
    enabled: boolean;
    defaultModelId?: string;
    defaultModelName?: string;
  }): Promise<void>;
  updateOnboarding(input: {
    platform: string;
    completeSteps?: string[];
    markComplete?: boolean;
  }): Promise<void>;
  pushSnapshot(input: {
    snapshotKey: string;
    title: string;
    backendId: string;
    modelId?: string;
    modelName?: string;
    workspaceName?: string;
    serverName?: string;
    messageCount: number;
    recordJson: string;
    eventsJson: string;
    sourceUpdatedAt: number;
  }): Promise<void>;
  getSnapshot(snapshotKey: string): Promise<CloudSnapshot | null>;
};

export type CloudStatus = "disabled" | "signed-out" | "loading" | "ready";

export type CloudContextValue = {
  mode: CloudMode;
  status: CloudStatus;
  /** Stable identity key (clerk:* or device:*) once known. */
  userKey: string | null;
  userName: string | null;
  userEmail: string | null;
  bootstrap: CloudBootstrap | null;
  actions: CloudActions | null;
};

const DISABLED_VALUE: CloudContextValue = {
  mode: "disabled",
  status: "disabled",
  userKey: null,
  userName: null,
  userEmail: null,
  bootstrap: null,
  actions: null,
};

const CloudContext = createContext<CloudContextValue>(DISABLED_VALUE);

export function useCloudContext(): CloudContextValue {
  return useContext(CloudContext);
}

/* ------------------------------------------------------------------------ */
/* Autonomous sync effects                                                   */
/* ------------------------------------------------------------------------ */

const PERSONALIZATION_SYNC_MARKER_KEY = "cesium-cloud-personalization-last-sync";
export const CLOUD_PERSONALIZATION_APPLIED_EVENT = "cesium:cloud-personalization-applied";

/**
 * Reconcile personalization between local storage and the cloud:
 * - cloud empty → seed it from local.
 * - cloud changed since our last sync → apply it locally (fresh device or
 *   another device updated it) and broadcast so theme/preferences re-read.
 * - cloud unchanged but local differs → push local up.
 */
function reconcilePersonalization(
  cloudPayload: string | null,
  save: (payload: string) => Promise<void>
): void {
  const store = clientKeyValueStore();
  const local = collectPersonalizationPayload();
  const lastSynced = store.getItem(PERSONALIZATION_SYNC_MARKER_KEY);
  if (cloudPayload === null) {
    void save(local).then(() => store.setItem(PERSONALIZATION_SYNC_MARKER_KEY, local));
    return;
  }
  if (cloudPayload === local) {
    store.setItem(PERSONALIZATION_SYNC_MARKER_KEY, cloudPayload);
    return;
  }
  if (lastSynced === cloudPayload) {
    void save(local).then(() => store.setItem(PERSONALIZATION_SYNC_MARKER_KEY, local));
    return;
  }
  const changed = applyPersonalizationPayload(cloudPayload);
  store.setItem(PERSONALIZATION_SYNC_MARKER_KEY, cloudPayload);
  if (changed) {
    getClientPlatform().emitEvent(CLOUD_PERSONALIZATION_APPLIED_EVENT);
  }
}

/** Merge cloud servers into the local connection list (additive). */
function mergeCloudServersIntoLocal(servers: CloudServer[]): void {
  if (servers.length === 0) {
    return;
  }
  const configuredDefault = getConfiguredServerBaseUrl();
  let state = readStoredServerConnectionsState(configuredDefault);
  let changed = false;
  for (const server of servers) {
    const before = state;
    try {
      state = upsertServerConnection(state, {
        label: server.name,
        baseUrl: server.baseUrl,
      });
    } catch {
      continue;
    }
    if (state !== before) {
      changed = true;
    }
    if (server.sessionToken && !getStoredSessionToken(server.baseUrl)) {
      setStoredSessionToken(server.sessionToken, null, server.baseUrl);
    }
  }
  if (changed) {
    writeStoredServerConnectionsState(state);
  }
}

/* ------------------------------------------------------------------------ */
/* Bridge (inside Convex provider)                                          */
/* ------------------------------------------------------------------------ */

function CloudBridge({
  mode,
  authReady,
  signedIn,
  clerkName,
  clerkEmail,
  children,
}: {
  mode: CloudMode;
  authReady: boolean;
  signedIn: boolean;
  clerkName: string | null;
  clerkEmail: string | null;
  children: ReactNode;
}) {
  // The device key lives in browser storage; resolve it client-side only so
  // SSR markup never bakes in a different (ephemeral, server-generated) key.
  const [deviceKey, setDeviceKey] = useState<string | null>(null);
  useEffect(() => {
    if (mode === "device") {
      setDeviceKey(getOrCreateDeviceKey());
    }
  }, [mode]);
  const identityArgs = useMemo(
    () => (deviceKey ? { deviceKey } : {}),
    [deviceKey]
  );
  const identityReady = mode !== "device" || deviceKey !== null;
  const active = authReady && signedIn && identityReady;

  const convex = useConvex();
  const bootstrap = useQuery(
    api.context.bootstrap,
    active ? identityArgs : "skip"
  ) as CloudBootstrap | null | undefined;

  const register = useMutation(api.context.register);
  const saveServerMutation = useMutation(api.servers.save);
  const removeServerMutation = useMutation(api.servers.remove);
  const savePreferencesMutation = useMutation(api.preferences.save);
  const saveAgentPrefMutation = useMutation(api.agents.save);
  const updateOnboardingMutation = useMutation(api.onboarding.update);
  const pushSnapshotMutation = useMutation(api.snapshots.push);

  const registeredRef = useRef(false);
  useEffect(() => {
    if (!active || registeredRef.current) {
      return;
    }
    registeredRef.current = true;
    void register(identityArgs).catch(() => {
      registeredRef.current = false;
    });
  }, [active, identityArgs, register]);

  const actions = useMemo<CloudActions>(
    () => ({
      async saveServer(input) {
        await saveServerMutation({ ...identityArgs, ...input });
      },
      async removeServer(baseUrl) {
        await removeServerMutation({ ...identityArgs, baseUrl });
      },
      async savePreferences(payload) {
        await savePreferencesMutation({ ...identityArgs, payload });
      },
      async saveAgentPref(input) {
        await saveAgentPrefMutation({ ...identityArgs, ...input });
      },
      async updateOnboarding(input) {
        await updateOnboardingMutation({ ...identityArgs, ...input });
      },
      async pushSnapshot(input) {
        await pushSnapshotMutation({ ...identityArgs, ...input });
      },
      async getSnapshot(snapshotKey) {
        return (await convex.query(api.snapshots.get, {
          ...identityArgs,
          snapshotKey,
        })) as CloudSnapshot | null;
      },
    }),
    [
      convex,
      identityArgs,
      pushSnapshotMutation,
      removeServerMutation,
      saveAgentPrefMutation,
      savePreferencesMutation,
      saveServerMutation,
      updateOnboardingMutation,
    ]
  );

  // Autonomous restore: when the cloud context arrives, fold servers and
  // personalization into local state without any user action.
  const lastAppliedBootstrapRef = useRef<CloudBootstrap | null>(null);
  useEffect(() => {
    if (!bootstrap || lastAppliedBootstrapRef.current === bootstrap) {
      return;
    }
    lastAppliedBootstrapRef.current = bootstrap;
    mergeCloudServersIntoLocal(bootstrap.servers);
    reconcilePersonalization(bootstrap.preferencesPayload, actions.savePreferences);
  }, [bootstrap, actions]);

  // Local server-list changes push up (additive, idempotent upserts).
  useEffect(() => {
    if (!active) {
      return;
    }
    const platform = getClientPlatform();
    return platform.addEventListener(SERVER_CONNECTIONS_EVENT, () => {
      const state = readStoredServerConnectionsState(getConfiguredServerBaseUrl());
      for (const server of state.servers) {
        const sessionToken = getStoredSessionToken(server.baseUrl);
        void actions
          .saveServer({
            name: server.label,
            baseUrl: server.baseUrl,
            kind: "remote",
            ...(sessionToken ? { sessionToken } : {}),
          })
          .catch(() => undefined);
      }
    });
  }, [active, actions]);

  const status: CloudStatus = !authReady
    ? "loading"
    : !signedIn
      ? "signed-out"
      : !identityReady || bootstrap === undefined
        ? "loading"
        : "ready";

  const value = useMemo<CloudContextValue>(
    () => ({
      mode,
      status,
      userKey: bootstrap?.user.key ?? (deviceKey ? `device:${deviceKey}` : null),
      userName: bootstrap?.user.name ?? clerkName,
      userEmail: bootstrap?.user.email ?? clerkEmail,
      bootstrap: bootstrap ?? null,
      actions: active ? actions : null,
    }),
    [mode, status, bootstrap, deviceKey, clerkName, clerkEmail, active, actions]
  );

  return <CloudContext.Provider value={value}>{children}</CloudContext.Provider>;
}

function ClerkCloudBridge({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { isLoaded } = useAuth();
  const { user } = useUser();
  return (
    <CloudBridge
      mode="clerk"
      authReady={isLoaded && !isLoading}
      signedIn={isAuthenticated}
      clerkName={user?.fullName ?? null}
      clerkEmail={user?.primaryEmailAddress?.emailAddress ?? null}
    >
      {children}
    </CloudBridge>
  );
}

/* ------------------------------------------------------------------------ */
/* Providers                                                                */
/* ------------------------------------------------------------------------ */

let convexClient: ConvexReactClient | null = null;

function getConvexClient(): ConvexReactClient | null {
  const url = getConvexUrl();
  if (!url) {
    return null;
  }
  if (!convexClient) {
    convexClient = new ConvexReactClient(url);
  }
  return convexClient;
}

/**
 * Mounts the cloud provider tree appropriate for this build's mode. With
 * cloud disabled (e.g. the Electron desktop default) this renders children
 * directly — zero cloud code paths execute.
 */
export function CloudProviders({ children }: { children: ReactNode }) {
  const mode = getCloudMode();
  const client = getConvexClient();
  if (mode === "disabled" || !client) {
    return (
      <CloudContext.Provider value={DISABLED_VALUE}>
        {children}
      </CloudContext.Provider>
    );
  }
  if (mode === "clerk") {
    return (
      <ClerkProvider publishableKey={getClerkPublishableKey() ?? undefined}>
        <ConvexProviderWithClerk client={client} useAuth={useAuth}>
          <ClerkCloudBridge>{children}</ClerkCloudBridge>
        </ConvexProviderWithClerk>
      </ClerkProvider>
    );
  }
  return (
    <ConvexProvider client={client}>
      <CloudBridge
        mode="device"
        authReady
        signedIn
        clerkName={null}
        clerkEmail={null}
      >
        {children}
      </CloudBridge>
    </ConvexProvider>
  );
}
