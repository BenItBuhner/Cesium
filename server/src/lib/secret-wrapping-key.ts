import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR } from "./persistence.js";

const WRAPPING_KEY_FILE = path.join(DATA_DIR, "profile", "secret-wrapping.key");

let cachedKey: string | undefined;

function envWrappingKey(): string | undefined {
  const configured =
    process.env.CESIUM_SECRETS_KEY?.trim() ||
    process.env.OPENCURSOR_SECRETS_KEY?.trim();
  return configured || undefined;
}

export function secretWrappingKeyPath(): string {
  return WRAPPING_KEY_FILE;
}

export function getSecretWrappingKeySync(): string {
  if (cachedKey) {
    return cachedKey;
  }
  const fromEnv = envWrappingKey();
  if (fromEnv) {
    cachedKey = fromEnv;
    return fromEnv;
  }
  try {
    const existing = readFileSync(WRAPPING_KEY_FILE, "utf8").trim();
    if (existing) {
      cachedKey = existing;
      return existing;
    }
  } catch {
    // Generate on first use.
  }
  const generated = randomBytes(32).toString("base64url");
  mkdirSync(path.dirname(WRAPPING_KEY_FILE), { recursive: true });
  writeFileSync(WRAPPING_KEY_FILE, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
  cachedKey = generated;
  return generated;
}

export function resetSecretWrappingKeyCacheForTests(): void {
  cachedKey = undefined;
}

export function wrappingKeyFileExists(): boolean {
  return existsSync(WRAPPING_KEY_FILE);
}
