import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  handleRendezvousGet,
  handleRendezvousPut,
} from "../src/lib/rendezvous-route.ts";
import {
  createRendezvousStoreFromEnv,
  type RendezvousRecord,
  type RendezvousStore,
  type RendezvousWriteResult,
} from "../src/lib/rendezvous-store.ts";

const SERVER_ID = "server_1234567890abcdefghijklmnop";
const SECRET = "secret_1234567890abcdefghijklmnopqrstuvwxyz";
const CIPHERTEXT =
  "abcdefghijklmnop.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

class MemoryRendezvousStore implements RendezvousStore {
  readonly records = new Map<string, RendezvousRecord>();
  readonly secretHashes = new Map<string, string>();
  rateLimitAllowed = true;

  async get(serverId: string): Promise<RendezvousRecord | null> {
    return this.records.get(serverId) ?? null;
  }

  async claimAndPut(
    serverId: string,
    secretHash: string,
    record: RendezvousRecord
  ): Promise<RendezvousWriteResult> {
    const existing = this.secretHashes.get(serverId);
    if (existing && existing !== secretHash) {
      return "forbidden";
    }
    this.secretHashes.set(serverId, secretHash);
    this.records.set(serverId, record);
    return "ok";
  }

  async consumeRateLimit(): Promise<boolean> {
    return this.rateLimitAllowed;
  }
}

function request(
  method: "GET" | "PUT",
  options?: { secret?: string; body?: unknown; ip?: string }
): Request {
  return new Request(`https://cesium.example/api/rendezvous/${SERVER_ID}`, {
    method,
    headers: {
      ...(options?.secret ? { Authorization: `Bearer ${options.secret}` } : {}),
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
      "x-forwarded-for": options?.ip ?? "203.0.113.7",
    },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
}

describe("rendezvous route", () => {
  test("stores and reads a short-lived encrypted record", async () => {
    const store = new MemoryRendezvousStore();
    const now = 1_800_000_000_000;
    const put = await handleRendezvousPut(
      store,
      request("PUT", {
        secret: SECRET,
        body: { version: 1, ciphertext: CIPHERTEXT },
      }),
      SERVER_ID,
      now
    );
    assert.equal(put.status, 200);
    assert.equal(put.headers.get("cache-control"), "no-store, max-age=0");

    const get = await handleRendezvousGet(store, request("GET"), SERVER_ID, now + 1);
    assert.equal(get.status, 200);
    const payload = (await get.json()) as { record: RendezvousRecord };
    assert.equal(payload.record.ciphertext, CIPHERTEXT);
    assert.equal(payload.record.expiresAt, now + 90_000);
  });

  test("rejects missing credentials and identity takeover", async () => {
    const store = new MemoryRendezvousStore();
    const body = { version: 1, ciphertext: CIPHERTEXT };
    const missing = await handleRendezvousPut(
      store,
      request("PUT", { body }),
      SERVER_ID
    );
    assert.equal(missing.status, 401);

    const first = await handleRendezvousPut(
      store,
      request("PUT", { secret: SECRET, body }),
      SERVER_ID
    );
    assert.equal(first.status, 200);
    const takeover = await handleRendezvousPut(
      store,
      request("PUT", {
        secret: "different_1234567890abcdefghijklmnopqrstuvwxyz",
        body,
      }),
      SERVER_ID
    );
    assert.equal(takeover.status, 403);
  });

  test("rejects malformed records and rate-limited requests", async () => {
    const store = new MemoryRendezvousStore();
    const invalid = await handleRendezvousPut(
      store,
      request("PUT", {
        secret: SECRET,
        body: { version: 1, ciphertext: "plaintext" },
      }),
      SERVER_ID
    );
    assert.equal(invalid.status, 400);

    store.rateLimitAllowed = false;
    const limited = await handleRendezvousGet(store, request("GET"), SERVER_ID);
    assert.equal(limited.status, 429);
  });

  test("returns 404 for missing or expired records", async () => {
    const store = new MemoryRendezvousStore();
    const missing = await handleRendezvousGet(store, request("GET"), SERVER_ID);
    assert.equal(missing.status, 404);

    store.records.set(SERVER_ID, {
      version: 1,
      serverId: SERVER_ID,
      ciphertext: CIPHERTEXT,
      updatedAt: 1,
      expiresAt: 2,
    });
    const expired = await handleRendezvousGet(store, request("GET"), SERVER_ID, 3);
    assert.equal(expired.status, 404);
  });

  test("fails closed when durable storage is not configured", () => {
    assert.throws(
      () => createRendezvousStoreFromEnv({}),
      /Attach Upstash Redis/
    );
  });
});
