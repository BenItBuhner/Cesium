import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { getStorage } from "../../storage/runtime.js";

function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

async function resolveEncryptionSecret(): Promise<string> {
  const storage = await getStorage();
  const authState = await storage.getAuthState();
  if (authState && typeof authState.secret === "string" && authState.secret.length > 0) {
    return authState.secret;
  }
  const configured = process.env.OPENCURSOR_MCP_SECRETS_KEY?.trim();
  if (configured) {
    return configured;
  }
  return "opencursor-mcp-dev-secrets";
}

export function encryptSecretPayload(payload: unknown, secret: string): string {
  const key = hashSecret(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    authTag.toString("base64url"),
  ].join(".");
}

export function decryptSecretPayload<T>(token: string, secret: string): T | null {
  const [version, ivPart, ciphertextPart, authTagPart] = token.split(".");
  if (version !== "v1" || !ivPart || !ciphertextPart || !authTagPart) {
    return null;
  }
  try {
    const key = hashSecret(secret);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivPart, "base64url")
    );
    decipher.setAuthTag(Buffer.from(authTagPart, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as T;
  } catch {
    return null;
  }
}

export async function encryptForWorkspace(payload: unknown): Promise<string> {
  const secret = await resolveEncryptionSecret();
  return encryptSecretPayload(payload, secret);
}

export async function decryptForWorkspace<T>(token: string): Promise<T | null> {
  const secret = await resolveEncryptionSecret();
  return decryptSecretPayload<T>(token, secret);
}
