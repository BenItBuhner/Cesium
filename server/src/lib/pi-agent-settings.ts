import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, readJsonFile, writeJsonFile } from "./persistence.js";

export type PiAgentHomeMode = "native" | "isolated";

export type PiAgentProviderKey = {
  id: string;
  providerId: string;
  label: string;
  apiKey: string;
  createdAt: number;
  updatedAt: number;
};

export type PiAgentSettings = {
  schemaVersion: 1;
  updatedAt: number;
  defaultProviderKeyId: string | null;
  providerKeys: PiAgentProviderKey[];
  /**
   * Where Pi loads settings, packages, extensions, skills, auth, and models.
   * - native: ~/.pi/agent (or PI_CODING_AGENT_DIR) - preserves CLI customization
   * - isolated: Cesium profile dir - sandbox for shared servers
   */
  agentHome: PiAgentHomeMode;
};

export type PiAgentProviderKeyStatus = Omit<PiAgentProviderKey, "apiKey"> & {
  source: "stored";
  lastFour?: string;
};

export type PiAgentSettingsPublic = Omit<PiAgentSettings, "providerKeys"> & {
  configured: boolean;
  providerKeys: PiAgentProviderKeyStatus[];
};

export type PiAgentCredentialStatus = {
  configured: boolean;
  source: "env" | "stored" | null;
  providerKeys: PiAgentProviderKeyStatus[];
};

export type PiAgentHomeInfo = {
  agentHome: PiAgentHomeMode;
  agentDir: string;
  nativeAgentDir: string;
  isolatedAgentDir: string;
  envOverride: string | null;
  usesEnvOverride: boolean;
};

const ISOLATED_PI_AGENT_DIR = path.join(DATA_DIR, "profile", "pi-agent");
const SETTINGS_FILE = path.join(DATA_DIR, "profile", "pi-agent-settings.json");

/**
 * Environment variables Pi's `AuthStorage` resolves natively (mirrors
 * `@earendil-works/pi-ai` `getEnvApiKey`). Entries flagged `alias` are Cesium
 * conventions Pi does not know about; they are injected as runtime keys so a
 * host configured for the Cesium agent also unlocks the matching Pi provider.
 */
export const PI_AGENT_ENV_KEYS: ReadonlyArray<{ providerId: string; env: string; alias?: boolean }> = [
  { providerId: "anthropic", env: "ANTHROPIC_API_KEY" },
  { providerId: "openai", env: "OPENAI_API_KEY" },
  { providerId: "google", env: "GEMINI_API_KEY" },
  { providerId: "google", env: "GOOGLE_API_KEY", alias: true },
  { providerId: "openrouter", env: "OPENROUTER_API_KEY" },
  { providerId: "groq", env: "GROQ_API_KEY" },
  { providerId: "xai", env: "XAI_API_KEY" },
  { providerId: "deepseek", env: "DEEPSEEK_API_KEY" },
  { providerId: "mistral", env: "MISTRAL_API_KEY" },
  { providerId: "cerebras", env: "CEREBRAS_API_KEY" },
  { providerId: "zai", env: "ZAI_API_KEY" },
  { providerId: "fireworks", env: "FIREWORKS_API_KEY" },
  { providerId: "together", env: "TOGETHER_API_KEY" },
  { providerId: "minimax", env: "MINIMAX_API_KEY" },
  { providerId: "moonshotai", env: "MOONSHOT_API_KEY" },
  { providerId: "kimi-coding", env: "KIMI_API_KEY" },
  { providerId: "huggingface", env: "HF_TOKEN" },
  { providerId: "opencode", env: "OPENCODE_API_KEY" },
  { providerId: "vercel-ai-gateway", env: "AI_GATEWAY_API_KEY" },
  { providerId: "azure-openai-responses", env: "AZURE_OPENAI_API_KEY" },
];

