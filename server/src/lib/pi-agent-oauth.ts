import { promises as fs } from "node:fs";
import {
  applyPiRuntimeApiKeys,
  createPiAuthStorage,
  deletePiAgentProviderKey,
  getPiAgentAuthPath,
  getPiAgentModelsPath,
  getPiAgentSettings,
  getPiAgentSettingsPublic,
  type PiAgentSettingsPublic,
} from "./pi-agent-settings.js";

export const PI_AGENT_MINIMUM_PROVIDER_IDS = [
  "openai-codex",
  "anthropic",
  "github-copilot",
  "google-antigravity",
  "google-gemini-cli",
] as const;

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
};

export type PiAgentOAuthStartResponse = {
  providerId: string;
  authUrl?: string;
  deviceCode?: string;
  userCode?: string;
  verificationUri?: string;
  instructions?: string;
  callbackUrl?: string;
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
  "openai-codex": "ChatGPT Plus/Pro (Codex)",
  anthropic: "Anthropic (Claude Pro/Max)",
  "github-copilot": "GitHub Copilot",
  "google-antigravity": "Google Antigravity",
  "google-gemini-cli": "Google Gemini CLI",
};

function normalizeProviderId(providerId: string): string {
  return providerId.trim().toLowerCase();
}

function assertSupportedProviderId(providerId: string): void {
  if (!PI_AGENT_MINIMUM_PROVIDER_IDS.includes(providerId as PiAgentMinimumProviderId)) {
    throw new Error(`Unsupported Pi Agent provider: ${providerId}`);
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
  const [settings, authStorage] = await Promise.all([
    getPiAgentSettingsPublic(),
    createPiAuthStorage(),
  ]);
  await applyPiRuntimeApiKeys(authStorage);

  const { ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  const modelRegistry = ModelRegistry.create(authStorage, getPiAgentModelsPath());
  modelRegistry.refresh();

  const oauthById = new Map(
    authStorage.getOAuthProviders().map((provider) => [provider.id, provider])
  );
  const allModels = modelRegistry.getAll();
  const availableModels = modelRegistry.getAvailable();

  const providerIds = [
    ...new Set([
      ...PI_AGENT_MINIMUM_PROVIDER_IDS,
      ...oauthById.keys(),
      ...allModels.map((model) => model.provider),
    ]),
  ].sort();

  const providers: PiAgentProviderStatus[] = providerIds.map((id) => {
    const oauthProvider = oauthById.get(id);
    const auth = resolveProviderAuthMethod(authStorage, id, settings);
    const modelCount = allModels.filter((model) => model.provider === id).length;
    return {
      id,
      name:
        oauthProvider?.name ??
        modelRegistry.getProviderDisplayName(id) ??
        PROVIDER_LABELS[id] ??
        id,
      oauthSupported: oauthById.has(id),
      usesCallbackServer: oauthProvider?.usesCallbackServer,
      authMethod: auth.authMethod,
      configured: auth.configured,
      authLabel: auth.authLabel,
      modelCount,
      modelsAvailable: availableModels.some((model) => model.provider === id),
      apiKeyLastFour: auth.apiKeyLastFour,
    };
  });

  return { settings, providers };
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
  await applyPiRuntimeApiKeys(authStorage);

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
    void loginPromise.catch(() => undefined);
    return initial;
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

export function piAgentOAuthSuccessHtml(providerLabel: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pi Agent connected</title></head><body style="font-family:system-ui;padding:2rem;"><h1>Connected</h1><p>${providerLabel} is authenticated. You can close this window and return to OpenCursor.</p><script>if(window.opener){window.opener.postMessage({type:"opencursor-pi-agent-oauth",ok:true}, "*");}</script></body></html>`;
}

export function piAgentOAuthFailureHtml(message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pi Agent OAuth failed</title></head><body style="font-family:system-ui;padding:2rem;"><h1>Authentication failed</h1><p>${message}</p></body></html>`;
}

export function providerLabelForId(providerId: string): string {
  return PROVIDER_LABELS[providerId] ?? providerId;
}
