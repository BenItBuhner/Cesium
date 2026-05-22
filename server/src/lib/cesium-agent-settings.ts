import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DATA_DIR,
  readJsonFile,
  writeJsonFile,
} from "./persistence.js";
import type { AgentConfigOption } from "./agents/types.js";

export type CesiumProviderKind =
  | "openai-chat-completions"
  | "openai-responses"
  | "openai-realtime"
  | "anthropic"
  | "google-genai"
  | "openai-compatible";

export type CesiumProviderKeySource = "env" | "stored";

export type CesiumProviderKey = {
  id: string;
  providerId: string;
  label: string;
  apiKind: CesiumProviderKind;
  apiKey: string;
  baseUrl?: string;
  source: "stored";
  createdAt: number;
  updatedAt: number;
};

export type CesiumCustomProvider = {
  id: string;
  name: string;
  apiKind: CesiumProviderKind;
  baseUrl?: string;
  models: Array<{
    id: string;
    name: string;
    contextWindow?: number;
    supportsTools?: boolean;
    supportsReasoning?: boolean;
  }>;
};

export type CesiumAgentSettings = {
  schemaVersion: 1;
  updatedAt: number;
  defaultProviderKeyId: string | null;
  defaultModelId: string;
  defaultApiKind: CesiumProviderKind;
  compression: {
    enabled: boolean;
    modelId: string | null;
    thresholdRatio: number;
  };
  toolPermissions: {
    editFile: "ask" | "allow" | "deny";
    terminal: "ask" | "allow" | "deny";
    mcpCall: "ask" | "allow" | "deny";
  };
  providerKeys: CesiumProviderKey[];
  customProviders: CesiumCustomProvider[];
};

export type CesiumProviderKeyStatus = Omit<CesiumProviderKey, "apiKey" | "source"> & {
  source: CesiumProviderKeySource;
  lastFour?: string;
};

export type CesiumAgentSettingsPublic = Omit<CesiumAgentSettings, "providerKeys"> & {
  configured: boolean;
  providerKeys: CesiumProviderKeyStatus[];
};

export type CesiumModelCatalogEntry = {
  providerId: string;
  providerName: string;
  providerApiBaseUrl?: string;
  providerDocUrl?: string;
  modelId: string;
  modelName: string;
  apiKind: CesiumProviderKind;
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsStructuredOutput: boolean;
  contextWindow?: number;
  outputLimit?: number;
};

type PersistedModelsDevCache = {
  schemaVersion: 1;
  updatedAt: number;
  entries: CesiumModelCatalogEntry[];
};

const SETTINGS_FILE = path.join(DATA_DIR, "profile", "cesium-agent-settings.json");
const CATALOG_CACHE_FILE = path.join(DATA_DIR, "profile", "cesium-agent-models-dev-cache.json");
const MODELS_DEV_URL = "https://models.dev/api.json";
const CROFAI_MODELS_URL = "https://crof.ai/v1/models";
const CATALOG_TTL_MS = 1000 * 60 * 60 * 12;
const CROFAI_PROVIDER_ID = "crofai";
const CROFAI_PROVIDER_NAME = "CrofAI";
const CROFAI_BASE_URL = "https://crof.ai/v1";

const BUILTIN_PROVIDER_KINDS: Record<string, CesiumProviderKind> = {
  openai: "openai-responses",
  anthropic: "anthropic",
  google: "google-genai",
};

const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** Known third-party API roots when models.dev cache is stale or missing an entry. */
const BUILTIN_PROVIDER_BASE_URLS: Record<string, string> = {
  nvidia: "https://integrate.api.nvidia.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  togetherai: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  firepass: "https://api.fireworks.ai/inference/v1",
  deepseek: "https://api.deepseek.com/v1",
  mistral: "https://api.mistral.ai/v1",
  xai: "https://api.x.ai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  [CROFAI_PROVIDER_ID]: CROFAI_BASE_URL,
};

type ApiKeyProviderHint = {
  providerId: string;
  label: string;
  test: (apiKey: string) => boolean;
};

/** Unambiguous key prefixes only. `csk-` is shared by Cerebras and Cursor — never infer from it. */
const API_KEY_PROVIDER_HINTS: ApiKeyProviderHint[] = [
  {
    providerId: "nvidia",
    label: "Nvidia NIM",
    test: (apiKey) => apiKey.startsWith("nvapi-"),
  },
  {
    providerId: "anthropic",
    label: "Anthropic",
    test: (apiKey) => apiKey.startsWith("sk-ant-"),
  },
  {
    providerId: "openai",
    label: "OpenAI",
    test: (apiKey) => /^sk-(?!ant-)/.test(apiKey) || apiKey.startsWith("sk-proj-"),
  },
  {
    providerId: "google",
    label: "Google",
    test: (apiKey) => apiKey.startsWith("AIza"),
  },
];

function normalizeProviderId(providerId: string): string {
  return providerId.trim().toLowerCase();
}

function inferProviderIdFromApiKey(apiKey: string): string | undefined {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return undefined;
  }
  return API_KEY_PROVIDER_HINTS.find((hint) => hint.test(trimmed))?.providerId;
}

