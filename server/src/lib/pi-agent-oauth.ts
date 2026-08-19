import { promises as fs } from "node:fs";
import {
  applyPiRuntimeApiKeys,
  createPiAuthStorage,
  deletePiAgentProviderKey,
  describePiAgentHome,
  getPiAgentAuthPath,
  getPiAgentModelsPath,
  getPiAgentSettings,
  getPiAgentSettingsPublic,
  type PiAgentHomeInfo,
  type PiAgentSettingsPublic,
} from "./pi-agent-settings.js";
import { oauthCompletionHtml } from "./oauth/callback-html.js";
import {
  createOAuthCoordinatorSession,
  updateOAuthCoordinatorSession,
} from "./oauth/sessions.js";
import {
  isBlockedSubscriptionOAuthProviderId,
  isSubscriptionOAuthProviderId,
  SUBSCRIPTION_OAUTH_LABELS,
  SUBSCRIPTION_OAUTH_PROVIDER_IDS,
} from "./subscription-oauth.js";
import {
  clearXaiOAuthCredentials,
  hasXaiOAuthCredentials,
  persistXaiTokenResponse,
  pollXaiDeviceCodeToken,
  requestXaiDeviceCode,
  XAI_OAUTH_PROVIDER_ID,
} from "./xai-oauth.js";

export const PI_AGENT_MINIMUM_PROVIDER_IDS = SUBSCRIPTION_OAUTH_PROVIDER_IDS;

export type PiAgentMinimumProviderId = (typeof PI_AGENT_MINIMUM_PROVIDER_IDS)[number];

export type PiAgentProviderAuthMethod = "oauth" | "api_key" | "env" | null;

export type PiAgentProviderStatus = {
  id: string;
  name: string;
  oauthSupported: boolean;
  usesCallbackServer?: boolean;
  authMethod: PiAgentProviderAuthMethod;
  configured: boolean;
  authLabel?: string;
  modelCount: number;
  modelsAvailable: boolean;
  apiKeyLastFour?: string;
};

export type PiAgentSettingsResponse = {
  settings: PiAgentSettingsPublic;
  providers: PiAgentProviderStatus[];
  home: PiAgentHomeInfo;
};

export type PiAgentOAuthStartResponse = {
  providerId: string;
  authUrl?: string;
  deviceCode?: string;
  userCode?: string;
  verificationUri?: string;
  instructions?: string;
  callbackUrl?: string;
  sessionId?: string;
};

type PiOAuthPending = {
  providerId: string;
  createdAt: number;
  resolveManual?: (redirect: string) => void;
  rejectManual?: (error: Error) => void;
  loginPromise: Promise<void>;
};

const pendingByProvider = new Map<string, PiOAuthPending>();
const PENDING_TTL_MS = 15 * 60 * 1000;
const OAUTH_START_TIMEOUT_MS = 30_000;
const AUTH_LOCK_STALE_MS = 5 * 60 * 1000;

const PROVIDER_LABELS: Record<string, string> = {
  ...SUBSCRIPTION_OAUTH_LABELS,
};

function normalizeProviderId(providerId: string): string {
  return providerId.trim().toLowerCase();
}

function assertSupportedProviderId(providerId: string): void {
  if (!isSubscriptionOAuthProviderId(providerId)) {
    throw new Error(
      `Unsupported subscription OAuth provider: ${providerId}. Only ChatGPT/Codex and SpaceXAI SuperGrok are offered.`
    );
  }
}

async function revokeBlockedSubscriptionOAuth(
  authStorage: Awaited<ReturnType<typeof createPiAuthStorage>>
): Promise<void> {
  for (const providerId of authStorage.list()) {
    if (
      isBlockedSubscriptionOAuthProviderId(providerId) &&
      authStorage.get(providerId)?.type === "oauth"
    ) {
      authStorage.logout(providerId);
    }
  }
}

function cleanupPending(): void {
  const now = Date.now();
  for (const [providerId, pending] of pendingByProvider.entries()) {
    if (now - pending.createdAt > PENDING_TTL_MS) {
      pending.rejectManual?.(new Error("OAuth flow expired."));
      pendingByProvider.delete(providerId);
    }
  }
}

export function buildPiAgentOAuthCallbackUrl(publicOrigin: string): string {
  return `${publicOrigin.replace(/\/$/, "")}/api/settings/pi-agent/oauth/callback`;
}

