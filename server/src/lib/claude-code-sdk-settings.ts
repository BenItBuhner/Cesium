import path from "node:path";
import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import { DATA_DIR, readJsonFile, writeJsonFile } from "./persistence.js";

export type ClaudeCodeSdkSettings = {
  schemaVersion: 1;
  updatedAt: number;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  pathToExecutable?: string;
};

export type ClaudeCodeSdkSettingsPatch = {
  baseUrl?: string | null;
  apiKey?: string | null;
  model?: string | null;
  pathToExecutable?: string | null;
};

export type ClaudeCodeSdkSettingsPublic = {
  configured: boolean;
  source: "stored" | "env" | null;
  updatedAt?: number;
  baseUrl?: string;
  model?: string;
  pathToExecutable?: string;
  apiKeyLastFour?: string;
  baseUrlSource?: "stored" | "env";
  modelSource?: "stored" | "env";
  pathSource?: "stored" | "env";
  apiKeySource?: "stored" | "env";
};

const SETTINGS_FILE = path.join(DATA_DIR, "profile", "claude-code-sdk-settings.json");
const DEFAULT_MODEL = "glm-5.1-precision";

let syncCache: ClaudeCodeSdkSettings | null | undefined;

function readEnvValue(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeSettings(raw: unknown): ClaudeCodeSdkSettings | null {
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  if (!record || record.schemaVersion !== 1) {
    return null;
  }
  const baseUrl = asOptionalString(record.baseUrl);
  const apiKey = asOptionalString(record.apiKey);
  const model = asOptionalString(record.model);
  const pathToExecutable = asOptionalString(record.pathToExecutable);
  if (!baseUrl && !apiKey && !model && !pathToExecutable) {
    return null;
  }
  return {
    schemaVersion: 1,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}),
    ...(pathToExecutable ? { pathToExecutable } : {}),
  };
}

function setSyncCache(settings: ClaudeCodeSdkSettings | null): void {
  syncCache = settings;
}

export function invalidateClaudeCodeSdkSettingsCache(): void {
  syncCache = undefined;
}

function readStoredSync(): ClaudeCodeSdkSettings | null {
  if (syncCache !== undefined) {
    return syncCache;
  }
  try {
    const raw = readFileSync(SETTINGS_FILE, "utf8");
    const settings = normalizeSettings(JSON.parse(raw));
    syncCache = settings;
    return settings;
  } catch {
    syncCache = null;
    return null;
  }
}

export function getStoredClaudeCodeSdkSettingsSync(): ClaudeCodeSdkSettings | null {
  return readStoredSync();
}

async function readStored(): Promise<ClaudeCodeSdkSettings | null> {
  const stored = normalizeSettings(await readJsonFile<unknown>(SETTINGS_FILE, null));
  setSyncCache(stored);
  return stored;
}

function envBaseUrl(): string {
  return readEnvValue("OPENCURSOR_CLAUDE_CODE_SDK_BASE_URL") || readEnvValue("ANTHROPIC_BASE_URL");
}

function envApiKey(): string {
  return readEnvValue("OPENCURSOR_CLAUDE_CODE_SDK_API_KEY") || readEnvValue("ANTHROPIC_API_KEY");
}

function envModel(): string {
  return readEnvValue("OPENCURSOR_CLAUDE_CODE_SDK_MODEL");
}

function envPathToExecutable(): string {
  return readEnvValue("OPENCURSOR_CLAUDE_CODE_SDK_PATH") || readEnvValue("OPENCURSOR_CLAUDE_BIN");
}

function resolveField<T extends keyof ClaudeCodeSdkSettings>(
  field: T,
  stored: ClaudeCodeSdkSettings | null,
  envValue: string
): { value: string | undefined; source: "stored" | "env" | null } {
  const storedValue = stored?.[field];
  if (typeof storedValue === "string" && storedValue.trim()) {
    return { value: storedValue.trim(), source: "stored" };
  }
  if (envValue.trim()) {
    return { value: envValue.trim(), source: "env" };
  }
  return { value: undefined, source: null };
}

export async function getClaudeCodeSdkSettings(): Promise<ClaudeCodeSdkSettings | null> {
  return readStored();
}