function providerLabelFromId(providerId: string): string {
  return providerId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function providerKeyLookupIds(providerId: string): string[] {
  const normalized = normalizeProviderId(providerId);
  const ids = [normalized];
  if (normalized.startsWith("custom-")) {
    ids.push(normalized.slice("custom-".length));
  }
  return [...new Set(ids.filter(Boolean))];
}

function formatApiKeyMismatchError(apiKey: string, expectedProviderId: string): string {
  const inferred = inferProviderIdFromApiKey(apiKey);
  const expected = normalizeProviderId(expectedProviderId);
  if (!inferred || inferred === expected) {
    return `No API key configured for ${providerLabelFromId(expected)}.`;
  }
  return (
    `This API key is for ${providerLabelFromId(inferred)}, but the selected model uses ${providerLabelFromId(expected)}. ` +
    "Pick a matching model or save the key under the correct provider."
  );
}

function assertApiKeyMatchesProvider(apiKey: string, providerId: string): void {
  const inferred = inferProviderIdFromApiKey(apiKey);
  const expected = normalizeProviderId(providerId);
  if (inferred && inferred !== expected) {
    throw new Error(formatApiKeyMismatchError(apiKey, expected));
  }
}

const BUILTIN_ENV_KEYS: Array<{
  providerId: string;
  label: string;
  apiKind: CesiumProviderKind;
  env: string;
}> = [
  {
    providerId: "openai",
    label: "OPENAI_API_KEY",
    apiKind: "openai-responses",
    env: "OPENAI_API_KEY",
  },
  {
    providerId: "anthropic",
    label: "ANTHROPIC_API_KEY",
    apiKind: "anthropic",
    env: "ANTHROPIC_API_KEY",
  },
  {
    providerId: "google",
    label: "GOOGLE_API_KEY",
    apiKind: "google-genai",
    env: "GOOGLE_API_KEY",
  },
];

function defaultSettings(): CesiumAgentSettings {
  return {
    schemaVersion: 1,
    updatedAt: 0,
    defaultProviderKeyId: null,
    defaultModelId: "openai/gpt-5.1",
    defaultApiKind: "openai-responses",
    compression: {
      enabled: true,
      modelId: null,
      thresholdRatio: 0.82,
    },
    toolPermissions: {
      editFile: "ask",
      terminal: "ask",
      mcpCall: "ask",
    },
    providerKeys: [],
    customProviders: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isProviderKind(value: unknown): value is CesiumProviderKind {
  return (
    value === "openai-chat-completions" ||
    value === "openai-responses" ||
    value === "openai-realtime" ||
    value === "anthropic" ||
    value === "google-genai" ||
    value === "openai-compatible"
  );
}

function normalizeProviderKey(raw: unknown): CesiumProviderKey | null {
  const record = asRecord(raw);
  const apiKey = asString(record?.apiKey);
  const providerId = asString(record?.providerId);
  const apiKind = record && isProviderKind(record.apiKind) ? record.apiKind : undefined;
  if (!record || !apiKey || !providerId || !apiKind) {
    return null;
  }
  const now = Date.now();
  return {
    id: asString(record.id) ?? randomUUID(),
    providerId,
    label: asString(record.label) ?? providerId,
    apiKind,
    apiKey,
    baseUrl: asString(record.baseUrl),
    source: "stored",
    createdAt: asNumber(record.createdAt) ?? now,
    updatedAt: asNumber(record.updatedAt) ?? now,
  };
}

function normalizeCustomProvider(raw: unknown): CesiumCustomProvider | null {
  const record = asRecord(raw);
  const id = asString(record?.id);
  const name = asString(record?.name);
  const apiKind = record && isProviderKind(record.apiKind) ? record.apiKind : undefined;
  if (!record || !id || !name || !apiKind) {
    return null;
  }
  const models = Array.isArray(record.models)
    ? record.models.flatMap((entry): CesiumCustomProvider["models"] => {
        const model = asRecord(entry);
        const modelId = asString(model?.id);
        if (!model || !modelId) {
          return [];
        }
        return [
          {
            id: modelId,
            name: asString(model.name) ?? modelId,
            contextWindow: asNumber(model.contextWindow),
            supportsTools:
              typeof model.supportsTools === "boolean" ? model.supportsTools : undefined,
            supportsReasoning:
              typeof model.supportsReasoning === "boolean"
                ? model.supportsReasoning
                : undefined,
          },
        ];
      })
    : [];
  return {
    id,
    name,
    apiKind,
    baseUrl: asString(record.baseUrl),
    models,
  };
}

function normalizeSettings(raw: unknown): CesiumAgentSettings {
  const defaults = defaultSettings();
  const record = asRecord(raw);
  if (!record || record.schemaVersion !== 1) {
    return defaults;
  }
  const compression = asRecord(record.compression);
  const toolPermissions = asRecord(record.toolPermissions);
  return {
    schemaVersion: 1,
    updatedAt: asNumber(record.updatedAt) ?? defaults.updatedAt,
    defaultProviderKeyId: asString(record.defaultProviderKeyId) ?? null,
    defaultModelId: asString(record.defaultModelId) ?? defaults.defaultModelId,
    defaultApiKind: isProviderKind(record.defaultApiKind)
      ? record.defaultApiKind
      : defaults.defaultApiKind,
    compression: {
      enabled:
        typeof compression?.enabled === "boolean"
          ? compression.enabled
          : defaults.compression.enabled,
      modelId: asString(compression?.modelId) ?? null,
      thresholdRatio:
        asNumber(compression?.thresholdRatio) ?? defaults.compression.thresholdRatio,
    },
    toolPermissions: {
      editFile:
        toolPermissions?.editFile === "allow" ||
        toolPermissions?.editFile === "deny" ||
        toolPermissions?.editFile === "ask"
          ? toolPermissions.editFile
          : defaults.toolPermissions.editFile,
      terminal:
        toolPermissions?.terminal === "allow" ||
        toolPermissions?.terminal === "deny" ||
        toolPermissions?.terminal === "ask"
          ? toolPermissions.terminal
          : defaults.toolPermissions.terminal,
      mcpCall:
        toolPermissions?.mcpCall === "allow" ||
        toolPermissions?.mcpCall === "deny" ||
        toolPermissions?.mcpCall === "ask"
          ? toolPermissions.mcpCall
          : defaults.toolPermissions.mcpCall,
    },
    providerKeys: dedupeProviderKeys(
      Array.isArray(record.providerKeys)
        ? record.providerKeys
            .map(normalizeProviderKey)
            .filter((key): key is CesiumProviderKey => key != null)
        : []
    ),
    customProviders: Array.isArray(record.customProviders)
      ? record.customProviders
          .map(normalizeCustomProvider)
          .filter((provider): provider is CesiumCustomProvider => provider != null)
      : [],
  };
}

function dedupeProviderKeys(keys: CesiumProviderKey[]): CesiumProviderKey[] {
  const byProvider = new Map<string, CesiumProviderKey>();
  for (const key of keys) {
    const existing = byProvider.get(key.providerId);
    if (!existing || key.updatedAt >= existing.updatedAt) {
      byProvider.set(key.providerId, key);
    }
  }
  return [...byProvider.values()].sort((a, b) => a.label.localeCompare(b.label));
}

async function resolveProviderLabel(providerId: string): Promise<string> {
  const catalog = await getCesiumModelCatalog();
  const entry = catalog.find((item) => item.providerId === providerId);
  if (entry?.providerName) {
    return entry.providerName;
  }
  return providerId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function redactedKey(key: CesiumProviderKey): CesiumProviderKeyStatus {
  return {
    id: key.id,
    providerId: key.providerId,
    label: key.label,
    apiKind: key.apiKind,
    baseUrl: key.baseUrl,
    createdAt: key.createdAt,
    updatedAt: key.updatedAt,
    source: "stored",
    lastFour: key.apiKey.slice(-4),
  };
}

function envProviderKeys(): CesiumProviderKeyStatus[] {
  const now = Date.now();
  return BUILTIN_ENV_KEYS.flatMap((entry): CesiumProviderKeyStatus[] => {
    const value = process.env[entry.env]?.trim();
    if (!value) {
      return [];
    }
    return [
      {
        id: `env:${entry.env}`,
        providerId: entry.providerId,
        label: entry.label,
        apiKind: entry.apiKind,
        source: "env",
        createdAt: 0,
        updatedAt: now,
        lastFour: value.slice(-4),
      },
    ];
  });
}

export async function getCesiumAgentSettings(): Promise<CesiumAgentSettings> {
  return normalizeSettings(await readJsonFile<unknown>(SETTINGS_FILE, null));
}

export async function saveCesiumAgentSettings(
  settings: CesiumAgentSettings
): Promise<CesiumAgentSettings> {
  const normalized = normalizeSettings({
    ...settings,
    schemaVersion: 1,
    updatedAt: Date.now(),
  });
  await writeJsonFile(SETTINGS_FILE, normalized);
  return normalized;
}

export async function getCesiumAgentSettingsPublic(): Promise<CesiumAgentSettingsPublic> {
  const settings = await getCesiumAgentSettings();
  const providerKeys = [...envProviderKeys(), ...settings.providerKeys.map(redactedKey)];
  return {
    ...settings,
    configured: providerKeys.length > 0,
    providerKeys,
  };
}

export async function getCesiumCredentialStatus(): Promise<{
  configured: boolean;
  providerKeys: CesiumProviderKeyStatus[];
}> {
  const settings = await getCesiumAgentSettingsPublic();
  return {
    configured: settings.configured,
    providerKeys: settings.providerKeys,
  };
}

export async function upsertCesiumProviderKey(input: {
  id?: string;
  providerId: string;
  label?: string;
  apiKind: CesiumProviderKind;
  apiKey: string;
  baseUrl?: string;
}): Promise<CesiumAgentSettingsPublic> {
  const settings = await getCesiumAgentSettings();
  const now = Date.now();
  const providerId = normalizeProviderId(input.providerId);
  const apiKey = input.apiKey.trim();
  assertApiKeyMatchesProvider(apiKey, providerId);
  const runtime = await resolveCesiumModelRuntime({
    modelId: `${providerId}/default`,
    configuredApiKind: input.apiKind,
  });
  const existingForProvider = settings.providerKeys.find(
    (key) => normalizeProviderId(key.providerId) === providerId
  );
  const id = (existingForProvider?.id ?? input.id?.trim()) || randomUUID();
  let resolvedBaseUrl = input.baseUrl?.trim() || undefined;
  if (!resolvedBaseUrl) {
    resolvedBaseUrl =
      runtime.baseUrl ?? (await resolveProviderApiBaseUrl(providerId));
  }
  if (providerId !== "openai" && !resolvedBaseUrl) {
    throw new Error(
      `Provider ${providerLabelFromId(providerId)} requires a base URL. Refresh models.dev or enter one for custom hosts.`
    );
  }
  const nextKey: CesiumProviderKey = {
    id,
    providerId,
    label: input.label?.trim() || (await resolveProviderLabel(providerId)),
    apiKind: runtime.apiKind,
    apiKey,
    baseUrl: resolvedBaseUrl,
    source: "stored",
    createdAt: existingForProvider?.createdAt ?? settings.providerKeys.find((key) => key.id === id)?.createdAt ?? now,
    updatedAt: now,
  };
  if (!nextKey.providerId || !nextKey.apiKey) {
    throw new Error("Provider id and API key are required.");
  }
  const providerKeys = dedupeProviderKeys([
    nextKey,
    ...settings.providerKeys.filter(
      (key) => key.id !== id && key.providerId !== providerId
    ),
  ]).slice(0, 50);
  await saveCesiumAgentSettings({
    ...settings,
    defaultProviderKeyId:
      settings.defaultProviderKeyId && providerKeys.some((key) => key.id === settings.defaultProviderKeyId)
        ? settings.defaultProviderKeyId
        : id,
    providerKeys,
  });
  return getCesiumAgentSettingsPublic();
}

export async function deleteCesiumProviderKey(id: string): Promise<CesiumAgentSettingsPublic> {
  const settings = await getCesiumAgentSettings();
  const providerKeys = settings.providerKeys.filter((key) => key.id !== id);
  await saveCesiumAgentSettings({
    ...settings,
    defaultProviderKeyId:
      settings.defaultProviderKeyId === id ? providerKeys[0]?.id ?? null : settings.defaultProviderKeyId,
    providerKeys,
  });
  return getCesiumAgentSettingsPublic();
}

export async function patchCesiumAgentSettings(input: {
  defaultProviderKeyId?: string | null;
  defaultModelId?: string;
  defaultApiKind?: CesiumProviderKind;
  compression?: Partial<CesiumAgentSettings["compression"]>;
  toolPermissions?: Partial<CesiumAgentSettings["toolPermissions"]>;
  customProviders?: CesiumCustomProvider[];
}): Promise<CesiumAgentSettingsPublic> {
  const settings = await getCesiumAgentSettings();
  await saveCesiumAgentSettings({
    ...settings,
    defaultProviderKeyId:
      input.defaultProviderKeyId === undefined
        ? settings.defaultProviderKeyId
        : input.defaultProviderKeyId,
    defaultModelId: input.defaultModelId?.trim() || settings.defaultModelId,
    defaultApiKind: input.defaultApiKind ?? settings.defaultApiKind,
    compression: {
      ...settings.compression,
      ...(input.compression ?? {}),
    },
    toolPermissions: {
      ...settings.toolPermissions,
      ...(input.toolPermissions ?? {}),
    },
    customProviders: input.customProviders ?? settings.customProviders,
  });
  return getCesiumAgentSettingsPublic();
}

export type CesiumDiscoveredProviderModel = {
  id: string;
  name: string;
  contextWindow?: number;
};

function resolveModelsListUrl(baseUrl: string, apiKind: CesiumProviderKind): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (apiKind === "anthropic") {
    return trimmed.endsWith("/v1") ? `${trimmed}/models` : `${trimmed}/v1/models`;
  }
  if (trimmed.endsWith("/v1")) {
    return `${trimmed}/models`;
  }
  if (/\/v\d+$/i.test(trimmed)) {
    return `${trimmed}/models`;
  }
  return `${trimmed}/v1/models`;
}

export async function discoverCesiumProviderModels(input: {
  apiKind: CesiumProviderKind;
  apiKey: string;
  baseUrl: string;
}): Promise<CesiumDiscoveredProviderModel[]> {
  const apiKey = input.apiKey.trim();
  const baseUrl = input.baseUrl.trim();
  if (!apiKey) {
    throw new Error("API key is required to discover models.");
  }
  if (!baseUrl) {
    throw new Error("Base URL is required to discover models.");
  }
  if (
    input.apiKind !== "anthropic" &&
    input.apiKind !== "openai-chat-completions" &&
    input.apiKind !== "openai-responses" &&
    input.apiKind !== "openai-compatible"
  ) {
    throw new Error("Model discovery supports OpenAI-compatible and Anthropic endpoints only.");
  }

  const url = resolveModelsListUrl(baseUrl, input.apiKind);
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  if (input.apiKind === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error(`Provider returned ${response.status} from ${url}`);
  }

  const payload = await response.json();
  const root = asRecord(payload);
  const data = Array.isArray(root?.data)
    ? root.data
    : Array.isArray(payload)
      ? payload
      : [];

  const models: CesiumDiscoveredProviderModel[] = [];
  for (const raw of data) {
    const item = asRecord(raw);
    const id = asString(item?.id);
    if (!id) {
      continue;
    }
    const name = asString(item?.name) ?? id;
    const context =
      asNumber(item?.context_window) ??
      asNumber(asRecord(item?.limit)?.context) ??
      asNumber(item?.context_length);
    models.push({
      id,
      name,
      ...(context ? { contextWindow: context } : {}),
    });
  }

  if (models.length === 0) {
    throw new Error("No models returned from provider.");
  }

  return models.sort((a, b) => a.name.localeCompare(b.name));
}

function providerKindForProvider(providerId: string, provider: Record<string, unknown>): CesiumProviderKind {
  const normalized = providerId.toLowerCase();
  if (BUILTIN_PROVIDER_KINDS[normalized]) {
    return BUILTIN_PROVIDER_KINDS[normalized];
  }
  const npm = asString(provider.npm) ?? "";
  const api = asString(provider.api);
  if (npm.includes("anthropic")) {
    return "anthropic";
  }
  if (npm.includes("google")) {
    return "google-genai";
  }
  if (api || npm.includes("openai")) {
    return "openai-compatible";
  }
  return "openai-compatible";
}

function parseModelsDevPayload(payload: unknown): CesiumModelCatalogEntry[] {
  const root = asRecord(payload);
  if (!root) {
    return [];
  }
  const entries: CesiumModelCatalogEntry[] = [];
  for (const [providerId, rawProvider] of Object.entries(root)) {
    const provider = asRecord(rawProvider);
    if (!provider) {
      continue;
    }
    const providerName = asString(provider.name) ?? providerId;
    const providerApiBaseUrl = asString(provider.api);
    const providerDocUrl = asString(provider.doc);
    const apiKind = providerKindForProvider(providerId, provider);
    const rawModels = asRecord(provider.models);
    if (!rawModels) {
      continue;
    }
    for (const [modelId, rawModel] of Object.entries(rawModels)) {
      const model = asRecord(rawModel);
      if (!model) {
        continue;
      }
      const limit = asRecord(model.limit);
      entries.push({
        providerId,
        providerName,
        providerApiBaseUrl,
        providerDocUrl,
        modelId: `${providerId}/${modelId}`,
        modelName: `${providerName}/${asString(model.name) ?? modelId}`,
        apiKind,
        supportsTools: model.tool_call === true,
        supportsReasoning: model.reasoning === true,
        supportsStructuredOutput: model.structured_output === true,
        contextWindow: asNumber(limit?.context),
        outputLimit: asNumber(limit?.output),
      });
    }
  }
  return entries.sort((a, b) => a.modelName.localeCompare(b.modelName));
}

function parseCrofAiModelsPayload(payload: unknown): CesiumModelCatalogEntry[] {
  const root = asRecord(payload);
  const data = Array.isArray(root?.data) ? root.data : [];
  return data
    .flatMap((rawModel): CesiumModelCatalogEntry[] => {
      const model = asRecord(rawModel);
      const id = asString(model?.id);
      if (!model || !id) {
        return [];
      }
      return [
        {
          providerId: CROFAI_PROVIDER_ID,
          providerName: CROFAI_PROVIDER_NAME,
          providerApiBaseUrl: CROFAI_BASE_URL,
          providerDocUrl: "https://crof.ai/",
          modelId: `${CROFAI_PROVIDER_ID}/${id}`,
          modelName: `${CROFAI_PROVIDER_NAME}/${asString(model.name) ?? id}`,
          apiKind: "openai-compatible",
          supportsTools: true,
          supportsReasoning:
            model.reasoning_effort === true ||
            model.custom_reasoning === true ||
            /reasoning/i.test(asString(model.name) ?? ""),
          supportsStructuredOutput: false,
          contextWindow: asNumber(model.context_length),
          outputLimit: asNumber(model.max_completion_tokens),
        },
      ];
    })
    .sort((a, b) => a.modelName.localeCompare(b.modelName));
}

function fallbackCrofAiCatalog(): CesiumModelCatalogEntry[] {
  const models: Array<{
    id: string;
    name: string;
    contextWindow?: number;
    outputLimit?: number;
    reasoning?: boolean;
  }> = [
    { id: "deepseek-v4-pro", name: "DeepSeek: DeepSeek V4 Pro", contextWindow: 1_000_000, outputLimit: 131_072, reasoning: true },
    { id: "deepseek-v4-pro-precision", name: "DeepSeek: DeepSeek V4 Pro (Precision)", contextWindow: 1_000_000, outputLimit: 131_072, reasoning: true },
    { id: "deepseek-v4-flash", name: "DeepSeek: DeepSeek V4 Flash", contextWindow: 1_000_000, outputLimit: 131_072, reasoning: true },
    { id: "deepseek-v3.2", name: "DeepSeek: DeepSeek V3.2", contextWindow: 163_840, outputLimit: 163_840 },
    { id: "mimo-v2.5-pro", name: "Xiaomi: MiMo-V2.5-Pro", contextWindow: 1_000_000, outputLimit: 131_072, reasoning: true },
    { id: "mimo-v2.5-pro-precision", name: "Xiaomi: MiMo-V2.5-Pro (Precision)", contextWindow: 1_000_000, outputLimit: 131_072, reasoning: true },
    { id: "glm-5.1", name: "Z.ai: GLM 5.1", contextWindow: 202_752, outputLimit: 202_752, reasoning: true },
    { id: "glm-5.1-precision", name: "Z.ai: GLM 5.1 (Precision)", contextWindow: 202_752, outputLimit: 202_752, reasoning: true },
    { id: "greg", name: "Experiment!: Greg", contextWindow: 229_376, outputLimit: 229_376 },
    { id: "kimi-k2.6", name: "MoonshotAI: Kimi K2.6", contextWindow: 262_144, outputLimit: 262_144, reasoning: true },
    { id: "kimi-k2.6-precision", name: "MoonshotAI: Kimi K2.6 (Precision)", contextWindow: 262_144, outputLimit: 262_144, reasoning: true },
    { id: "kimi-k2.5", name: "MoonshotAI: Kimi K2.5", contextWindow: 262_144, outputLimit: 262_144, reasoning: true },
    { id: "kimi-k2.5-lightning", name: "MoonshotAI: Kimi K2.5 (Lightning)", contextWindow: 131_072, outputLimit: 32_768, reasoning: true },
    { id: "glm-5", name: "Z.ai: GLM 5", contextWindow: 202_752, outputLimit: 202_752 },
    { id: "glm-4.7", name: "Z.AI: GLM 4.7", contextWindow: 202_752, outputLimit: 202_752 },
    { id: "glm-4.7-flash", name: "Z.AI: GLM 4.7 Flash", contextWindow: 202_752, outputLimit: 131_072 },
    { id: "gemma-4-31b-it", name: "Google: Gemma 4 31B", contextWindow: 262_144, outputLimit: 262_144, reasoning: true },
    { id: "minimax-m2.5", name: "MiniMax: MiniMax M2.5", contextWindow: 204_800, outputLimit: 131_072 },
    { id: "qwen3.6-27b", name: "Qwen: Qwen3.6 27B", contextWindow: 262_144, outputLimit: 262_144, reasoning: true },
    { id: "qwen3.5-397b-a17b", name: "Qwen: Qwen3.5 397B A17B", contextWindow: 262_144, outputLimit: 262_144, reasoning: true },
    { id: "qwen3.5-9b", name: "Qwen: Qwen3.5 9B", contextWindow: 262_144, outputLimit: 262_144, reasoning: true },
  ];
  return models.map((model) => ({
    providerId: CROFAI_PROVIDER_ID,
    providerName: CROFAI_PROVIDER_NAME,
    providerApiBaseUrl: CROFAI_BASE_URL,
    providerDocUrl: "https://crof.ai/",
    modelId: `${CROFAI_PROVIDER_ID}/${model.id}`,
    modelName: `${CROFAI_PROVIDER_NAME}/${model.name}`,
    apiKind: "openai-compatible",
    supportsTools: true,
    supportsReasoning: model.reasoning ?? false,
    supportsStructuredOutput: false,
    contextWindow: model.contextWindow,
    outputLimit: model.outputLimit,
  }));
}

async function getCrofAiCatalog(): Promise<CesiumModelCatalogEntry[]> {
  try {
    const response = await fetch(CROFAI_MODELS_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`CrofAI returned ${response.status}`);
    }
    const entries = parseCrofAiModelsPayload(await response.json());
    return entries.length > 0 ? entries : fallbackCrofAiCatalog();
  } catch {
    return fallbackCrofAiCatalog();
  }
}

function mergeCatalogEntries(entries: CesiumModelCatalogEntry[]): CesiumModelCatalogEntry[] {
  const byModelId = new Map<string, CesiumModelCatalogEntry>();
  for (const entry of entries) {
    if (!byModelId.has(entry.modelId)) {
      byModelId.set(entry.modelId, entry);
    }
  }
  return [...byModelId.values()].sort((a, b) => a.modelName.localeCompare(b.modelName));
}

async function readCatalogCache(): Promise<PersistedModelsDevCache | null> {
  const raw = await readJsonFile<unknown>(CATALOG_CACHE_FILE, null);
  const record = asRecord(raw);
  if (!record || record.schemaVersion !== 1 || !Array.isArray(record.entries)) {
    return null;
  }
  return {
    schemaVersion: 1,
    updatedAt: asNumber(record.updatedAt) ?? 0,
    entries: record.entries.filter((entry): entry is CesiumModelCatalogEntry => {
      const item = asRecord(entry);
      return Boolean(item && asString(item.modelId) && asString(item.modelName));
    }) as CesiumModelCatalogEntry[],
  };
}

export async function refreshCesiumModelCatalog(): Promise<CesiumModelCatalogEntry[]> {
  const [modelsDevPayload, crofAiEntries] = await Promise.all([
    (async () => {
      const response = await fetch(MODELS_DEV_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`models.dev returned ${response.status}`);
      }
      return response.json();
    })(),
    getCrofAiCatalog(),
  ]);
  const entries = mergeCatalogEntries([
    ...parseModelsDevPayload(modelsDevPayload),
    ...crofAiEntries,
  ]);
  await writeJsonFile(CATALOG_CACHE_FILE, {
    schemaVersion: 1,
    updatedAt: Date.now(),
    entries,
  } satisfies PersistedModelsDevCache);
  return entries;
}

export async function getCesiumModelCatalog(options?: {
  forceRefresh?: boolean;
}): Promise<CesiumModelCatalogEntry[]> {
  const cached = await readCatalogCache();
  if (
    !options?.forceRefresh &&
    cached &&
    cached.entries.length > 0 &&
    Date.now() - cached.updatedAt < CATALOG_TTL_MS
  ) {
    return mergeCatalogEntries([...cached.entries, ...(await getCrofAiCatalog())]);
  }
  try {
    return await refreshCesiumModelCatalog();
  } catch {
    return mergeCatalogEntries([...(cached?.entries ?? fallbackCatalog()), ...(await getCrofAiCatalog())]);
  }
}

function fallbackCatalog(): CesiumModelCatalogEntry[] {
  return [
    {
      providerId: "openai",
      providerName: "OpenAI",
      modelId: "openai/gpt-5.1",
      modelName: "OpenAI/GPT-5.1",
      apiKind: "openai-responses",
      supportsTools: true,
      supportsReasoning: true,
      supportsStructuredOutput: true,
    },
    {
      providerId: "anthropic",
      providerName: "Anthropic",
      modelId: "anthropic/claude-sonnet-4-5-20250929",
      modelName: "Anthropic/Claude Sonnet 4.5",
      apiKind: "anthropic",
      supportsTools: true,
      supportsReasoning: true,
      supportsStructuredOutput: false,
    },
    {
      providerId: "google",
      providerName: "Google",
      modelId: "google/gemini-2.5-pro",
      modelName: "Google/Gemini 2.5 Pro",
      apiKind: "google-genai",
      supportsTools: true,
      supportsReasoning: true,
      supportsStructuredOutput: true,
    },
  ];
}

export async function createCesiumAgentConfigOptions(): Promise<AgentConfigOption[]> {
  const [settings, catalog] = await Promise.all([
    getCesiumAgentSettings(),
    getCesiumModelCatalog(),
  ]);
  const customModels = settings.customProviders.flatMap((provider) =>
    provider.models.map((model): CesiumModelCatalogEntry => ({
      providerId: provider.id,
      providerName: provider.name,
      modelId: `${provider.id}/${model.id}`,
      modelName: `${provider.name}/${model.name}`,
      apiKind: provider.apiKind,
      supportsTools: model.supportsTools ?? true,
      supportsReasoning: model.supportsReasoning ?? false,
      supportsStructuredOutput: false,
      contextWindow: model.contextWindow,
    }))
  );
  const modelEntries = [...catalog, ...customModels].filter((model) => model.supportsTools);
  const modelOptions = modelEntries.map((model) => ({
    value: model.modelId,
    name: model.modelName,
    description: [
      model.apiKind,
      model.contextWindow ? `${model.contextWindow.toLocaleString()} ctx` : "",
      model.supportsReasoning ? "reasoning" : "",
    ].filter(Boolean).join(" · "),
    metadata: {
      providerId: model.providerId,
      apiKind: model.apiKind,
      ...(model.contextWindow ? { contextWindow: String(model.contextWindow) } : {}),
      supportsReasoning: String(model.supportsReasoning),
    },
  }));
  const apiKindOptions: Array<{ value: CesiumProviderKind; name: string }> = [
    { value: "openai-chat-completions", name: "OpenAI Chat Completions" },
    { value: "openai-responses", name: "OpenAI Responses (SSE)" },
    { value: "openai-realtime", name: "OpenAI Realtime (WebSocket)" },
    { value: "anthropic", name: "Anthropic Messages" },
    { value: "google-genai", name: "Google GenAI" },
    { value: "openai-compatible", name: "OpenAI-compatible" },
  ];
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "agent",
      options: [
        { value: "agent", name: "Agent" },
        {
          value: "orchestration",
          name: "Orchestration",
          description: "Coordinate a kanban board and delegate work to child agents.",
        },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue:
        modelOptions.find((option) => option.value === settings.defaultModelId)?.value ??
        modelOptions[0]?.value ??
        settings.defaultModelId,
      options: modelOptions,
    },
    {
      id: "api_kind",
      name: "Inference API",
      category: "other",
      currentValue: settings.defaultApiKind,
      options: apiKindOptions,
    },
  ];
}

