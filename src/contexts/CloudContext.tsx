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
import { ClerkNativeHandoff } from "@/components/auth/ClerkNativeHandoff";
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
  applyCloudVoiceSecrets,
  clientKeyValueStore,
  getClientPlatform,
  getConfiguredServerBaseUrl,
  getStoredSessionToken,
  getVoiceSecretsForCloud,
  readStoredServerConnectionsState,
  SERVER_CONNECTIONS_EVENT,
  setStoredSessionToken,
  VOICE_CLIENT_SETTINGS_EVENT,
  writeStoredServerConnectionsState,
  isBrowserMachineOffered,
  isBrowserMachineUrl,
  isCesiumAccountSiteUrl,
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
import {
  getClerkFallbackRedirectUrl,
  getClerkSignInUrl,
  getClerkSignUpUrl,
} from "@/lib/cloud/clerk-urls";
import { installClerkFapiTunnel } from "@/lib/cloud/clerk-fapi-tunnel";
import {
  applyPersonalizationPayload,
  collectPersonalizationPayload,
} from "@/lib/cloud/personalization";
import {
  adoptOnboardingForAccount,
  mergeOnboardingState,
  writeOnboardingState,
} from "@/lib/onboarding/state";
import {
  buildCloudServerPushPayloads,
  CLOUD_SERVER_TOMBSTONES_STORAGE_KEY,
  cloudServerIdentity,
  diffRemovedCloudServers,
  isCloudSyncableServerUrl,
  mergeCloudServersIntoState,
  parseCloudServerTombstones,
  serializeCloudServerTombstones,
  type CloudServerRemoval,
} from "@/lib/cloud/cloud-servers";
import {
  mergeCloudCatalogsIntoStore,
  readConversationCatalogStore,
  writeConversationCatalogStore,
  type CloudConversationCatalogRow,
} from "@/lib/conversation-catalog";
import { unwrapConvexActionErrors } from "@/lib/cloud/convex-errors";

/**
 * Cesium Cloud Context - the client side of the cross-device user context.
 *
 * Local-first remains the source of truth for the running session; the cloud
 * (Convex, identity via Clerk or a gated device key) is a mirror that makes a
 * fresh sign-in anywhere feel like sitting back down at your own desk:
 * servers, personalization, agent setup, onboarding progress, and portable
 * conversation snapshots are all restored automatically.
 */

/** Durable GitHub Codespace pairing metadata mirrored on a server row. */
export type CloudCodespaceMeta = {
  repoFullName: string;
  repositoryId: number;
  codespaceName: string;
  displayName?: string;
  machine?: string;
  devcontainerPath: string;
  lastKnownState?: string;
  lastSyncedAt?: number;
  engineUsername?: string;
  enginePassword?: string;
};

export type CloudServer = {
  name: string;
  baseUrl: string;
  kind: "remote" | "local" | "codespace";
  sessionToken: string | null;
  /** Present for tunnel-backed engines shared through public access. */
  rendezvous: RendezvousLocator | null;
  /** Present for engines living inside a paired GitHub Codespace. */
  codespace?: CloudCodespaceMeta | null;
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
  secrets: Array<{ kind: string; payload: string; updatedAt: number }>;
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
    kind: "remote" | "local" | "codespace";
    sessionToken?: string;
    rendezvous?: RendezvousLocator;
    codespace?: CloudCodespaceMeta;
    notes?: string;
    markConnected?: boolean;
  }): Promise<void>;
  removeServer(input: CloudServerRemoval): Promise<void>;
  savePreferences(payload: string): Promise<void>;
  saveSecret(input: { kind: string; payload: string; updatedAt?: number }): Promise<void>;
  removeSecret(input: { kind: string }): Promise<void>;
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
  /**
   * Mirror one engine's rail listing to the account so other devices can
   * show it while the engine sleeps. Idempotent upsert keyed by `serverKey`.
   */
  saveConversationCatalog(input: {
    serverKey: string;
    serverName: string;
    baseUrl: string;
    payload: string;
    conversationCount: number;
    sourceUpdatedAt: number;
  }): Promise<void>;
  removeConversationCatalog(serverKey: string): Promise<void>;
};

export type CloudConversationCatalog = CloudConversationCatalogRow;

export type CloudStatus = "disabled" | "signed-out" | "loading" | "ready";

/**
 * GitHub proxy actions (Codespaces device integration). Server-side only:
 * the Convex deployment resolves the user's GitHub OAuth token through
 * Clerk's connected-accounts API, so tokens never reach this client.
 * Present only for Clerk-mode accounts that are signed in.
 */