export async function getClaudeCodeSdkSettingsPublic(): Promise<ClaudeCodeSdkSettingsPublic> {
  const stored = await readStored();
  const baseUrl = resolveField("baseUrl", stored, envBaseUrl());
  const apiKey = resolveField("apiKey", stored, envApiKey());
  const model = resolveField("model", stored, envModel());
  const pathToExecutable = resolveField("pathToExecutable", stored, envPathToExecutable());
  const configured = Boolean(
    (baseUrl.value && apiKey.value) ||
      apiKey.value ||
      readEnvValue("ANTHROPIC_AUTH_TOKEN") ||
      readEnvValue("CLAUDE_CODE_USE_BEDROCK") === "1" ||
      readEnvValue("CLAUDE_CODE_USE_VERTEX") === "1" ||
      readEnvValue("CLAUDE_CODE_USE_FOUNDRY") === "1"
  );
  const primarySource =
    stored && (stored.baseUrl || stored.apiKey || stored.model || stored.pathToExecutable)
      ? "stored"
      : baseUrl.source === "env" || apiKey.source === "env" || model.source === "env" || pathToExecutable.source === "env"
        ? "env"
        : null;
  return {
    configured,
    source: primarySource,
    ...(stored?.updatedAt ? { updatedAt: stored.updatedAt } : {}),
    ...(baseUrl.value ? { baseUrl: baseUrl.value } : {}),
    ...(model.value ? { model: model.value } : { model: DEFAULT_MODEL }),
    ...(pathToExecutable.value ? { pathToExecutable: pathToExecutable.value } : {}),
    ...(apiKey.value ? { apiKeyLastFour: apiKey.value.slice(-4) } : {}),
    ...(baseUrl.source ? { baseUrlSource: baseUrl.source } : {}),
    ...(apiKey.source ? { apiKeySource: apiKey.source } : {}),
    ...(model.source ? { modelSource: model.source } : {}),
    ...(pathToExecutable.source ? { pathSource: pathToExecutable.source } : {}),
  };
}

function mergePatch(
  current: ClaudeCodeSdkSettings | null,
  patch: ClaudeCodeSdkSettingsPatch
): ClaudeCodeSdkSettings {
  const next: ClaudeCodeSdkSettings = {
    schemaVersion: 1,
    updatedAt: Date.now(),
    ...(current?.baseUrl ? { baseUrl: current.baseUrl } : {}),
    ...(current?.apiKey ? { apiKey: current.apiKey } : {}),
    ...(current?.model ? { model: current.model } : {}),
    ...(current?.pathToExecutable ? { pathToExecutable: current.pathToExecutable } : {}),
  };

  if (patch.baseUrl !== undefined) {
    const value = patch.baseUrl?.trim();
    if (value) {
      next.baseUrl = value;
    } else {
      delete next.baseUrl;
    }
  }
  if (patch.apiKey !== undefined) {
    const value = patch.apiKey?.trim();
    if (value) {
      next.apiKey = value;
    } else {
      delete next.apiKey;
    }
  }
  if (patch.model !== undefined) {
    const value = patch.model?.trim();
    if (value) {
      next.model = value;
    } else {
      delete next.model;
    }
  }
  if (patch.pathToExecutable !== undefined) {
    const value = patch.pathToExecutable?.trim();
    if (value) {
      next.pathToExecutable = value;
    } else {
      delete next.pathToExecutable;
    }
  }

  return next;
}

function hasPersistedValues(settings: ClaudeCodeSdkSettings): boolean {
  return Boolean(
    settings.baseUrl || settings.apiKey || settings.model || settings.pathToExecutable
  );
}

export async function verifyClaudeCodeSdkSettings(input: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}): Promise<void> {
  const baseUrl = input.baseUrl?.trim();
  const apiKey = input.apiKey?.trim();
  const model = input.model?.trim() || "claude-sonnet-4-5";
  if (!baseUrl || !apiKey) {
    return;
  }

  const normalized = baseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${normalized}/v1/messages`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error("Claude Code SDK credentials were rejected by the configured base URL.");
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Timed out verifying Claude Code SDK credentials.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function saveClaudeCodeSdkSettings(
  input: ClaudeCodeSdkSettingsPatch
): Promise<ClaudeCodeSdkSettingsPublic> {
  const current = await readStored();
  const next = mergePatch(current, input);
  if (!hasPersistedValues(next)) {
    await deleteClaudeCodeSdkSettings();
    return getClaudeCodeSdkSettingsPublic();
  }
  await writeJsonFile(SETTINGS_FILE, next);
  setSyncCache(next);
  return getClaudeCodeSdkSettingsPublic();
}

export async function patchClaudeCodeSdkSettings(
  input: ClaudeCodeSdkSettingsPatch
): Promise<ClaudeCodeSdkSettingsPublic> {
  return saveClaudeCodeSdkSettings(input);
}

export async function deleteClaudeCodeSdkSettings(): Promise<void> {
  await fs.unlink(SETTINGS_FILE).catch((error: unknown) => {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code !== "ENOENT") {
      throw error;
    }
  });
  setSyncCache(null);
}
