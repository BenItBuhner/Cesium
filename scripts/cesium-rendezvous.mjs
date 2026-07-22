#!/usr/bin/env bun
import {
  createCipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

function requiredEnv(name, pattern) {
  const value = process.env[name]?.trim() ?? "";
  if (!value || (pattern && !pattern.test(value))) {
    throw new Error(`Missing or invalid ${name}.`);
  }
  return value;
}

function registryConfig() {
  const serverId = requiredEnv("CESIUM_SERVER_ID", /^[A-Za-z0-9_-]{24,80}$/);
  const secret = requiredEnv("CESIUM_RENDEZVOUS_SECRET", /^[A-Za-z0-9_-]{32,128}$/);
  const endpoint = new URL(requiredEnv("CESIUM_RENDEZVOUS_URL"));
  if (
    endpoint.protocol !== "https:" &&
    !(
      endpoint.protocol === "http:" &&
      (endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1")
    )
  ) {
    throw new Error("CESIUM_RENDEZVOUS_URL must use HTTPS.");
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/${encodeURIComponent(serverId)}`;
  endpoint.search = "";
  endpoint.hash = "";
  return { endpoint, secret, serverId };
}

function encryptedRecord(publicUrl, tunnelProvider) {
  const { secret, serverId } = registryConfig();
  const endpoint = new URL(publicUrl);
  if (endpoint.protocol !== "https:") {
    throw new Error("Published Cesium endpoint must use HTTPS.");
  }
  endpoint.username = "";
  endpoint.password = "";
  endpoint.hash = "";
  const plaintext = Buffer.from(
    JSON.stringify({
      baseUrl: endpoint.toString().replace(/\/+$/, ""),
      issuedAt: Date.now(),
      label: process.env.CESIUM_SERVER_LABEL?.trim() || undefined,
      tunnelProvider: tunnelProvider || undefined,
    })
  );
  const key = createHash("sha256")
    .update(`cesium-rendezvous-v1\0${secret}`)
    .digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(serverId));
  const encrypted = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${iv.toString("base64url")}.${encrypted.toString("base64url")}`;
}

async function publish(publicUrl, tunnelProvider) {
  const { endpoint, secret } = registryConfig();
  const response = await fetch(endpoint, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      version: 1,
      ciphertext: encryptedRecord(publicUrl, tunnelProvider),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : `Rendezvous publish failed (${response.status}).`
    );
  }
}

function connectFragment(publicUrl) {
  const { endpoint, secret, serverId } = registryConfig();
  const payload = {
    version: 1,
    serverId,
    secret,
    registryBaseUrl: endpoint.origin,
    initialBaseUrl: new URL(publicUrl).toString().replace(/\/+$/, ""),
    label: process.env.CESIUM_SERVER_LABEL?.trim() || undefined,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

const [action, publicUrl, tunnelProvider = ""] = process.argv.slice(2);
try {
  if (action === "publish" && publicUrl) {
    await publish(publicUrl, tunnelProvider);
  } else if (action === "connect-fragment" && publicUrl) {
    process.stdout.write(connectFragment(publicUrl));
  } else {
    throw new Error(
      "Usage: cesium-rendezvous.mjs {publish|connect-fragment} <public-url> [tunnel-provider]"
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