async function ensureAuthStorageUnlocked(): Promise<void> {
  const authPath = getPiAgentAuthPath();
  const lockPath = `${authPath}.lock`;
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs > AUTH_LOCK_STALE_MS) {
      await fs.unlink(lockPath).catch(() => undefined);
    }
  } catch {
    // No lock file — expected.
  }
}

function cancelPending(providerId: string): void {
  const pending = pendingByProvider.get(providerId);
  if (!pending) {
    return;
  }
  pending.rejectManual?.(new Error("OAuth flow replaced by a new login attempt."));
  pendingByProvider.delete(providerId);
}

function resolveProviderAuthMethod(
  authStorage: Awaited<ReturnType<typeof createPiAuthStorage>>,
  providerId: string,
  settings: PiAgentSettingsPublic
): {
  configured: boolean;
  authMethod: PiAgentProviderAuthMethod;
  authLabel?: string;
  apiKeyLastFour?: string;
} {
  const storedCredential = authStorage.get(providerId);
  if (storedCredential?.type === "oauth") {
    return { configured: true, authMethod: "oauth", authLabel: "OAuth" };
  }
  if (storedCredential?.type === "api_key") {
    const lastFour = storedCredential.key.slice(-4);
    return {
      configured: true,
      authMethod: "api_key",
      authLabel: "Stored API key",
      apiKeyLastFour: lastFour,
    };
  }

  const storedKey = settings.providerKeys.find((key) => key.providerId === providerId);
  if (storedKey) {
    return {
      configured: true,
      authMethod: "api_key",
      authLabel: "Stored API key",
      apiKeyLastFour: storedKey.lastFour,
    };
  }

  const authStatus = authStorage.getAuthStatus(providerId);
  if (authStatus.configured) {
    return {
      configured: true,
      authMethod: authStatus.source === "environment" ? "env" : "api_key",
      authLabel: authStatus.label ?? authStatus.source ?? "Configured",
    };
  }
  if (authStatus.source === "environment") {
    return {
      configured: true,
      authMethod: "env",
      authLabel: authStatus.label ?? "Environment variable",
    };
  }

  return { configured: false, authMethod: null };
}

export async function getPiAgentSettingsResponse(): Promise<PiAgentSettingsResponse> {
  await ensureAuthStorageUnlocked();
  const [settings, authStorage, home, xaiConnected] = await Promise.all([
    getPiAgentSettingsPublic(),
    createPiAuthStorage(),
    describePiAgentHome(),
    hasXaiOAuthCredentials(),
  ]);
  await revokeBlockedSubscriptionOAuth(authStorage);
  await applyPiRuntimeApiKeys(authStorage);

  const { ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  const modelRegistry = ModelRegistry.create(authStorage, getPiAgentModelsPath());
  modelRegistry.refresh();

  const oauthById = new Map(
    authStorage
      .getOAuthProviders()
      .filter((provider) => isSubscriptionOAuthProviderId(provider.id))
      .map((provider) => [provider.id, provider])
  );
  const allModels = modelRegistry.getAll();
  const availableModels = modelRegistry.getAvailable();

  const providerIds = [
    ...new Set([
      ...PI_AGENT_MINIMUM_PROVIDER_IDS,
      ...allModels.map((model) => model.provider),
    ]),
  ].sort();

  const providers: PiAgentProviderStatus[] = providerIds.map((id) => {
    const oauthProvider = oauthById.get(id);
    const auth = resolveProviderAuthMethod(authStorage, id, settings);
    const modelCount = allModels.filter((model) => model.provider === id).length;
    const xaiOauth = id === XAI_OAUTH_PROVIDER_ID && xaiConnected;
    return {
      id,
      name:
        oauthProvider?.name ??
        modelRegistry.getProviderDisplayName(id) ??
        PROVIDER_LABELS[id] ??
        id,
      oauthSupported: isSubscriptionOAuthProviderId(id),
      usesCallbackServer: oauthProvider?.usesCallbackServer === true,
      authMethod: xaiOauth ? "oauth" : auth.authMethod,
      configured: xaiOauth || auth.configured,
      authLabel: xaiOauth ? "OAuth" : auth.authLabel,
      modelCount,
      modelsAvailable: availableModels.some((model) => model.provider === id),
      apiKeyLastFour: xaiOauth ? undefined : auth.apiKeyLastFour,
    };
  });

  return { settings, providers, home };
}

async function persistXaiCredentialToAuthStorage(
  authStorage: Awaited<ReturnType<typeof createPiAuthStorage>>,
  access: string,
  refresh: string,
  expires: number
): Promise<void> {
  authStorage.set(XAI_OAUTH_PROVIDER_ID, {
    type: "oauth",
    access,
    refresh,
    expires,
  });
  authStorage.setRuntimeApiKey(XAI_OAUTH_PROVIDER_ID, access);
}

async function startXaiSubscriptionOAuth(
  authStorage: Awaited<ReturnType<typeof createPiAuthStorage>>
): Promise<PiAgentOAuthStartResponse> {
  const providerId = XAI_OAUTH_PROVIDER_ID;
  cancelPending(providerId);

  const device = await requestXaiDeviceCode();
  const verificationUri = device.verification_uri_complete ?? device.verification_uri;

  let rejectLogin: ((error: Error) => void) | undefined;
  const loginPromise = new Promise<void>((resolve, reject) => {
    rejectLogin = reject;
    void pollXaiDeviceCodeToken(device)
      .then(async (tokens) => {
        const stored = await persistXaiTokenResponse(tokens);
        await persistXaiCredentialToAuthStorage(
          authStorage,
          stored.access,
          stored.refresh,
          stored.expires
        );
        resolve();
      })
      .catch((error) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        reject(normalized);
      });
  })
    .then(() => {
      pendingByProvider.delete(providerId);
    })
    .catch((error) => {
      pendingByProvider.delete(providerId);
      throw error;
    });

  pendingByProvider.set(providerId, {
    providerId,
    createdAt: Date.now(),
    rejectManual: (error) => rejectLogin?.(error),
    loginPromise,
  });

  void loginPromise.catch(() => undefined);
  const session = await createOAuthCoordinatorSession({
    kind: "pi-agent",
    label: PROVIDER_LABELS[providerId] ?? providerId,
    payload: { providerId, flow: "device-code" },
  });
  void loginPromise
    .then(() => updateOAuthCoordinatorSession(session.id, { status: "complete" }))
    .catch((error) =>
      updateOAuthCoordinatorSession(session.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      })
    );
  return {
    providerId,
    userCode: device.user_code,
    verificationUri,
    instructions: `Open ${device.verification_uri} and enter code ${device.user_code}`,
    sessionId: session.id,
  };
}

