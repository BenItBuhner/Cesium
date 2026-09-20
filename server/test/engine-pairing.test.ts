import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-engine-pairing-tests-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
process.env.OPENCURSOR_ALLOW_PRIVATE_LAN_ORIGINS = "0";
process.env.ALLOWED_ORIGINS = "https://cesium.techlitnow.com";
process.env.OPENCURSOR_AUTH_USERNAME = "cesium";
process.env.OPENCURSOR_AUTH_PASSWORD = "engine-password-1234";
process.env.CESIUM_INSTANCE_ID = "cesium_engine_pairing_test_instance";

const fs = await import("node:fs/promises");
const {
  buildConnectUrl,
  createEnginePairingManagerForTests,
  engineFingerprint,
  enginePairingManager,
  PAIRING_CODE_PATTERN,
} = await import("../src/lib/engine-pairing.js");
const { PublicAccessError } = await import("../src/lib/public-access-manager.js");
const { createCesiumApp } = await import("../src/app.js");

const CONTEXT = {
  serverId: "7agm8FI3q8b6UH6FwKo_zX2PVUe7ND8x",
  rendezvousReadSecret: "r".repeat(43),
  webAppOrigin: "https://cesium.techlitnow.com",
  publicUrl: "https://bennett-box.lhr.life",
  label: "bennett-box",
};

type CloudCall = { url: string; method: string; authorization: string | null; body: unknown };

function makeCloudFetch(options: {
  calls?: CloudCall[];
  status?: () => { status: string; approvedBy?: { email: string | null; name: string | null } | null };
  createStatus?: number;
} = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    options.calls?.push({
      url,
      method,
      authorization: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.endsWith("/api/connect/pairings") && method === "POST") {
      const body = JSON.parse(String(init?.body));
      return Response.json(
        { ok: true, code: body.code, expiresAt: Date.now() + 600_000 },
        { status: options.createStatus ?? 201 }
      );
    }
    if (url.includes("/api/connect/pairings/")) {
      const status = options.status?.() ?? { status: "pending" };
      return Response.json({ ...status, expiresAt: null, approvedBy: status.approvedBy ?? null });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  }) as typeof fetch;
}

function makeManager(options: {
  now?: () => number;
  fetch?: typeof fetch;
  context?: typeof CONTEXT | null;
  credentials?: { username: string; password: string } | null;
} = {}) {
  return createEnginePairingManagerForTests({
    fetch: options.fetch ?? makeCloudFetch(),
    now: options.now,
    getContext: async () => (options.context === undefined ? CONTEXT : options.context),
    getCredentials: () =>
      options.credentials === undefined
        ? { username: "cesium", password: "engine-password-1234" }
        : options.credentials,
    cloudPollIntervalMs: 0,
  });
}

after(async () => {
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => undefined);
});

afterEach(() => {
  enginePairingManager.resetForTests();
});

test("fingerprint is stable per server id and human-shaped", () => {
  const fingerprint = engineFingerprint(CONTEXT.serverId);
  assert.match(fingerprint, /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
  assert.equal(engineFingerprint(CONTEXT.serverId), fingerprint);
  assert.notEqual(engineFingerprint("zyxwvutsrqponmlkjihgfedcba"), fingerprint);
  assert.equal(
    buildConnectUrl("https://cesium.techlitnow.com/", "abcdefghjkmnpqrstuvwxyz234"),
    "https://cesium.techlitnow.com/connect/abcdefghjkmnpqrstuvwxyz234"
  );
});

test("start registers a secret-free pairing with the account site", async () => {
  const calls: CloudCall[] = [];
  const manager = makeManager({ fetch: makeCloudFetch({ calls }) });
  const pairing = await manager.start();
  assert.match(pairing.code, PAIRING_CODE_PATTERN);
  assert.equal(pairing.code.length, 26);
  assert.equal(pairing.connectUrl, `https://cesium.techlitnow.com/connect/${pairing.code}`);
  assert.equal(pairing.fingerprint, engineFingerprint(CONTEXT.serverId));
  assert.equal(pairing.status, "pending");
  assert.equal(pairing.label, "bennett-box");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://cesium.techlitnow.com/api/connect/pairings");
  const body = calls[0]?.body as Record<string, unknown>;
  assert.equal(body.code, pairing.code);
  assert.equal(body.serverId, CONTEXT.serverId);
  assert.equal(body.publicUrl, CONTEXT.publicUrl);
  assert.equal(body.fingerprint, pairing.fingerprint);
  assert.match(String(body.pollSecret), /^[A-Za-z0-9_-]{43}$/);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /engine-password-1234/);
  assert.doesNotMatch(serialized, new RegExp(CONTEXT.rendezvousReadSecret));
});

test("start refuses without public access or engine auth", async () => {
  await assert.rejects(() => makeManager({ context: null }).start(), (error: unknown) => {
    assert.ok(error instanceof PublicAccessError);
    assert.equal(error.status, 409);
    assert.match(error.message, /Public access is not running/);
    return true;
  });
  await assert.rejects(() => makeManager({ credentials: null }).start(), /authentication is off/);
  await assert.rejects(
    () => makeManager({ fetch: makeCloudFetch({ createStatus: 503 }) }).start(),
    (error: unknown) => error instanceof PublicAccessError && error.status === 502
  );
});

