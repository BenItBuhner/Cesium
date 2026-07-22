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
   * - native: ~/.pi/agent (or PI_CODING_AGENT_DIR) — preserves CLI customization
   * - isolated: Cesium profile dir — sandbox for shared servers
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

const BUILTIN_ENV_KEYS: Array<{ providerId: string; env: string }> = [
  { providerId: "anthropic", env: "ANTHROPIC_API_KEY" },
  { providerId: "openai", env: "OPENAI_API_KEY" },
  { providerId: "google", env: "GOOGLE_API_KEY" },
  { providerId: "openrouter", env: "OPENROUTER_API_KEY" },
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
  return BUILTIN_ENV_KEYS.flatMap((entry): PiAgentProviderKeyStatus[] => {
    const value = process.env[entry.env]?.trim();
    if (!value) {
      return [];
    }
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

/** Pi's native agent home (~/.pi/agent, or PI_CODING_AGENT_DIR). */
export function getNativePiAgentDir(): string {
  // Prefer Pi's resolver so PI_CODING_AGENT_DIR / renamed builds stay correct.
  try {
    // Synchronous require-style via dynamic import is async; use the same path
    // formula Pi documents when the package is unavailable at module load.
    const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
    if (envDir) {
      return path.resolve(expandHomePrefix(envDir));
    }
  } catch {
    // Fall through.
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

/** @deprecated Use getPiAgentAuthPath — kept for older probe scripts. */
export function getPiAgentAuthDir(): string {
  return getPiAgentAuthPath();
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

export async function applyPiRuntimeApiKeys(
  authStorage: import("@earendil-works/pi-coding-agent").AuthStorage
): Promise<void> {
  const settings = await getPiAgentSettings();
  for (const key of settings.providerKeys) {
    authStorage.setRuntimeApiKey(key.providerId, key.apiKey);
  }
}

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
    // Ignore auth storage read failures; treat as unconfigured.
  }
  return false;
}

export async function describePiAgentAuthStatus(): Promise<string> {
  try {
    const authStorage = await createPiAuthStorage();
    await applyPiRuntimeApiKeys(authStorage);
    const oauthCount = authStorage
      .list()
      .filter((providerId) => authStorage.get(providerId)?.type === "oauth").length;
    const apiKeyCount =
      (await getPiAgentSettings()).providerKeys.length + envProviderKeys().length;
    if (oauthCount > 0 && apiKeyCount > 0) {
      return `${oauthCount} OAuth · ${apiKeyCount} API key${apiKeyCount === 1 ? "" : "s"}`;
    }
    if (oauthCount > 0) {
      return `${oauthCount} OAuth provider${oauthCount === 1 ? "" : "s"} configured`;
    }
    if (apiKeyCount > 0) {
      return `${apiKeyCount} API key${apiKeyCount === 1 ? "" : "s"} configured`;
    }
  } catch {
    // Fall through to legacy status text.
  }
  const status = await getPiAgentCredentialStatus();
  return status.configured ? "Credentials configured" : "Not configured";
}
