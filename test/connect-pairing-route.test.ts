import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import {
  handlePairingCreate,
  handlePairingStatus,
  hashPollSecret,
  type PairingCloud,
  type PairingCreateInput,
} from "../src/lib/connect-pairing-route.ts";
import {
  ConvexRendezvousStore,
  MemoryRateLimiter,
  resolveRendezvousBackend,
} from "../src/lib/rendezvous-store.ts";

const CODE = "pbuuqg3u9cz3k4z65rb7ufuyse";
const POLL_SECRET = "p".repeat(43);
const SERVER_ID = "7agm8FI3q8b6UH6FwKo_zX2PVUe7ND8x";

function fakeCloud() {
  const created: PairingCreateInput[] = [];
  const statusCalls: Array<{ code: string; pollSecretHash: string }> = [];
  const cloud: PairingCloud = {
    async create(input) {
      created.push(input);
      return { ok: true, expiresAt: 1_000 };
    },
    async status(input) {
      statusCalls.push(input);
      if (input.pollSecretHash !== hashPollSecret(POLL_SECRET)) {
        return { status: "unknown", expiresAt: null, approvedBy: null };
      }
      return {
        status: "approved",
        expiresAt: 1_000,
        approvedBy: { email: "bennett@example.com", name: null },
      };
    },
  };
  return { cloud, created, statusCalls };
}