test("claim hands out the credential exactly once, then reports attached", async () => {
  let now = 1_000_000;
  let cloudStatus: { status: string; approvedBy?: { email: string | null; name: string | null } } = {
    status: "pending",
  };
  const manager = makeManager({
    now: () => now,
    fetch: makeCloudFetch({ status: () => cloudStatus }),
  });
  const pairing = await manager.start();
  assert.equal((await manager.status(pairing.code)).status, "pending");

  await assert.rejects(
    () => manager.claim("zzzzzzzzzzzzzzzzzzzzzzzzzz"),
    (error: unknown) => error instanceof PublicAccessError && error.status === 404
  );
  await assert.rejects(
    () => manager.claim("not a code"),
    (error: unknown) => error instanceof PublicAccessError && error.status === 400
  );

  const claim = await manager.claim(pairing.code.toUpperCase(), { email: "bennett@example.com" });
  assert.equal(claim.serverId, CONTEXT.serverId);
  assert.equal(claim.publicUrl, CONTEXT.publicUrl);
  assert.equal(claim.fingerprint, pairing.fingerprint);
  assert.deepEqual(claim.auth, { username: "cesium", password: "engine-password-1234" });
  assert.deepEqual(claim.rendezvous, {
    version: 1,
    serverId: CONTEXT.serverId,
    secret: CONTEXT.rendezvousReadSecret,
    registryBaseUrl: "https://cesium.techlitnow.com",
  });

  await assert.rejects(
    () => manager.claim(pairing.code),
    (error: unknown) => error instanceof PublicAccessError && error.status === 409
  );
  const claimed = await manager.status(pairing.code);
  assert.equal(claimed.status, "claimed");
  assert.deepEqual(claimed.claimedBy, { email: "bennett@example.com", name: null });

  cloudStatus = { status: "approved", approvedBy: { email: "bennett@example.com", name: "Bennett" } };
  now += 5_000;
  const attached = await manager.status(pairing.code);
  assert.equal(attached.status, "attached");
  assert.deepEqual(attached.attachedBy, { email: "bennett@example.com", name: "Bennett" });
  assert.equal(attached.attachedAt, now);
});

test("expired links cannot be claimed and a new start supersedes the old link", async () => {
  let now = 5_000_000;
  const manager = makeManager({ now: () => now });
  const first = await manager.start({ ttlMs: 60_000 });
  now += 61_000;
  await assert.rejects(
    () => manager.claim(first.code),
    (error: unknown) => error instanceof PublicAccessError && error.status === 410
  );
  assert.equal((await manager.status(first.code)).status, "expired");

  const second = await manager.start();
  const third = await manager.start();
  assert.equal((await manager.status(second.code)).status, "cancelled");
  await assert.rejects(
    () => manager.claim(second.code),
    (error: unknown) => error instanceof PublicAccessError && error.status === 404
  );
  assert.equal((await manager.status(third.code)).status, "pending");
  assert.equal(manager.cancel(third.code), true);
  assert.equal((await manager.status(third.code)).status, "cancelled");
  await assert.rejects(() => manager.status("unknownunknownunknownunknown"), /Unknown connect code/);
});

test("HTTP: the claim route is reachable without an engine session and CORS-allowed", async () => {
  enginePairingManager.overrideDepsForTests({
    fetch: makeCloudFetch(),
    getContext: async () => CONTEXT,
    getCredentials: () => ({ username: "cesium", password: "engine-password-1234" }),
    cloudPollIntervalMs: 0,
  });
  const app = createCesiumApp();

  const preflight = await app.request("http://127.0.0.1:9100/api/pairing/claim", {
    method: "OPTIONS",
    headers: {
      Origin: "https://cesium.techlitnow.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://cesium.techlitnow.com");

  const unknown = await app.request("http://127.0.0.1:9100/api/pairing/claim", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "https://cesium.techlitnow.com" },
    body: JSON.stringify({ code: "zzzzzzzzzzzzzzzzzzzzzzzzzz" }),
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get("cache-control"), "no-store, max-age=0");
  assert.match(((await unknown.json()) as { error: string }).error, /not known to the engine/);

  // Minting a link is an operator action and needs the engine session.
  const mintUnauthenticated = await app.request("http://127.0.0.1:9100/api/public-access/pairing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(mintUnauthenticated.status, 401);

  const login = await app.request("http://127.0.0.1:9100/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "cesium", password: "engine-password-1234", remember: false }),
  });
  assert.equal(login.status, 200);
  const { token } = (await login.json()) as { token: string };

  const minted = await app.request("http://127.0.0.1:9100/api/public-access/pairing", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencursor-session-token": token },
    body: "{}",
  });
  assert.equal(minted.status, 201);
  const pairing = (await minted.json()) as { code: string; connectUrl: string; fingerprint: string };
  assert.equal(pairing.connectUrl, `https://cesium.techlitnow.com/connect/${pairing.code}`);

  const claimed = await app.request("http://127.0.0.1:9100/api/pairing/claim", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "https://cesium.techlitnow.com" },
    body: JSON.stringify({ code: pairing.code, account: { email: "bennett@example.com" } }),
  });
  assert.equal(claimed.status, 200);
  const bundle = (await claimed.json()) as { auth: { password: string }; serverId: string };
  assert.equal(bundle.serverId, CONTEXT.serverId);
  assert.equal(bundle.auth.password, "engine-password-1234");

  const again = await app.request("http://127.0.0.1:9100/api/pairing/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: pairing.code }),
  });
  assert.equal(again.status, 409);

  const status = await app.request(
    `http://127.0.0.1:9100/api/public-access/pairing/${pairing.code}`,
    { headers: { "x-opencursor-session-token": token } }
  );
  assert.equal(status.status, 200);
  const view = (await status.json()) as { status: string; claimedBy: { email: string } };
  assert.equal(view.status, "claimed");
  assert.equal(view.claimedBy.email, "bennett@example.com");
});