export type CloudGithubActions = {
  connectionStatus(): Promise<{
    connected: boolean;
    login: string | null;
    error: string | null;
  }>;
  listRepos(): Promise<
    Array<{
      id: number;
      fullName: string;
      private: boolean;
      defaultBranch: string;
      pushedAt: string | null;
      description: string | null;
    }>
  >;
  listMachines(repoFullName: string): Promise<
    Array<{
      name: string;
      displayName: string;
      cpus: number;
      memoryInBytes: number;
      storageInBytes: number;
      prebuildAvailability: string | null;
    }>
  >;
  ensureDevcontainer(input: {
    repoFullName: string;
    mode: "commit" | "pr";
  }): Promise<{
    status: "ready" | "committed" | "pr-open";
    prUrl: string | null;
    devcontainerPath: string;
    templateVersion: number;
  }>;
  setupCodespaceSecrets(input: {
    repositoryId: number;
    engineUsername: string;
    enginePassword: string;
    extraSecrets?: Array<{ name: string; value: string }>;
  }): Promise<{ secretNames: string[] }>;
  createCodespace(input: {
    repoFullName: string;
    machine?: string;
    ref?: string;
    idleTimeoutMinutes?: number;
  }): Promise<{
    codespace: CloudGithubCodespace;
    engineBaseUrl: string;
    /** True when an existing Cesium codespace was reused instead of created. */
    adopted: boolean;
  }>;
  getCodespace(codespaceName: string): Promise<CloudGithubCodespace | null>;
  startCodespace(codespaceName: string): Promise<CloudGithubCodespace>;
  stopCodespace(codespaceName: string): Promise<CloudGithubCodespace>;
  deleteCodespace(codespaceName: string): Promise<void>;
};

export type CloudGithubCodespace = {
  name: string;
  displayName: string | null;
  state: string;
  repositoryFullName: string | null;
  machine: string | null;
  gitRef: string | null;
  lastUsedAt: string | null;
  webUrl: string | null;
  idleTimeoutMinutes: number | null;
  retentionExpiresAt: string | null;
};

export type CloudContextValue = {
  mode: CloudMode;
  status: CloudStatus;
  /** Stable identity key (clerk:* or device:*) once known. */
  userKey: string | null;
  userName: string | null;
  userEmail: string | null;
  bootstrap: CloudBootstrap | null;
  actions: CloudActions | null;
  github: CloudGithubActions | null;
  /**
   * Account-mirrored conversation catalogs (one per engine), live-updated.
   * `null` until the first result arrives or when the cloud is off. They
   * are also folded into the local catalog store automatically, so most
   * consumers read that store rather than this list.
   */
  conversationCatalogs: CloudConversationCatalog[] | null;
};

/**
 * Clerk's modals (reverification, UserProfile, sign-in) default to
 * z-index 10000, which is *below* Cesium's own portalled dialogs (the
 * Codespace wizard, settings pickers, toasts all sit in the 10100-10400
 * band). Without this, the "additional verification" prompt renders behind
 * the wizard that triggered it. Keep Clerk above every app overlay.
 */
const CLERK_APPEARANCE = {
  elements: {
    modalBackdrop: { zIndex: 20000 },
  },
} as const;

