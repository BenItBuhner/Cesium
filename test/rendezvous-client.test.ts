import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { afterEach, describe, test } from "node:test";
import {
  attachSessionTokenToConnectUrl,
  decodeRendezvousBootstrap,
  decryptRendezvousCiphertext,
  encodeRendezvousBootstrap,
  parseConnectSessionHash,
  parseRendezvousBootstrapHash,
  resolveRendezvousEndpoint,
  resolveRendezvousEndpoints,
  RendezvousLookupError,
  rendezvousLookupOrigin,
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

  test("attaches a session token to a connect URL without exposing it in the query", () => {
    const encoded = encodeRendezvousBootstrap({
      ...locator,
      initialBaseUrl: "https://first-tunnel.example/",
      label: "Home server",
    });
    const connectUrl = `https://cesium.example/agent#cesiumConnect=${encoded}`;
    const signedIn = attachSessionTokenToConnectUrl(connectUrl, "sess_abc123");
    const parsed = new URL(signedIn);
    assert.equal(parsed.search, "");
    assert.equal(parseConnectSessionHash(parsed.hash), "sess_abc123");
    assert.deepEqual(parseRendezvousBootstrapHash(parsed.hash), {
      ...locator,
      initialBaseUrl: "https://first-tunnel.example",
      label: "Home server",
    });
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
    globalThis.fetch = async (_url, init) => {
      assert.equal(
        new Headers(init?.headers).get("x-cesium-rendezvous-version"),
        "2"
      );
      return Response.json({
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
    };

    const endpoint = await resolveRendezvousEndpoint(locator);
    assert.equal(endpoint?.baseUrl, "https://current-tunnel.example");
    assert.equal(endpoint?.recordUpdatedAt, now);
  });

  test("resolves every saved server in one batched registry request", async () => {
    const now = Date.now();
    const second = {
      ...locator,
      serverId: "server_abcdefghijklmnopqrstuvwxyz12",
    };
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls += 1;
      assert.equal(
        new Headers(init?.headers).get("x-cesium-rendezvous-version"),
        "2"
      );
      const body = JSON.parse(String(init?.body)) as { serverIds: string[] };
      assert.deepEqual(body.serverIds, [locator.serverId, second.serverId]);
      return Response.json({
        records: [
          {
            version: 1,
            serverId: locator.serverId,
            ciphertext: encryptEndpoint({
              baseUrl: "https://first.example",
              issuedAt: now,
            }),
            updatedAt: now,
            expiresAt: now + 60_000,
          },
          null,
        ],
      });
    };
    const endpoints = await resolveRendezvousEndpoints([locator, second]);
    assert.equal(calls, 1);
    assert.equal(endpoints.get(locator.serverId)?.baseUrl, "https://first.example");
    assert.equal(endpoints.get(second.serverId), null);
  });

  test("uses Convex HTTP directly and classifies deployment backoff errors", async () => {
    const convexLocator = {
      ...locator,
      registryBaseUrl: "https://example.convex.site",
    };
    let requestedUrl = "";
    globalThis.fetch = async (url) => {
      requestedUrl = String(url);
      return Response.json(
        { error: "Account blocked" },
        { status: 402, headers: { "Retry-After": "120" } }
      );
    };
    await assert.rejects(
      resolveRendezvousEndpoint(convexLocator),
      (error: unknown) => {
        assert.ok(error instanceof RendezvousLookupError);
        assert.equal(error.status, 402);
        assert.equal(error.retryAfterMs, 120_000);
        assert.equal(error.isGlobalFailure, true);
        return true;
      }
    );
    assert.equal(
      requestedUrl,
      `https://example.convex.site/rendezvous/${locator.serverId}`
    );
  });

  test("reads account-site locators from the Convex registry", async () => {
    const siteLocator = { ...locator, registryBaseUrl: "https://cesium.techlitnow.com" };
    const otherLocator = {
      ...locator,
      serverId: "server_abcdefghijklmnopqrstuvwxyz12",
      registryBaseUrl: "https://www.cesium.techlitnow.com",
    };
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json(
        String(input).endsWith("/batch")
          ? { records: [null, null] }
          : { error: "not found" },
        { status: String(input).endsWith("/batch") ? 200 : 404 }
      );
    };
    await resolveRendezvousEndpoint(siteLocator);
    await resolveRendezvousEndpoints([siteLocator, otherLocator]);
    assert.deepEqual(
      requests.map((request) => request.url),
      [
        `https://insightful-wolverine-140.convex.site/rendezvous/${locator.serverId}`,
        "https://insightful-wolverine-140.convex.site/rendezvous/batch",
      ]
    );
    assert.deepEqual(requests[1]?.body, {
      serverIds: [siteLocator.serverId, otherLocator.serverId],
    });
    assert.equal(
      rendezvousLookupOrigin("https://self-hosted.example/api/rendezvous"),
      "https://self-hosted.example"
    );
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