export async function startPiAgentOAuth(input: {
  providerId: string;
  publicOrigin: string;
}): Promise<PiAgentOAuthStartResponse> {
  cleanupPending();
  const providerId = normalizeProviderId(input.providerId);
  assertSupportedProviderId(providerId);

  await ensureAuthStorageUnlocked();
  const authStorage = await createPiAuthStorage();
  await revokeBlockedSubscriptionOAuth(authStorage);
  await applyPiRuntimeApiKeys(authStorage);

  if (providerId === XAI_OAUTH_PROVIDER_ID) {
    return startXaiSubscriptionOAuth(authStorage);
  }

  const oauthProvider = authStorage
    .getOAuthProviders()
    .find((provider) => provider.id === providerId);
  if (!oauthProvider) {
    throw new Error(`Provider "${providerId}" does not support OAuth. Use an API key instead.`);
  }

  cancelPending(providerId);

  let resolveInitial:
    | ((response: PiAgentOAuthStartResponse) => void)
    | undefined;
  let rejectInitial: ((error: Error) => void) | undefined;

  const initialPromise = new Promise<PiAgentOAuthStartResponse>((resolve, reject) => {
    resolveInitial = resolve;
    rejectInitial = reject;
    setTimeout(() => {
      reject(new Error("Timed out waiting for OAuth provider to start."));
    }, OAUTH_START_TIMEOUT_MS);
  });

  let manualResolve: ((redirect: string) => void) | undefined;
  let manualReject: ((error: Error) => void) | undefined;

  const loginPromise = authStorage
    .login(providerId as string, {
      onAuth: (info) => {
        resolveInitial?.({
          providerId,
          authUrl: info.url,
          instructions: info.instructions,
          callbackUrl: buildPiAgentOAuthCallbackUrl(input.publicOrigin),
        });
        resolveInitial = undefined;
        rejectInitial = undefined;
      },
      onDeviceCode: (info) => {
        resolveInitial?.({
          providerId,
          userCode: info.userCode,
          verificationUri: info.verificationUri,
        });
        resolveInitial = undefined;
        rejectInitial = undefined;
      },
      onPrompt: async () => "",
      onSelect: async () => undefined,
      onManualCodeInput: () =>
        new Promise<string>((resolve, reject) => {
          manualResolve = resolve;
          manualReject = reject;
        }),
    })
    .then(() => {
      pendingByProvider.delete(providerId);
    })
    .catch((error) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      rejectInitial?.(normalized);
      manualReject?.(normalized);
      pendingByProvider.delete(providerId);
      throw normalized;
    });

  pendingByProvider.set(providerId, {
    providerId,
    createdAt: Date.now(),
    resolveManual: (redirect) => manualResolve?.(redirect),
    rejectManual: (error) => manualReject?.(error),
    loginPromise,
  });

  try {
    const initial = await initialPromise;
    const session = await createOAuthCoordinatorSession({
      kind: "pi-agent",
      label: PROVIDER_LABELS[providerId] ?? providerId,
      payload: { providerId, flow: initial.authUrl ? "redirect" : "device-code" },
    });
    void loginPromise
      .then(() => updateOAuthCoordinatorSession(session.id, { status: "complete" }))
      .catch((error) =>
        updateOAuthCoordinatorSession(session.id, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        })
      );
    void loginPromise.catch(() => undefined);
    return { ...initial, sessionId: session.id };
  } catch (error) {
    cancelPending(providerId);
    throw error;
  }
}