export function findCesiumModelCatalogEntry(
  modelId: string,
  catalog: CesiumModelCatalogEntry[]
): CesiumModelCatalogEntry | undefined {
  return catalog.find((entry) => entry.modelId === modelId);
}

export async function resolveProviderApiBaseUrl(providerId: string): Promise<string | undefined> {
  const normalized = normalizeProviderId(providerId);
  const providerIds = providerKeyLookupIds(normalized);
  const settings = await getCesiumAgentSettings();
  const customProvider = settings.customProviders.find((provider) =>
    providerIds.includes(normalizeProviderId(provider.id))
  );
  if (customProvider?.baseUrl?.trim()) {
    return customProvider.baseUrl.trim();
  }
  const providerKey = settings.providerKeys.find((key) =>
    providerIds.includes(normalizeProviderId(key.providerId))
  );
  if (providerKey?.baseUrl?.trim()) {
    return providerKey.baseUrl.trim();
  }
  const catalog = await getCesiumModelCatalog();
  const entry = catalog.find((item) => providerIds.includes(normalizeProviderId(item.providerId)));
  return entry?.providerApiBaseUrl ?? BUILTIN_PROVIDER_BASE_URLS[normalized];
}

export async function resolveCesiumModelRuntime(input: {
  modelId: string;
  configuredApiKind?: CesiumProviderKind;
}): Promise<{
  providerId: string;
  apiKind: CesiumProviderKind;
  baseUrl?: string;
}> {
  const providerId = normalizeProviderId(
    input.modelId.includes("/") ? input.modelId.split("/", 1)[0]! : "openai"
  );
  const catalog = await getCesiumModelCatalog();
  const entry = findCesiumModelCatalogEntry(input.modelId, catalog);
  const providerEntry = catalog.find((item) => normalizeProviderId(item.providerId) === providerId);
  const baseUrl =
    entry?.providerApiBaseUrl ??
    providerEntry?.providerApiBaseUrl ??
    BUILTIN_PROVIDER_BASE_URLS[providerId];
  const configured = input.configuredApiKind;

  let apiKind: CesiumProviderKind;
  if (providerId === "openai" && configured?.startsWith("openai-")) {
    apiKind = configured;
  } else if (providerId === "anthropic") {
    apiKind = "anthropic";
  } else if (providerId === "google") {
    apiKind = "google-genai";
  } else if (entry?.apiKind) {
    apiKind = entry.apiKind;
  } else if (providerEntry?.apiKind) {
    apiKind = providerEntry.apiKind;
  } else if (BUILTIN_PROVIDER_KINDS[providerId]) {
    apiKind = BUILTIN_PROVIDER_KINDS[providerId]!;
  } else {
    apiKind = "openai-chat-completions";
  }

  // Third-party hosts only expose OpenAI-compatible chat completions.
  if (providerId !== "openai" && (apiKind === "openai-responses" || apiKind === "openai-realtime")) {
    apiKind = "openai-chat-completions";
  }
  if (apiKind === "openai-compatible") {
    apiKind = "openai-chat-completions";
  }

  return { providerId, apiKind, baseUrl };
}

