import path from "node:path";
import { promises as fs } from "node:fs";
import { DATA_DIR, readJsonFile, writeJsonFile } from "./persistence.js";

type PersistedCursorSdkCredentials = {
  schemaVersion: 1;
  updatedAt: number;
  apiKey: string;
  apiKeyName?: string;
  userEmail?: string;
};

export type CursorSdkCredentialStatus = {
  configured: boolean;
  source: "env" | "stored" | null;
  apiKeyName?: string;
  userEmail?: string;
  updatedAt?: number;
};

const CREDENTIALS_FILE = path.join(DATA_DIR, "profile", "cursor-sdk-credentials.json");

function envCursorApiKey(): string | null {
  const value = process.env.CURSOR_API_KEY?.trim();
  return value ? value : null;
}

async function readStoredCredentials(): Promise<PersistedCursorSdkCredentials | null> {
  const stored = await readJsonFile<PersistedCursorSdkCredentials | null>(
    CREDENTIALS_FILE,
    null
  );
  if (!stored || stored.schemaVersion !== 1 || typeof stored.apiKey !== "string") {
    return null;
  }
  const apiKey = stored.apiKey.trim();
  if (!apiKey) {
    return null;
  }
  return {
    schemaVersion: 1,
    updatedAt: typeof stored.updatedAt === "number" ? stored.updatedAt : 0,
    apiKey,
    ...(typeof stored.apiKeyName === "string" && stored.apiKeyName.trim()
      ? { apiKeyName: stored.apiKeyName.trim() }
      : {}),
    ...(typeof stored.userEmail === "string" && stored.userEmail.trim()
      ? { userEmail: stored.userEmail.trim() }
      : {}),
  };
}

export async function getCursorSdkApiKey(): Promise<string | null> {
  return envCursorApiKey() ?? (await readStoredCredentials())?.apiKey ?? null;
}

export async function getCursorSdkCredentialStatus(): Promise<CursorSdkCredentialStatus> {
  if (envCursorApiKey()) {
    return { configured: true, source: "env" };
  }
  const stored = await readStoredCredentials();
  if (!stored) {
    return { configured: false, source: null };
  }
  return {
    configured: true,
    source: "stored",
    updatedAt: stored.updatedAt,
    ...(stored.apiKeyName ? { apiKeyName: stored.apiKeyName } : {}),
    ...(stored.userEmail ? { userEmail: stored.userEmail } : {}),
  };
}

export async function saveCursorSdkApiKey(input: {
  apiKey: string;
  apiKeyName?: string;
  userEmail?: string;
}): Promise<CursorSdkCredentialStatus> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new Error("Cursor API key is required.");
  }
  const updatedAt = Date.now();
  await writeJsonFile(CREDENTIALS_FILE, {
    schemaVersion: 1,
    updatedAt,
    apiKey,
    ...(input.apiKeyName?.trim() ? { apiKeyName: input.apiKeyName.trim() } : {}),
    ...(input.userEmail?.trim() ? { userEmail: input.userEmail.trim() } : {}),
  } satisfies PersistedCursorSdkCredentials);
  return {
    configured: true,
    source: envCursorApiKey() ? "env" : "stored",
    updatedAt,
    ...(input.apiKeyName?.trim() ? { apiKeyName: input.apiKeyName.trim() } : {}),
    ...(input.userEmail?.trim() ? { userEmail: input.userEmail.trim() } : {}),
  };
}

export async function deleteCursorSdkApiKey(): Promise<void> {
  await fs.unlink(CREDENTIALS_FILE).catch((error: unknown) => {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code !== "ENOENT") {
      throw error;
    }
  });
}