function createRequest(body: unknown, ip = "203.0.113.7"): Request {
  return new Request("https://cesium.techlitnow.com/api/connect/pairings", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("/api/connect/pairings facade", () => {
  test("hashes the poll secret before it reaches the cloud", async () => {
    const { cloud, created } = fakeCloud();
    const response = await handlePairingCreate(
      cloud,
      createRequest({
        code: CODE.toUpperCase(),
        pollSecret: POLL_SECRET,
        serverId: SERVER_ID,
        fingerprint: "7945-06CC-202F",
        label: "bennett-box",
        publicUrl: "https://bennett-box.lhr.life:9443",
      })
    );
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ok: true, code: CODE, expiresAt: 1_000 });
    assert.equal(created.length, 1);
    assert.equal(created[0]?.code, CODE);
    assert.equal(
      created[0]?.pollSecretHash,
      createHash("sha256").update(POLL_SECRET).digest("base64url")
    );
    assert.equal("pollSecret" in (created[0] ?? {}), false);
  });

  test("rejects malformed registrations before touching the cloud", async () => {
    const { cloud, created } = fakeCloud();
    for (const body of [
      { code: "short", pollSecret: POLL_SECRET, serverId: SERVER_ID, fingerprint: "7945-06CC-202F", label: "x", publicUrl: "https://x.lhr.life" },
      { code: CODE, pollSecret: "weak", serverId: SERVER_ID, fingerprint: "7945-06CC-202F", label: "x", publicUrl: "https://x.lhr.life" },
      { code: CODE, pollSecret: POLL_SECRET, serverId: "nope", fingerprint: "7945-06CC-202F", label: "x", publicUrl: "https://x.lhr.life" },
      { code: CODE, pollSecret: POLL_SECRET, serverId: SERVER_ID, fingerprint: "bad", label: "x", publicUrl: "https://x.lhr.life" },
      { code: CODE, pollSecret: POLL_SECRET, serverId: SERVER_ID, fingerprint: "7945-06CC-202F", label: "x" },
    ]) {
      const response = await handlePairingCreate(cloud, createRequest(body, "198.51.100.1"));
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    const invalidJson = await handlePairingCreate(
      cloud,
      new Request("https://cesium.techlitnow.com/api/connect/pairings", {
        method: "POST",
        headers: { "x-forwarded-for": "198.51.100.2" },
        body: "{",
      })
    );
    assert.equal(invalidJson.status, 400);
    assert.equal(created.length, 0);
  });

  test("status requires the engine's poll secret as bearer", async () => {
    const { cloud, statusCalls } = fakeCloud();
    const missing = await handlePairingStatus(
      cloud,
      new Request(`https://cesium.techlitnow.com/api/connect/pairings/${CODE}`, {
        headers: { "x-forwarded-for": "198.51.100.3" },
      }),
      CODE
    );
    assert.equal(missing.status, 401);
    const wrong = await handlePairingStatus(
      cloud,
      new Request(`https://cesium.techlitnow.com/api/connect/pairings/${CODE}`, {
        headers: { authorization: `Bearer ${"w".repeat(43)}`, "x-forwarded-for": "198.51.100.3" },
      }),
      CODE
    );
    assert.equal(wrong.status, 404);
    const ok = await handlePairingStatus(
      cloud,
      new Request(`https://cesium.techlitnow.com/api/connect/pairings/${CODE}`, {
        headers: { authorization: `Bearer ${POLL_SECRET}`, "x-forwarded-for": "198.51.100.3" },
      }),
      CODE
    );
    assert.equal(ok.status, 200);
    const payload = (await ok.json()) as { status: string; approvedBy: { email: string } };
    assert.equal(payload.status, "approved");
    assert.equal(payload.approvedBy.email, "bennett@example.com");
    assert.equal(statusCalls.every((call) => call.pollSecretHash.length === 43), true);
    const badCode = await handlePairingStatus(
      cloud,
      new Request("https://cesium.techlitnow.com/api/connect/pairings/nope", {
        headers: { authorization: `Bearer ${POLL_SECRET}`, "x-forwarded-for": "198.51.100.3" },
      }),
      "nope"
    );
    assert.equal(badCode.status, 400);
  });
});

describe("rendezvous store fallbacks", () => {
  test("Upstash wins when configured; otherwise Convex; otherwise none", () => {
    const previous = process.env.NEXT_PUBLIC_CESIUM_CLOUD;
    try {
      assert.equal(
        resolveRendezvousBackend({ UPSTASH_REDIS_REST_URL: "https://r", UPSTASH_REDIS_REST_TOKEN: "t" }),
        "upstash"
      );
      assert.equal(
        resolveRendezvousBackend({ KV_REST_API_URL: "https://r", KV_REST_API_TOKEN: "t" }),
        "upstash"
      );
      delete process.env.NEXT_PUBLIC_CESIUM_CLOUD;
      assert.equal(resolveRendezvousBackend({}), "convex");
      process.env.NEXT_PUBLIC_CESIUM_CLOUD = "0";
      assert.equal(resolveRendezvousBackend({}), "none");
    } finally {
      if (previous === undefined) {
        delete process.env.NEXT_PUBLIC_CESIUM_CLOUD;
      } else {
        process.env.NEXT_PUBLIC_CESIUM_CLOUD = previous;
      }
    }
  });

  test("Convex store debounces identical re-publishes and passes forbidden through", async () => {
    let now = 1_000_000;
    const mutations: unknown[] = [];
    const client = {
      async query() {
        return {
          version: 1,
          serverId: SERVER_ID,
          ciphertext: "iv.ct",
          updatedAt: now,
          expiresAt: now + 90_000,
        };
      },
      async mutation(_name: unknown, args: { secretHash: string }) {
        mutations.push(args);
        return {
          result: args.secretHash === "owner" ? ("ok" as const) : ("forbidden" as const),
          record: null,
        };
      },
    };
    const store = new ConvexRendezvousStore(client as never, () => now);
    const record = {
      version: 1 as const,
      serverId: SERVER_ID,
      ciphertext: "iv.ct",
      updatedAt: now,
      expiresAt: now + 90_000,
    };
    assert.equal(await store.claimAndPut(SERVER_ID, "owner", record, 90), "ok");
    now += 15_000;
    assert.equal(await store.claimAndPut(SERVER_ID, "owner", record, 90), "ok");
    assert.equal(mutations.length, 1, "second heartbeat inside the window is skipped");
    assert.equal(await store.claimAndPut(SERVER_ID, "intruder", record, 90), "forbidden");
    assert.equal(mutations.length, 2, "a different secret always reaches Convex");
    now += 30_000;
    assert.equal(await store.claimAndPut(SERVER_ID, "owner", record, 90), "ok");
    assert.equal(mutations.length, 3);
    const read = await store.get(SERVER_ID);
    assert.equal(read?.serverId, SERVER_ID);
    assert.equal(read?.version, 1);
  });

  test("memory rate limiter is a fixed window", () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now);
    assert.equal(limiter.consume("k", 2, 60), true);
    assert.equal(limiter.consume("k", 2, 60), true);
    assert.equal(limiter.consume("k", 2, 60), false);
    now = 61_000;
    assert.equal(limiter.consume("k", 2, 60), true);
  });
});