export async function completePiAgentOAuthCallback(input: {
  providerId?: string;
  redirect?: string;
  code?: string;
  state?: string;
}): Promise<{ providerId: string }> {
  cleanupPending();

  const providerId = input.providerId?.trim().toLowerCase();
  const pending = providerId
    ? pendingByProvider.get(providerId)
    : [...pendingByProvider.values()].at(-1);
  if (!pending) {
    throw new Error("OAuth flow is invalid or expired.");
  }

  let redirect = input.redirect?.trim();
  if (!redirect && input.code?.trim()) {
    const params = new URLSearchParams();
    params.set("code", input.code.trim());
    if (input.state?.trim()) {
      params.set("state", input.state.trim());
    }
    redirect = `http://localhost/callback?${params.toString()}`;
  }
  if (!redirect) {
    throw new Error("Missing redirect URL or authorization code.");
  }

  pending.resolveManual?.(redirect);
  await pending.loginPromise;
  pendingByProvider.delete(pending.providerId);
  return { providerId: pending.providerId };
}

export async function disconnectPiAgentOAuth(providerIdInput: string): Promise<PiAgentSettingsResponse> {
  const providerId = normalizeProviderId(providerIdInput);
  assertSupportedProviderId(providerId);

  cancelPending(providerId);
  await ensureAuthStorageUnlocked();

  const authStorage = await createPiAuthStorage();
  authStorage.logout(providerId);
  authStorage.removeRuntimeApiKey(providerId);
  if (providerId === XAI_OAUTH_PROVIDER_ID) {
    await clearXaiOAuthCredentials();
  }

  const settings = await getPiAgentSettings();
  const storedKey = settings.providerKeys.find((key) => key.providerId === providerId);
  if (storedKey) {
    await deletePiAgentProviderKey(storedKey.id);
  }

  return getPiAgentSettingsResponse();
}

export async function waitForPiAgentOAuthCompletion(
  providerIdInput: string,
  timeoutMs = 120_000
): Promise<boolean> {
  const providerId = normalizeProviderId(providerIdInput);
  const pending = pendingByProvider.get(providerId);
  if (!pending) {
    return false;
  }
  const result = await Promise.race([
    pending.loginPromise.then(() => true).catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  return result;
}

export function piAgentOAuthSuccessHtml(providerLabel: string, sessionId?: string): string {
  return oauthCompletionHtml({
    title: "Pi Agent connected",
    heading: "Connected",
    message: `${providerLabel} is authenticated.`,
    postMessageType: "opencursor-pi-agent-oauth",
    sessionId,
    kind: "pi-agent",
    ok: true,
  });
}

export function piAgentOAuthFailureHtml(message: string, sessionId?: string): string {
  return oauthCompletionHtml({
    title: "Pi Agent OAuth failed",
    heading: "Authentication failed",
    message,
    postMessageType: "opencursor-pi-agent-oauth",
    sessionId,
    kind: "pi-agent",
    ok: false,
  });
}

export function providerLabelForId(providerId: string): string {
  return PROVIDER_LABELS[providerId] ?? providerId;
}
