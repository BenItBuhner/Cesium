import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  isSecretEnvelope,
  serializeSecretEnvelope,
  parseSecretEnvelope,
} from "@cesium/core";

/**
 * Synchronous AES-256-GCM seal/open that matches `@cesium/core` secret envelopes.
 * Used on the engine where transcription resolution still runs synchronously.
 */

function wrappingKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function sealSecretSync(
  plaintext: string,
  wrappingSecret: string,
  purpose = "secret"
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey(wrappingSecret), iv);
  cipher.setAAD(Buffer.from(purpose, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return serializeSecretEnvelope({
    iv: new Uint8Array(iv),
    ciphertext: new Uint8Array(ciphertext),
    tag: new Uint8Array(tag),
  });
}

export function openSecretSync(
  envelope: string,
  wrappingSecret: string,
  purpose = "secret"
): string | null {
  if (!isSecretEnvelope(envelope)) {
    return null;
  }
  const parts = parseSecretEnvelope(envelope);
  if (!parts) {
    return null;
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      wrappingKey(wrappingSecret),
      Buffer.from(parts.iv)
    );
    decipher.setAAD(Buffer.from(purpose, "utf8"));
    decipher.setAuthTag(Buffer.from(parts.tag));
    return Buffer.concat([
      decipher.update(Buffer.from(parts.ciphertext)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

export { isSecretEnvelope };
