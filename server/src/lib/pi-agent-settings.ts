import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR, readJsonFile, writeJsonFile } from "./persistence.js";

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

const PI_AGENT_DIR = path.join(DATA_DIR, "profile", "pi-agent");
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

export function getPiAgentDir(): string {
  return PI_AGENT_DIR;
}

export function getPiAgentAuthPath(): string {
  return path.join(PI_AGENT_DIR, "auth.json");
}

export function getPiAgentModelsPath(): string {
  return path.join(PI_AGENT_DIR, "models.json");
}

export function getPiAgentSdkSettingsPath(): string {
  return path.join(PI_AGENT_DIR, "settings.json");
}

export function getPiAgentSessionsRootDir(): string {
  return path.join(PI_AGENT_DIR, "sessions");
}

export function getPiAgentSessionsDirForCwd(cwd: string): string {
  const encoded = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16);
  return path.join(getPiAgentSessionsRootDir(), encoded);
}

export async function ensurePiAgentStorage(): Promise<void> {
  await fs.mkdir(PI_AGENT_DIR, { recursive: true });
}

export async function getPiAgentSettings(): Promise<PiAgentSettings> {
  return normalizeSettings(await readJsonFile<unknown>(SETTINGS_FILE, null));
}

export async function savePiAgentSettings(settings: PiAgentSettings): Promise<PiAgentSettings> {
  const normalized = normalizeSettings({
    ...settings,
    schemaVersion: 1,
    updatedAt: Date.now(),
  });
  await writeJsonFile(SETTINGS_FILE, normalized);
  return normalized;
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
