import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { afterEach, describe, test } from "node:test";
import {
  decodeRendezvousBootstrap,
  decryptRendezvousCiphertext,
  encodeRendezvousBootstrap,
  parseRendezvousBootstrapHash,
  resolveRendezvousEndpoint,
  type RendezvousLocator,
} from "../packages/client/src/rendezvous.ts";

const locator: RendezvousLocator = {
  version: 1,
  serverId: "server_1234567890abcdefghijklmnop",
  secret: "secret_1234567890abcdefghijklmnopqrstuvwxyz",
  registryBaseUrl: "https://cesium.example",
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function encryptEndpoint(
  input: { baseUrl: string; issuedAt: number; label?: string },
  iv = Buffer.from("0123456789ab")
): string {
  const key = createHash("sha256")
    .update(`cesium-rendezvous-v1\0${locator.secret}`)
    .digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(locator.serverId));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(input)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${iv.toString("base64url")}.${encrypted.toString("base64url")}`;
}

describe("rendezvous client protocol", () => {
  test("round-trips a fragment bootstrap without exposing it in a query", () => {
    const encoded = encodeRendezvousBootstrap({
      ...locator,
      initialBaseUrl: "https://first-tunnel.example/",
      label: "Home server",
    });
    const decoded = decodeRendezvousBootstrap(encoded);
    assert.deepEqual(decoded, {
      ...locator,
      initialBaseUrl: "https://first-tunnel.example",
      label: "Home server",
    });
    assert.deepEqual(
      parseRendezvousBootstrapHash(`#cesiumConnect=${encoded}`),
      decoded
    );
  });

  test("decrypts an authenticated endpoint bound to the server identity", async () => {
    const endpoint = await decryptRendezvousCiphertext(
      locator,
      encryptEndpoint({
        baseUrl: "https://rotated-tunnel.example/",
        issuedAt: 1_800_000_000_000,
        label: "Home server",
      })
    );
    assert.equal(endpoint.baseUrl, "https://rotated-tunnel.example");
    assert.equal(endpoint.label, "Home server");

    await assert.rejects(
      decryptRendezvousCiphertext(
        { ...locator, serverId: "different_1234567890abcdefghijkl" },
        encryptEndpoint({
          baseUrl: "https://rotated-tunnel.example",
          issuedAt: 1,
        })
      )
    );
  });

  test("resolves a fresh encrypted registry record", async () => {
    const now = Date.now();
    globalThis.fetch = async () =>
      Response.json({
        record: {
          version: 1,
          serverId: locator.serverId,
          ciphertext: encryptEndpoint({
            baseUrl: "https://current-tunnel.example",
            issuedAt: now,
          }),
          updatedAt: now,
          expiresAt: now + 60_000,
        },
      });

    const endpoint = await resolveRendezvousEndpoint(locator);
    assert.equal(endpoint?.baseUrl, "https://current-tunnel.example");
    assert.equal(endpoint?.recordUpdatedAt, now);
  });

  test("rejects insecure registries and endpoints", async () => {
    assert.throws(
      () =>
        encodeRendezvousBootstrap({
          ...locator,
          registryBaseUrl: "http://public.example",
        }),
      /HTTPS/
    );
    await assert.rejects(
      decryptRendezvousCiphertext(
        locator,
        encryptEndpoint({
          baseUrl: "http://insecure.example",
          issuedAt: Date.now(),
        })
      ),
      /HTTPS/
    );
  });
});
