/**
 * OAuth subscription accounts for the first-party Cesium harness.
 *
 * Only vendors that officially allow third-party harnesses to use a paid
 * subscription are offered: ChatGPT/Codex and SpaceXAI SuperGrok. Unofficial
 * Claude Pro/Max, Copilot editor, and Google CLI logins are stripped and never
 * used for inference.
 *
 * OpenAI tokens live in the shared Pi auth.json. SpaceXAI tokens live in
 * profile/xai-oauth.json and are mirrored into auth.json as a runtime key so
 * the Pi harness can use the same SuperGrok login.
 *
 * The bridge exposes three capabilities:
 *   1. Provider status list for Settings → Agents → Cesium Agent.
 *   2. Catalog entries so the ChatGPT/Codex OAuth account surfaces its models.
 *   3. Request auth resolution (refreshed access token + provider headers +
 *      base URL) consumed by resolveCesiumAuth when no API key exists.
 */
import { formatCatalogModelLabel } from "@cesium/core/model-display-name";
import {
  createPiAuthStorage,
  getPiAgentModelsPath,
} from "./pi-agent-settings.js";
import {
  startPiAgentOAuth,
  type PiAgentOAuthStartResponse,
} from "./pi-agent-oauth.js";
import {
  isBlockedSubscriptionOAuthProviderId,
  isSubscriptionOAuthProviderId,
  SUBSCRIPTION_OAUTH_DESCRIPTIONS,
  SUBSCRIPTION_OAUTH_LABELS,
  SUBSCRIPTION_OAUTH_PROVIDER_IDS,
} from "./subscription-oauth.js";
import {
  clearXaiOAuthCredentials,
  getValidXaiAccessToken,
  hasXaiOAuthCredentials,
  XAI_OAUTH_BASE_URL,
  XAI_OAUTH_PROVIDER_ID,
} from "./xai-oauth.js";
import type { CesiumModelCatalogEntry, CesiumProviderKind } from "./cesium-agent-settings.js";

export type CesiumOAuthProviderStatus = {
  id: string;
  name: string;
  connected: boolean;
  oauthSupported: boolean;
  usesCallbackServer?: boolean;
  modelCount: number;
  description?: string;
};

export type CesiumOAuthRequestAuth = {
  /** OAuth provider id, e.g. "openai-codex" | "xai". */
  providerId: string;
  /** Refreshed access token (or exchanged Copilot bearer). */
  apiKey: string;
  /** Provider/model request headers (Copilot editor headers, etc.). */
  headers?: Record<string, string>;
  baseUrl?: string;
};

const PROVIDER_LABELS: Record<string, string> = {
  ...SUBSCRIPTION_OAUTH_LABELS,
};

const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  ...SUBSCRIPTION_OAUTH_DESCRIPTIONS,
};

/** Official subscription logins only. Unknown Pi extensions are not listed. */
const PROVIDER_ORDER = [...SUBSCRIPTION_OAUTH_PROVIDER_IDS];

/**
 * SuperGrok reuses models.dev `xai/*` catalog rows. Codex is OAuth-only and
 * still contributes its own catalog entries.
 */
const CATALOG_EXCLUDED_PROVIDERS = new Set([XAI_OAUTH_PROVIDER_ID]);

type PiModel = {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
};

type OAuthSnapshot = {
  createdAt: number;
  statuses: CesiumOAuthProviderStatus[];
  connectedIds: string[];
  catalogEntries: CesiumModelCatalogEntry[];
};

const SNAPSHOT_TTL_MS = 15_000;
let snapshotCache: OAuthSnapshot | null = null;
let snapshotPromise: Promise<OAuthSnapshot> | null = null;

export function invalidateCesiumOAuthCache(): void {
  snapshotCache = null;
  snapshotPromise = null;
}

export function cesiumOAuthProviderLabel(providerId: string): string {
  return PROVIDER_LABELS[providerId] ?? providerId;
}