const DISABLED_VALUE: CloudContextValue = {
  mode: "disabled",
  status: "disabled",
  userKey: null,
  userName: null,
  userEmail: null,
  bootstrap: null,
  actions: null,
  github: null,
  conversationCatalogs: null,
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
 * identities - servers the user removed on this device - are skipped so they
 * do not resurrect on every bootstrap.
 */
function mergeCloudServersIntoLocal(servers: CloudServer[]): CloudServer[] {
  const banned = servers.filter((server) => !isCloudSyncableServerUrl(server.baseUrl));
  const usable = servers.filter((server) => isCloudSyncableServerUrl(server.baseUrl));
  const tombstones = parseCloudServerTombstones(
    clientKeyValueStore().getItem(CLOUD_SERVER_TOMBSTONES_STORAGE_KEY)
  );
  const state = readStoredServerConnectionsState(getConfiguredServerBaseUrl());
  const keepLocalServer = (baseUrl: string) => {
    if (isCesiumAccountSiteUrl(baseUrl)) {
      return false;
    }
    // Native shells ignore a tab-local engine that leaked in via older sync.
    // The website / PWA keeps its own in-tab copy.
    if (!isBrowserMachineOffered() && isBrowserMachineUrl(baseUrl)) {
      return false;
    }
    return true;
  };
  const withoutAccountSite = {
    ...state,
    servers: state.servers.filter((server) => keepLocalServer(server.baseUrl)),
  };
  if (withoutAccountSite.servers.length === 0) {
    withoutAccountSite.activeServerId = null;
    withoutAccountSite.defaultServerId = null;
  } else {
    if (
      !withoutAccountSite.servers.some((server) => server.id === withoutAccountSite.activeServerId)
    ) {
      withoutAccountSite.activeServerId = withoutAccountSite.servers[0]?.id ?? null;
    }
    if (
      !withoutAccountSite.servers.some((server) => server.id === withoutAccountSite.defaultServerId)
    ) {
      withoutAccountSite.defaultServerId =
        withoutAccountSite.servers.length === 1
          ? (withoutAccountSite.servers[0]?.id ?? null)
          : null;
    }
  }
  const merged = mergeCloudServersIntoState(withoutAccountSite, usable, {
    skipIdentities: tombstones,
  });
  const localChanged =
    merged.changed ||
    withoutAccountSite.servers.length !== state.servers.length ||
    withoutAccountSite.activeServerId !== state.activeServerId;
  for (const entry of merged.sessionTokens) {
    if (!getStoredSessionToken(entry.baseUrl)) {
      setStoredSessionToken(entry.sessionToken, null, entry.baseUrl);
    }
  }
  if (localChanged) {
    writeStoredServerConnectionsState(merged.state);
  }
  return banned;
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

  // Separate from bootstrap: catalogs carry whole rail listings and change
  // on every agent turn somewhere, so they must not re-fire the bootstrap
  // restore effects below.
  const conversationCatalogs = useQuery(
    api.catalogs.list,
    active ? identityArgs : "skip"
  ) as CloudConversationCatalog[] | null | undefined;

  const register = useMutation(api.context.register);
  const saveServerMutation = useMutation(api.servers.save);
  const removeServerMutation = useMutation(api.servers.remove);
  const savePreferencesMutation = useMutation(api.preferences.save);
  const saveSecretMutation = useMutation(api.secrets.save);
  const removeSecretMutation = useMutation(api.secrets.remove);
  const saveAgentPrefMutation = useMutation(api.agents.save);
  const updateOnboardingMutation = useMutation(api.onboarding.update);
  const pushSnapshotMutation = useMutation(api.snapshots.push);
  const saveCatalogMutation = useMutation(api.catalogs.save);
  const removeCatalogMutation = useMutation(api.catalogs.remove);

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
      async saveSecret(input) {
        await saveSecretMutation({ ...identityArgs, ...input });
      },
      async removeSecret(input) {
        await removeSecretMutation({ ...identityArgs, ...input });
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
      async saveConversationCatalog(input) {
        await saveCatalogMutation({ ...identityArgs, ...input });
      },
      async removeConversationCatalog(serverKey) {
        await removeCatalogMutation({ ...identityArgs, serverKey });
      },
    }),
    [
      convex,
      identityArgs,
      pushSnapshotMutation,
      removeCatalogMutation,
      removeSecretMutation,
      removeServerMutation,
      saveAgentPrefMutation,
      saveCatalogMutation,
      savePreferencesMutation,
      saveSecretMutation,
      saveServerMutation,
      updateOnboardingMutation,
    ]
  );

  // Account catalogs flow into the local catalog store (newest capture per
  // engine wins) so the rail's offline fallback has one place to look.
  useEffect(() => {
    if (!conversationCatalogs || conversationCatalogs.length === 0) {
      return;
    }
    const merged = mergeCloudCatalogsIntoStore(
      readConversationCatalogStore(),
      conversationCatalogs
    );
    if (merged.changed) {
      writeConversationCatalogStore(merged.store);
    }
  }, [conversationCatalogs]);

  // Device-key deployments authenticate GitHub actions with the same
  // identity args as every other cloud call; Clerk identities ride the JWT.
  // Every call unwraps ConvexError data so the surfaces rendering
  // `error.message` show GitHub's real failure, not a redacted envelope.
  const githubActions = useMemo<CloudGithubActions>(
    () => ({
      connectionStatus: () =>
        unwrapConvexActionErrors(() =>
          convex.action(api.github.connectionStatus, { ...identityArgs })
        ),
      listRepos: () =>
        unwrapConvexActionErrors(() =>
          convex.action(api.github.reposList, { ...identityArgs })
        ),
      listMachines: (repoFullName) =>
        unwrapConvexActionErrors(() =>
          convex.action(api.github.machinesList, { ...identityArgs, repoFullName })
        ),
      ensureDevcontainer: (input) =>
        unwrapConvexActionErrors(() =>
          convex.action(api.github.ensureDevcontainer, { ...identityArgs, ...input })
        ),
      setupCodespaceSecrets: (input) =>
        unwrapConvexActionErrors(() =>
          convex.action(api.github.setupCodespaceSecrets, { ...identityArgs, ...input })
        ),
      createCodespace: (input) =>
        unwrapConvexActionErrors(() =>
          convex.action(api.github.codespaceCreate, { ...identityArgs, ...input })
        ),
      getCodespace: (codespaceName) =>
        unwrapConvexActionErrors(() =>
          convex.action(api.github.codespaceGet, { ...identityArgs, codespaceName })
        ),
      startCodespace: (codespaceName) =>
        unwrapConvexActionErrors(() =>
          convex.action(api.github.codespaceStart, { ...identityArgs, codespaceName })
        ),
      stopCodespace: (codespaceName) =>
        unwrapConvexActionErrors(() =>
          convex.action(api.github.codespaceStop, { ...identityArgs, codespaceName })
        ),
      deleteCodespace: async (codespaceName) => {
        await unwrapConvexActionErrors(() =>
          convex.action(api.github.codespaceDelete, { ...identityArgs, codespaceName })
        );
      },
    }),
    [convex, identityArgs]
  );

  // Autonomous restore: when the cloud context arrives, fold servers and
  // personalization into local state without any user action.
  const lastAppliedBootstrapRef = useRef<CloudBootstrap | null>(null);
  useEffect(() => {
    if (!bootstrap || lastAppliedBootstrapRef.current === bootstrap) {
      return;
    }
    lastAppliedBootstrapRef.current = bootstrap;
    const banned = mergeCloudServersIntoLocal(bootstrap.servers);
    for (const server of banned) {
      void actions.removeServer({ baseUrl: server.baseUrl }).catch(() => undefined);
    }
    reconcilePersonalization(bootstrap.preferencesPayload, actions.savePreferences);
    applyCloudVoiceSecrets(bootstrap.secrets ?? []);
    const adopted = adoptOnboardingForAccount(bootstrap.user.key);
    writeOnboardingState(
      mergeOnboardingState(adopted, bootstrap.onboarding),
      bootstrap.user.key
    );
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

  useEffect(() => {
    if (!active) {
      return;
    }
    const pushVoiceSecrets = () => {
      for (const record of getVoiceSecretsForCloud()) {
        void actions.saveSecret(record).catch(() => undefined);
      }
    };
    pushVoiceSecrets();
    return getClientPlatform().addEventListener(VOICE_CLIENT_SETTINGS_EVENT, pushVoiceSecrets);
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
      // Clerk accounts resolve GitHub tokens via connected accounts; device
      // deployments via the CESIUM_GITHUB_TOKEN env var. Either way the
      // proxy is available whenever the cloud identity is.
      github: active ? githubActions : null,
      conversationCatalogs: conversationCatalogs ?? null,
    }),
    [
      mode,
      status,
      bootstrap,
      deviceKey,
      clerkName,
      clerkEmail,
      active,
      actions,
      githubActions,
      conversationCatalogs,
    ]
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
      <ClerkNativeHandoff />
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
 * directly - zero cloud code paths execute.
 *
 * The runtime override is read after mount (and re-read on the toggle
 * event) so the first client render always matches SSR markup on the Next
 * app; the standalone Electron/mobile renderer has no SSR and just flips one
 * state update after mount.
 */
export function CloudProviders({ children }: { children: ReactNode }) {
  const configuredMode = getCloudMode();
  // Must be installed before ClerkProvider triggers clerk-js's first request:
  // packaged mobile WebViews cannot reach the Clerk Frontend API directly
  // (file:// pages send `Origin: null`, which Clerk rejects), so FAPI traffic
  // is relayed through the native shell. No-op everywhere else.
  useState(() => installClerkFapiTunnel());
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
        signInFallbackRedirectUrl={getClerkFallbackRedirectUrl()}
        signUpFallbackRedirectUrl={getClerkFallbackRedirectUrl()}
        appearance={CLERK_APPEARANCE}
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