function defaultSettings(): PiAgentSettings {
  return {
    schemaVersion: 1,
    updatedAt: 0,
    defaultProviderKeyId: null,
    providerKeys: [],
    agentHome: "native",
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

function normalizeAgentHome(value: unknown): PiAgentHomeMode {
  return value === "isolated" ? "isolated" : "native";
}

function normalizeProviderKey(raw: unknown): PiAgentProviderKey | null {
  const record = asRecord(raw);
  const apiKey = asString(record?.apiKey);
  const providerId = asString(record?.providerId);
  if (!record || !apiKey || !providerId) {
    return null;
  }
  const now = Date.now();
  return {
    id: asString(record.id) ?? randomUUID(),
    providerId: providerId.toLowerCase(),
    label: asString(record.label) ?? providerId,
    apiKey,
    createdAt: asNumber(record.createdAt) ?? now,
    updatedAt: asNumber(record.updatedAt) ?? now,
  };
}

function normalizeSettings(raw: unknown): PiAgentSettings {
  const defaults = defaultSettings();
  const record = asRecord(raw);
  if (!record || record.schemaVersion !== 1) {
    return defaults;
  }
  return {
    schemaVersion: 1,
    updatedAt: asNumber(record.updatedAt) ?? defaults.updatedAt,
    defaultProviderKeyId: asString(record.defaultProviderKeyId) ?? null,
    providerKeys: Array.isArray(record.providerKeys)
      ? record.providerKeys
          .map(normalizeProviderKey)
          .filter((key): key is PiAgentProviderKey => key != null)
      : [],
    // Missing agentHome (older settings) defaults to native so CLI customization
    // is preserved unless the user explicitly chooses isolated.
    agentHome:
      record.agentHome === undefined
        ? "native"
        : normalizeAgentHome(record.agentHome),
  };
}

function redactedKey(key: PiAgentProviderKey): PiAgentProviderKeyStatus {
  return {
    id: key.id,
    providerId: key.providerId,
    label: key.label,
    createdAt: key.createdAt,
    updatedAt: key.updatedAt,
    source: "stored",
    lastFour: key.apiKey.slice(-4),
  };
}

function envProviderKeys(): PiAgentProviderKeyStatus[] {
  const now = Date.now();
  const seenProviders = new Set<string>();
  return PI_AGENT_ENV_KEYS.flatMap((entry): PiAgentProviderKeyStatus[] => {
    const value = process.env[entry.env]?.trim();
    if (!value || seenProviders.has(entry.providerId)) {
      return [];
    }
    seenProviders.add(entry.providerId);
    return [
      {
        id: `env:${entry.env}`,
        providerId: entry.providerId,
        label: entry.env,
        source: "stored",
        createdAt: 0,
        updatedAt: now,
        lastFour: value.slice(-4),
      },
    ];
  });
}

/**
 * Cesium-only env aliases (e.g. `GOOGLE_API_KEY`) that Pi would not resolve on
 * its own, for providers where no Pi-native env var is set.
 */
function envAliasRuntimeKeys(): Array<{ providerId: string; apiKey: string }> {
  const nativeProviders = new Set(
    PI_AGENT_ENV_KEYS.filter((entry) => !entry.alias && process.env[entry.env]?.trim()).map(
      (entry) => entry.providerId
    )
  );
  return PI_AGENT_ENV_KEYS.flatMap((entry) => {
    const value = process.env[entry.env]?.trim();
    if (!entry.alias || !value || nativeProviders.has(entry.providerId)) {
      return [];
    }
    return [{ providerId: entry.providerId, apiKey: value }];
  });
}

function expandHomePrefix(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/** Cesium-only absolute override. Wins over agentHome mode and Pi's own env. */
export function getPiAgentDirEnvOverride(): string | null {
  const value = process.env.OPENCURSOR_PI_AGENT_DIR?.trim();
  return value ? path.resolve(expandHomePrefix(value)) : null;
}

/**
 * Pi's native agent home: `PI_CODING_AGENT_DIR` when set, else `~/.pi/agent`.
 * Mirrors `getAgentDir()` from `@earendil-works/pi-coding-agent` without
 * importing the (heavy) package at module load.
 */
export function getNativePiAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (envDir) {
    return path.resolve(expandHomePrefix(envDir));
  }
  return path.join(os.homedir(), ".pi", "agent");
}

export function getIsolatedPiAgentDir(): string {
  return ISOLATED_PI_AGENT_DIR;
}

/**
 * Resolve the effective Pi agent directory.
 * Order: OPENCURSOR_PI_AGENT_DIR → agentHome setting → native ~/.pi/agent.
 */
export function resolvePiAgentDir(agentHome: PiAgentHomeMode = "native"): string {
  const envOverride = getPiAgentDirEnvOverride();
  if (envOverride) {
    return envOverride;
  }
  if (agentHome === "isolated") {
    return getIsolatedPiAgentDir();
  }
  return getNativePiAgentDir();
}

/** Sync helper used by hot paths; reads cached settings asynchronously elsewhere. */
let cachedAgentHome: PiAgentHomeMode | null = null;

export function getPiAgentDir(): string {
  return resolvePiAgentDir(cachedAgentHome ?? "native");
}

export async function refreshPiAgentDirCache(): Promise<string> {
  const settings = await getPiAgentSettings();
  cachedAgentHome = settings.agentHome;
  return resolvePiAgentDir(settings.agentHome);
}

export function getPiAgentAuthPath(): string {
  return path.join(getPiAgentDir(), "auth.json");
}

export function getPiAgentModelsPath(): string {
  return path.join(getPiAgentDir(), "models.json");
}

export function getPiAgentSdkSettingsPath(): string {
  return path.join(getPiAgentDir(), "settings.json");
}

export function getPiAgentSessionsRootDir(): string {
  return path.join(getPiAgentDir(), "sessions");
}

export function getPiAgentSessionsDirForCwd(cwd: string): string {
  const encoded = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16);
  return path.join(getPiAgentSessionsRootDir(), encoded);
}

export async function describePiAgentHome(): Promise<PiAgentHomeInfo> {
  const settings = await getPiAgentSettings();
  const envOverride = getPiAgentDirEnvOverride();
  const agentDir = resolvePiAgentDir(settings.agentHome);
  return {
    agentHome: settings.agentHome,
    agentDir,
    nativeAgentDir: getNativePiAgentDir(),
    isolatedAgentDir: getIsolatedPiAgentDir(),
    envOverride,
    usesEnvOverride: envOverride != null,
  };
}

export async function ensurePiAgentStorage(): Promise<void> {
  await fs.mkdir(await refreshPiAgentDirCache(), { recursive: true });
}

export async function getPiAgentSettings(): Promise<PiAgentSettings> {
  const settings = normalizeSettings(await readJsonFile<unknown>(SETTINGS_FILE, null));
  cachedAgentHome = settings.agentHome;
  return settings;
}

export async function savePiAgentSettings(settings: PiAgentSettings): Promise<PiAgentSettings> {
  const normalized = normalizeSettings({
    ...settings,
    schemaVersion: 1,
    updatedAt: Date.now(),
  });
  await writeJsonFile(SETTINGS_FILE, normalized);
  cachedAgentHome = normalized.agentHome;
  return normalized;
}

export async function setPiAgentHome(agentHome: PiAgentHomeMode): Promise<PiAgentSettingsPublic> {
  const settings = await getPiAgentSettings();
  await savePiAgentSettings({
    ...settings,
    agentHome: normalizeAgentHome(agentHome),
  });
  await ensurePiAgentStorage();
  return getPiAgentSettingsPublic();
}

export async function getPiAgentSettingsPublic(): Promise<PiAgentSettingsPublic> {
  const settings = await getPiAgentSettings();
  const providerKeys = [...envProviderKeys(), ...settings.providerKeys.map(redactedKey)];
  return {
    ...settings,
    configured: providerKeys.length > 0,
    providerKeys,
  };
}

export async function getPiAgentCredentialStatus(): Promise<PiAgentCredentialStatus> {
  const settings = await getPiAgentSettingsPublic();
  const hasEnv = envProviderKeys().length > 0;
  return {
    configured: settings.configured,
    source: hasEnv ? "env" : settings.providerKeys.length > 0 ? "stored" : null,
    providerKeys: settings.providerKeys,
  };
}

export async function upsertPiAgentProviderKey(input: {
  id?: string;
  providerId: string;
  label?: string;
  apiKey: string;
}): Promise<PiAgentSettingsPublic> {
  const settings = await getPiAgentSettings();
  const now = Date.now();
  const providerId = input.providerId.trim().toLowerCase();
  const apiKey = input.apiKey.trim();
  if (!providerId || !apiKey) {
    throw new Error("Provider id and API key are required.");
  }
  const existingForProvider = settings.providerKeys.find((key) => key.providerId === providerId);
  const id = (existingForProvider?.id ?? input.id?.trim()) || randomUUID();
  const nextKey: PiAgentProviderKey = {
    id,
    providerId,
    label: input.label?.trim() || providerId,
    apiKey,
    createdAt: existingForProvider?.createdAt ?? now,
    updatedAt: now,
  };
  const providerKeys = [
    nextKey,
    ...settings.providerKeys.filter((key) => key.id !== id && key.providerId !== providerId),
  ].slice(0, 50);
  await savePiAgentSettings({
    ...settings,
    defaultProviderKeyId:
      settings.defaultProviderKeyId && providerKeys.some((key) => key.id === settings.defaultProviderKeyId)
        ? settings.defaultProviderKeyId
        : id,
    providerKeys,
  });
  return getPiAgentSettingsPublic();
}

export async function deletePiAgentProviderKey(id: string): Promise<PiAgentSettingsPublic> {
  const settings = await getPiAgentSettings();
  const providerKeys = settings.providerKeys.filter((key) => key.id !== id);
  await savePiAgentSettings({
    ...settings,
    defaultProviderKeyId:
      settings.defaultProviderKeyId === id ? providerKeys[0]?.id ?? null : settings.defaultProviderKeyId,
    providerKeys,
  });
  return getPiAgentSettingsPublic();
}

export async function createPiAuthStorage(): Promise<import("@earendil-works/pi-coding-agent").AuthStorage> {
  await ensurePiAgentStorage();
  const { AuthStorage } = await import("@earendil-works/pi-coding-agent");
  return AuthStorage.create(getPiAgentAuthPath());
}

/**
 * Layer Cesium-managed credentials on top of Pi's own auth resolution as
 * runtime (non-persisted) keys: Settings-stored provider keys, Cesium env
 * aliases Pi does not recognise, and the brokered SuperGrok OAuth token.
 */
export async function applyPiRuntimeApiKeys(
  authStorage: import("@earendil-works/pi-coding-agent").AuthStorage
): Promise<void> {
  const settings = await getPiAgentSettings();
  const stored = new Set<string>();
  for (const key of settings.providerKeys) {
    authStorage.setRuntimeApiKey(key.providerId, key.apiKey);
    stored.add(key.providerId);
  }
  for (const alias of envAliasRuntimeKeys()) {
    if (!stored.has(alias.providerId) && !authStorage.hasAuth(alias.providerId)) {
      authStorage.setRuntimeApiKey(alias.providerId, alias.apiKey);
    }
  }
  try {
    const { getValidXaiAccessToken, XAI_OAUTH_PROVIDER_ID } = await import("./xai-oauth.js");
    const access = await getValidXaiAccessToken();
    if (access) {
      authStorage.setRuntimeApiKey(XAI_OAUTH_PROVIDER_ID, access);
    }
  } catch {
    // SuperGrok token missing or refresh failed - API-key path still works.
  }
}

/**
 * Build a Pi `ModelRegistry` for the active agent home with every Cesium
 * credential layer applied. This is the single source of truth for "which
 * models can actually be used": it accounts for `auth.json` (API keys and
 * OAuth), Pi-native env vars, Cesium-stored keys, Cesium env aliases and
 * `models.json` custom providers with inline/env/command API keys.
 */
export async function createPiModelRegistry(): Promise<{
  authStorage: import("@earendil-works/pi-coding-agent").AuthStorage;
  modelRegistry: import("@earendil-works/pi-coding-agent").ModelRegistry;
}> {
  const authStorage = await createPiAuthStorage();
  await applyPiRuntimeApiKeys(authStorage);
  const { ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  const modelRegistry = ModelRegistry.create(authStorage, getPiAgentModelsPath());
  modelRegistry.refresh();
  return { authStorage, modelRegistry };
}

/**
 * Whether Pi has at least one usable credential. Cheap checks first (Cesium
 * stored keys, env vars), then Pi's own registry so `models.json`-only setups
 * (local proxies, Ollama, vLLM) count as configured - the same rule Pi's CLI
 * applies before it accepts a prompt.
 */
export async function hasPiAgentStoredAuthConfig(): Promise<boolean> {
  const settings = await getPiAgentSettings();
  if (settings.providerKeys.length > 0 || envProviderKeys().length > 0) {
    return true;
  }
  try {
    const authStorage = await createPiAuthStorage();
    if (authStorage.list().some((providerId) => authStorage.hasAuth(providerId))) {
      return true;
    }
  } catch {
    // Ignore auth storage read failures; fall through to the registry check.
  }
  try {
    const { modelRegistry } = await createPiModelRegistry();
    return modelRegistry.getAvailable().length > 0;
  } catch {
    return false;
  }
}

export async function describePiAgentAuthStatus(): Promise<string> {
  try {
    const { authStorage, modelRegistry } = await createPiModelRegistry();
    const oauthCount = authStorage
      .list()
      .filter((providerId) => authStorage.get(providerId)?.type === "oauth").length;
    const apiKeyCount =
      (await getPiAgentSettings()).providerKeys.length + envProviderKeys().length;
    const authProviders = new Set([
      ...authStorage.list().filter((providerId) => authStorage.hasAuth(providerId)),
      ...(await getPiAgentSettings()).providerKeys.map((key) => key.providerId),
      ...envProviderKeys().map((key) => key.providerId),
    ]);
    const customProviderCount = new Set(
      modelRegistry
        .getAvailable()
        .map((model) => model.provider)
        .filter((providerId) => !authProviders.has(providerId))
    ).size;
    const parts: string[] = [];
    if (oauthCount > 0) {
      parts.push(`${oauthCount} OAuth`);
    }
    if (apiKeyCount > 0) {
      parts.push(`${apiKeyCount} API key${apiKeyCount === 1 ? "" : "s"}`);
    }
    if (customProviderCount > 0) {
      parts.push(`${customProviderCount} models.json provider${customProviderCount === 1 ? "" : "s"}`);
    }
    if (parts.length > 0) {
      return parts.join(" · ");
    }
  } catch {
    // Fall through to legacy status text.
  }
  const status = await getPiAgentCredentialStatus();
  return status.configured ? "Credentials configured" : "Not configured";
}
