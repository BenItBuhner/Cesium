/**
 * OAuth subscription accounts for the first-party Cesium harness.
 *
 * Reuses the shared Pi SDK auth storage (auth.json) so a single OAuth login
 * (ChatGPT/Codex, Anthropic Claude Pro/Max, GitHub Copilot, Google providers
 * registered by Pi extensions) serves both the Pi harness and the Cesium
 * harness. Tokens are auto-refreshed with file locking by the SDK.
 *
 * The bridge exposes three capabilities:
 *   1. Provider status list for Settings → Agents → Cesium Agent.
 *   2. Catalog entries so OAuth-only providers (openai-codex, github-copilot,
 *      Google CLIs) surface their models in the Cesium model picker.
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
  /** OAuth provider id, e.g. "openai-codex" | "anthropic" | "github-copilot". */
  providerId: string;
  /** Refreshed access token (or exchanged Copilot bearer). */
  apiKey: string;
  /** Provider/model request headers (Copilot editor headers, etc.). */
  headers?: Record<string, string>;
  baseUrl?: string;
};

const PROVIDER_LABELS: Record<string, string> = {
  "openai-codex": "ChatGPT (Codex subscription)",
  anthropic: "Anthropic (Claude Pro/Max)",
  "github-copilot": "GitHub Copilot",
  "google-antigravity": "Google Antigravity",
  "google-gemini-cli": "Google Gemini CLI",
};

const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  "openai-codex":
    "Sign in with your ChatGPT Plus/Pro account to run Codex models over the ChatGPT backend.",
  anthropic:
    "Sign in with a Claude Pro/Max subscription. Applies to anthropic/* models when no API key is saved.",
  "github-copilot":
    "Device-code sign-in with GitHub. Copilot serves OpenAI, Anthropic, and Google models.",
  "google-antigravity": "Google OAuth via the Pi Antigravity provider package.",
  "google-gemini-cli": "Google OAuth via the Pi Gemini CLI provider package.",
};

/** Curated ordering; unknown OAuth providers registered by extensions sort after. */
const PROVIDER_ORDER = [
  "openai-codex",
  "anthropic",
  "github-copilot",
  "google-antigravity",
  "google-gemini-cli",
];

/**
 * Anthropic OAuth reuses the models.dev `anthropic/*` catalog entries, so it
 * contributes no additional catalog rows of its own.
 */
const CATALOG_EXCLUDED_PROVIDERS = new Set(["anthropic"]);

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

function providerSortKey(id: string): number {
  const index = PROVIDER_ORDER.indexOf(id);
  return index === -1 ? PROVIDER_ORDER.length : index;
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
  const registry = await createModelRegistry(authStorage);
  const oauthProviders = authStorage.getOAuthProviders();
  const allModels = registry.getAll() as unknown as PiModel[];

  const connectedIds: string[] = [];
  const statuses: CesiumOAuthProviderStatus[] = [];
  const catalogEntries: CesiumModelCatalogEntry[] = [];

  const providerIds = [
    ...new Set([...PROVIDER_ORDER, ...oauthProviders.map((provider) => provider.id)]),
  ].sort((a, b) => providerSortKey(a) - providerSortKey(b) || a.localeCompare(b));

  for (const providerId of providerIds) {
    const oauthProvider = oauthProviders.find((provider) => provider.id === providerId);
    const connected = authStorage.get(providerId)?.type === "oauth";
    const providerModels = allModels.filter((model) => model.provider === providerId);
    if (connected) {
      connectedIds.push(providerId);
    }
    statuses.push({
      id: providerId,
      name: oauthProvider?.name ?? cesiumOAuthProviderLabel(providerId),
      connected,
      oauthSupported: oauthProvider != null,
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

/** Catalog rows for connected OAuth-only providers (Codex, Copilot, Google CLIs). */
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
  invalidateCesiumOAuthCache();
  return startPiAgentOAuth(input);
}

/** Remove the OAuth credential only; stored API keys are left untouched. */
export async function disconnectCesiumOAuth(providerId: string): Promise<void> {
  const normalized = providerId.trim().toLowerCase();
  const authStorage = await createPiAuthStorage();
  const credential = authStorage.get(normalized);
  if (credential?.type === "oauth") {
    authStorage.logout(normalized);
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