export async function resolveCesiumApiKey(input: {
  providerId: string;
  apiKind: CesiumProviderKind;
}): Promise<{ apiKey: string; baseUrl?: string; providerId: string; apiKind: CesiumProviderKind }> {
  const settings = await getCesiumAgentSettings();
  const providerId = normalizeProviderId(input.providerId);
  const providerIds = providerKeyLookupIds(providerId);
  const byProvider = settings.providerKeys.find(
    (key) => providerIds.includes(normalizeProviderId(key.providerId))
  );
  if (byProvider) {
    assertApiKeyMatchesProvider(byProvider.apiKey, normalizeProviderId(byProvider.providerId));
    return {
      apiKey: byProvider.apiKey,
      baseUrl: byProvider.baseUrl,
      providerId,
      apiKind: input.apiKind,
    };
  }
  const byInferredPrefix = settings.providerKeys.find(
    (key) => {
      const inferred = inferProviderIdFromApiKey(key.apiKey);
      return inferred ? providerIds.includes(inferred) : false;
    }
  );
  if (byInferredPrefix) {
    return {
      apiKey: byInferredPrefix.apiKey,
      baseUrl: byInferredPrefix.baseUrl,
      providerId,
      apiKind: input.apiKind,
    };
  }
  const env = BUILTIN_ENV_KEYS.find((entry) => normalizeProviderId(entry.providerId) === providerId);
  if (env) {
    const envValue = process.env[env.env]?.trim();
    if (envValue) {
      assertApiKeyMatchesProvider(envValue, providerId);
      return {
        apiKey: envValue,
        providerId: env.providerId,
        apiKind: input.apiKind,
      };
    }
  }
  throw new Error(
    `No API key configured for ${providerLabelFromId(providerId)}. Add one in Settings → Agents → Cesium Agent.`
  );
}

export async function resolveCesiumAuth(input: {
  modelId: string;
  configuredApiKind?: CesiumProviderKind;
}): Promise<{
  apiKey: string;
  baseUrl?: string;
  providerId: string;
  apiKind: CesiumProviderKind;
}> {
  const runtime = await resolveCesiumModelRuntime(input);
  const key = await resolveCesiumApiKey({
    providerId: runtime.providerId,
    apiKind: runtime.apiKind,
  });
  const baseUrl =
    key.baseUrl ??
    runtime.baseUrl ??
    (await resolveProviderApiBaseUrl(runtime.providerId));
  if (
    runtime.providerId !== "openai" &&
    (runtime.apiKind === "openai-chat-completions" || runtime.apiKind === "openai-compatible") &&
    !baseUrl?.trim()
  ) {
    throw new Error(
      `No API base URL for ${providerLabelFromId(runtime.providerId)}. Open Settings → Agents → Cesium Agent, refresh models.dev, and save a key for that provider.`
    );
  }
  return {
    apiKey: key.apiKey,
    baseUrl: baseUrl?.trim() || (runtime.providerId === "openai" ? OPENAI_DEFAULT_BASE_URL : undefined),
    providerId: runtime.providerId,
    apiKind: runtime.apiKind,
  };
}