function mapPiApiToCesiumKind(api: string): CesiumProviderKind | null {
  switch (api) {
    case "openai-codex-responses":
    case "azure-openai-responses":
    case "openai-responses":
      return "openai-responses";
    case "openai-completions":
      return "openai-chat-completions";
    case "anthropic-messages":
      return "anthropic";
    case "google-generative-ai":
    case "google-genai":
      return "google-genai";
    default:
      return null;
  }
}

function catalogEntryFromPiModel(
  model: PiModel,
  providerName: string
): CesiumModelCatalogEntry | null {
  const apiKind = mapPiApiToCesiumKind(model.api);
  if (!apiKind) {
    return null;
  }
  const modelId = `${model.provider}/${model.id}`;
  return {
    providerId: model.provider,
    providerName,
    providerApiBaseUrl: model.baseUrl,
    modelId,
    modelName: formatCatalogModelLabel(providerName, model.name, modelId),
    apiKind,
    supportsTools: true,
    supportsReasoning: model.reasoning === true,
    supportsStructuredOutput: false,
    supportsImages: Array.isArray(model.input) && model.input.includes("image"),
    contextWindow: model.contextWindow,
    outputLimit: model.maxTokens,
  };
}

async function createModelRegistry(
  authStorage: Awaited<ReturnType<typeof createPiAuthStorage>>
): Promise<import("@earendil-works/pi-coding-agent").ModelRegistry> {
  const { ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  const registry = ModelRegistry.create(authStorage, getPiAgentModelsPath());
  registry.refresh();
  return registry;
}

async function buildSnapshot(): Promise<OAuthSnapshot> {
  const authStorage = await createPiAuthStorage();
  for (const providerId of authStorage.list()) {
    if (
      isBlockedSubscriptionOAuthProviderId(providerId) &&
      authStorage.get(providerId)?.type === "oauth"
    ) {
      authStorage.logout(providerId);
    }
  }
  const registry = await createModelRegistry(authStorage);
  const oauthProviders = authStorage
    .getOAuthProviders()
    .filter((provider) => isSubscriptionOAuthProviderId(provider.id));
  const allModels = registry.getAll() as unknown as PiModel[];
  const xaiConnected = await hasXaiOAuthCredentials();

  const connectedIds: string[] = [];
  const statuses: CesiumOAuthProviderStatus[] = [];
  const catalogEntries: CesiumModelCatalogEntry[] = [];

  const providerIds = [...PROVIDER_ORDER];

  for (const providerId of providerIds) {
    const oauthProvider = oauthProviders.find((provider) => provider.id === providerId);
    const connected =
      providerId === XAI_OAUTH_PROVIDER_ID
        ? xaiConnected
        : authStorage.get(providerId)?.type === "oauth";
    const providerModels = allModels.filter((model) => model.provider === providerId);
    if (connected) {
      connectedIds.push(providerId);
    }
    statuses.push({
      id: providerId,
      name: oauthProvider?.name ?? cesiumOAuthProviderLabel(providerId),
      connected,
      oauthSupported: true,
      usesCallbackServer: oauthProvider?.usesCallbackServer,
      modelCount: providerModels.length,
      description: PROVIDER_DESCRIPTIONS[providerId],
    });
    if (connected && !CATALOG_EXCLUDED_PROVIDERS.has(providerId)) {
      const providerName =
        registry.getProviderDisplayName(providerId) ?? cesiumOAuthProviderLabel(providerId);
      for (const model of providerModels) {
        const entry = catalogEntryFromPiModel(model, providerName);
        if (entry) {
          catalogEntries.push(entry);
        }
      }
    }
  }

  return {
    createdAt: Date.now(),
    statuses,
    connectedIds,
    catalogEntries,
  };
}

async function getSnapshot(): Promise<OAuthSnapshot> {
  if (snapshotCache && Date.now() - snapshotCache.createdAt < SNAPSHOT_TTL_MS) {
    return snapshotCache;
  }
  if (!snapshotPromise) {
    snapshotPromise = buildSnapshot()
      .then((snapshot) => {
        snapshotCache = snapshot;
        return snapshot;
      })
      .finally(() => {
        snapshotPromise = null;
      });
  }
  return snapshotPromise;
}

export async function listCesiumOAuthProviders(): Promise<CesiumOAuthProviderStatus[]> {
  try {
    return (await getSnapshot()).statuses;
  } catch {
    return [];
  }
}

export async function getCesiumOAuthConnectedProviderIds(): Promise<string[]> {
  try {
    return (await getSnapshot()).connectedIds;
  } catch {
    return [];
  }
}

/** Catalog rows for connected OAuth-only providers (ChatGPT/Codex). */
export async function getCesiumOAuthCatalogEntries(): Promise<CesiumModelCatalogEntry[]> {
  try {
    return (await getSnapshot()).catalogEntries;
  } catch {
    return [];
  }
}

/** Start an OAuth login for a Cesium provider. Shares the Pi flow + callback. */
export async function startCesiumOAuth(input: {
  providerId: string;
  publicOrigin: string;
}): Promise<PiAgentOAuthStartResponse> {
  const providerId = input.providerId.trim().toLowerCase();
  if (!isSubscriptionOAuthProviderId(providerId)) {
    throw new Error(
      `Unsupported subscription OAuth provider: ${providerId}. Only ChatGPT/Codex and SpaceXAI SuperGrok are offered.`
    );
  }
  invalidateCesiumOAuthCache();
  return startPiAgentOAuth({ ...input, providerId });
}

/** Remove the OAuth credential only; stored API keys are left untouched. */
export async function disconnectCesiumOAuth(providerId: string): Promise<void> {
  const normalized = providerId.trim().toLowerCase();
  if (!isSubscriptionOAuthProviderId(normalized)) {
    throw new Error(`Unsupported subscription OAuth provider: ${normalized}.`);
  }
  const authStorage = await createPiAuthStorage();
  const credential = authStorage.get(normalized);
  if (credential?.type === "oauth") {
    authStorage.logout(normalized);
  }
  authStorage.removeRuntimeApiKey(normalized);
  if (normalized === XAI_OAUTH_PROVIDER_ID) {
    await clearXaiOAuthCredentials();
  }
  invalidateCesiumOAuthCache();
}

/**
 * Resolve request auth for an OAuth-backed model turn.
 *
 * Returns null when the provider has no OAuth credential, so callers can fall
 * through to their API-key error paths.
 */
export async function resolveCesiumOAuthRequestAuth(input: {
  providerId: string;
  modelId?: string;
}): Promise<CesiumOAuthRequestAuth | null> {
  const providerId = input.providerId.trim().toLowerCase();
  if (!isSubscriptionOAuthProviderId(providerId)) {
    return null;
  }
  if (providerId === XAI_OAUTH_PROVIDER_ID) {
    const apiKey = await getValidXaiAccessToken();
    if (!apiKey) {
      return null;
    }
    return {
      providerId,
      apiKey,
      baseUrl: XAI_OAUTH_BASE_URL,
    };
  }
  const authStorage = await createPiAuthStorage();
  if (authStorage.get(providerId)?.type !== "oauth") {
    return null;
  }
  const registry = await createModelRegistry(authStorage);
  const localModelId = input.modelId?.includes("/")
    ? input.modelId.split("/").slice(1).join("/")
    : input.modelId;
  const model = localModelId
    ? (registry.find(providerId, localModelId) as unknown as PiModel | undefined)
    : undefined;
  if (model) {
    const auth = await registry.getApiKeyAndHeaders(model as never);
    if (!auth.ok || !auth.apiKey) {
      throw new Error(
        `OAuth credential for ${cesiumOAuthProviderLabel(providerId)} could not be refreshed. ` +
          "Reconnect it in Settings → Agents → Cesium Agent."
      );
    }
    return {
      providerId,
      apiKey: auth.apiKey,
      headers: auth.headers,
      baseUrl: model.baseUrl,
    };
  }
  // Model not in the Pi registry (e.g. anthropic models.dev ids). Token only.
  const apiKey = await authStorage.getApiKey(providerId, { includeFallback: false });
  if (!apiKey) {
    throw new Error(
      `OAuth credential for ${cesiumOAuthProviderLabel(providerId)} could not be refreshed. ` +
        "Reconnect it in Settings → Agents → Cesium Agent."
    );
  }
  return { providerId, apiKey };
}
