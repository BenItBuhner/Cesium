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
  writeStoredServerConnectionsState,
  type RendezvousLocator,
  type ServerConnection,
} from "@cesium/client";
import { api } from "@convex/_generated/api";
import {
  CLOUD_LOCAL_ONLY_EVENT,
  getClerkPublishableKey,
  getCloudMode,
  getConvexUrl,
  getOrCreateDeviceKey,
  isCloudLocallyDisabled,
  type CloudMode,
} from "@/lib/cloud/cloud-env";
import { getClerkSignInUrl, getClerkSignUpUrl } from "@/lib/cloud/clerk-urls";
import {
  applyPersonalizationPayload,
  collectPersonalizationPayload,
} from "@/lib/cloud/personalization";
import {
  buildCloudServerPushPayloads,
  CLOUD_SERVER_TOMBSTONES_STORAGE_KEY,
  cloudServerIdentity,
  diffRemovedCloudServers,
  mergeCloudServersIntoState,
  parseCloudServerTombstones,
  serializeCloudServerTombstones,
  type CloudServerRemoval,
} from "@/lib/cloud/cloud-servers";

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
  /** Present for tunnel-backed engines shared through public access. */
  rendezvous: RendezvousLocator | null;
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
    rendezvous?: RendezvousLocator;
    notes?: string;
    markConnected?: boolean;
  }): Promise<void>;
  removeServer(input: CloudServerRemoval): Promise<void>;
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

/**
 * Merge cloud servers into the local connection list (additive). Tombstoned
 * identities — servers the user removed on this device — are skipped so they
 * do not resurrect on every bootstrap.
 */
function mergeCloudServersIntoLocal(servers: CloudServer[]): void {
  if (servers.length === 0) {
    return;
  }
  const tombstones = parseCloudServerTombstones(
    clientKeyValueStore().getItem(CLOUD_SERVER_TOMBSTONES_STORAGE_KEY)
  );
  const state = readStoredServerConnectionsState(getConfiguredServerBaseUrl());
  const merged = mergeCloudServersIntoState(state, servers, {
    skipIdentities: tombstones,
  });
  for (const entry of merged.sessionTokens) {
    if (!getStoredSessionToken(entry.baseUrl)) {
      setStoredSessionToken(entry.sessionToken, null, entry.baseUrl);
    }
  }
  if (merged.changed) {
    writeStoredServerConnectionsState(merged.state);
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
      async removeServer(input) {
        await removeServerMutation({ ...identityArgs, ...input });
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

  // Local server-list changes push up (additive, idempotent upserts). The
  // initial push on activation matters: a server adopted before sign-in
  // completed (e.g. via a connect link) still reaches the account. Local
  // removals propagate too, and leave a tombstone so the next bootstrap does
  // not resurrect the server on this device.
  const lastPushedServersRef = useRef<ServerConnection[] | null>(null);
  useEffect(() => {
    if (!active) {
      lastPushedServersRef.current = null;
      return;
    }
    const pushLocalServers = () => {
      const state = readStoredServerConnectionsState(getConfiguredServerBaseUrl());
      const store = clientKeyValueStore();
      const tombstones = parseCloudServerTombstones(
        store.getItem(CLOUD_SERVER_TOMBSTONES_STORAGE_KEY)
      );
      let tombstonesChanged = false;
      for (const server of state.servers) {
        if (tombstones.delete(cloudServerIdentity(server))) {
          tombstonesChanged = true;
        }
      }
      const previous = lastPushedServersRef.current;
      if (previous) {
        for (const removal of diffRemovedCloudServers(previous, state.servers)) {
          const identity = removal.rendezvousServerId
            ? `rendezvous:${removal.rendezvousServerId}`
            : removal.baseUrl
              ? cloudServerIdentity({ baseUrl: removal.baseUrl })
              : null;
          if (identity) {
            tombstones.add(identity);
            tombstonesChanged = true;
          }
          void actions.removeServer(removal).catch(() => undefined);
        }
      }
      if (tombstonesChanged) {
        store.setItem(
          CLOUD_SERVER_TOMBSTONES_STORAGE_KEY,
          serializeCloudServerTombstones(tombstones)
        );
      }
      lastPushedServersRef.current = state.servers;
      for (const payload of buildCloudServerPushPayloads(
        state.servers,
        (baseUrl) => getStoredSessionToken(baseUrl)
      )) {
        void actions.saveServer(payload).catch(() => undefined);
      }
    };
    pushLocalServers();
    return getClientPlatform().addEventListener(SERVER_CONNECTIONS_EVENT, pushLocalServers);
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

const CLERK_READY_TIMEOUT_MS = 8_000;

function ClerkCloudBridge({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { isLoaded } = useAuth();
  const { user } = useUser();
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (isLoaded) {
      setTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => setTimedOut(true), CLERK_READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [isLoaded]);
  return (
    <CloudBridge
      mode="clerk"
      authReady={(isLoaded && !isLoading) || timedOut}
      signedIn={isLoaded && isAuthenticated}
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
 * Mounts the cloud provider tree appropriate for this client's mode:
 * build-time configuration (env vars or the committed production defaults in
 * cloud-defaults.ts) unless this device flipped the runtime local-only
 * switch in Settings → Account. With cloud disabled this renders children
 * directly — zero cloud code paths execute.
 *
 * The runtime override is read after mount (and re-read on the toggle
 * event) so the first client render always matches SSR markup on the Next
 * app; the standalone Electron/mobile renderer has no SSR and just flips one
 * state update after mount.
 */
export function CloudProviders({ children }: { children: ReactNode }) {
  const configuredMode = getCloudMode();
  const [localOnly, setLocalOnly] = useState(false);
  useEffect(() => {
    setLocalOnly(isCloudLocallyDisabled());
    return getClientPlatform().addEventListener(CLOUD_LOCAL_ONLY_EVENT, () => {
      setLocalOnly(isCloudLocallyDisabled());
    });
  }, []);
  const mode = localOnly ? "disabled" : configuredMode;
  const client = mode === "disabled" ? null : getConvexClient();
  if (mode === "disabled" || !client) {
    return (
      <CloudContext.Provider value={DISABLED_VALUE}>
        {children}
      </CloudContext.Provider>
    );
  }
  if (mode === "clerk") {
    return (
      <ClerkProvider
        publishableKey={getClerkPublishableKey() ?? undefined}
        signInUrl={getClerkSignInUrl()}
        signUpUrl={getClerkSignUpUrl()}
        signInFallbackRedirectUrl="/agent"
        signUpFallbackRedirectUrl="/agent"
      >
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
