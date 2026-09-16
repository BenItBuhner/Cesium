#!/usr/bin/env node
/**
 * Integration test for the Cesium Cloud Context Convex functions.
 *
 * Runs against the project's configured Convex deployment via `npx convex
 * run` - locally that is the anonymous local deployment (`npx convex dev`),
 * which auto-starts when needed. The deployment must have
 * CESIUM_ALLOW_DEVICE_KEYS=1 set (`npx convex env set CESIUM_ALLOW_DEVICE_KEYS 1`).
 *
 * Usage: node scripts/test-convex-cloud.mjs
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const deviceKey = `test-${randomUUID()}`;
let passed = 0;
let failed = 0;

async function convexRun(fn, args) {
  const { stdout } = await execFileAsync(
    "npx",
    ["convex", "run", fn, JSON.stringify(args ?? {})],
    { cwd: new URL("..", import.meta.url).pathname, maxBuffer: 16 * 1024 * 1024 }
  );
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : null;
}

async function check(name, run) {
  try {
    await run();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL - ${name}`);
    console.error(`  ${error.message ?? error}`);
  }
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${label}: expected ${b}, got ${a}`);
  }
}

await check("register creates a device-key user", async () => {
  const result = await convexRun("context:register", { deviceKey });
  assertEqual(result.key, `device:${deviceKey}`, "user key");
});

await check("bootstrap returns null when unauthenticated", async () => {
  const result = await convexRun("context:bootstrap", {});
  assertEqual(result, null, "unauthenticated bootstrap");
});

await check("malformed device keys are rejected", async () => {
  let threw = false;
  try {
    await convexRun("context:register", { deviceKey: "short" });
  } catch {
    threw = true;
  }
  assertEqual(threw, true, "rejection");
});

await check("servers upsert by normalized base URL", async () => {
  const first = await convexRun("servers:save", {
    deviceKey,
    name: "Workstation",
    baseUrl: "http://localhost:9100/",
    kind: "remote",
    markConnected: true,
  });
  assertEqual(first.created, true, "first save creates");
  const second = await convexRun("servers:save", {
    deviceKey,
    name: "Workstation (renamed)",
    baseUrl: "http://localhost:9100",
    kind: "remote",
    sessionToken: "tok-123",
  });
  assertEqual(second.created, false, "second save upserts");
  const bootstrap = await convexRun("context:bootstrap", { deviceKey });
  assertEqual(bootstrap.servers.length, 1, "server count");
  assertEqual(bootstrap.servers[0].baseUrl, "http://localhost:9100", "normalized url");
  assertEqual(bootstrap.servers[0].name, "Workstation (renamed)", "renamed");
  assertEqual(bootstrap.servers[0].sessionToken, "tok-123", "token stored");
});

await check("non-http server URLs are rejected", async () => {
  let threw = false;
  try {
    await convexRun("servers:save", {
      deviceKey,
      name: "bad",
      baseUrl: "ftp://nope",
      kind: "remote",
    });
  } catch {
    threw = true;
  }
  assertEqual(threw, true, "rejection");
});

await check("preferences round-trip through preferences:get", async () => {
  const payload = JSON.stringify({ version: 1, theme: "dark" });
  await convexRun("preferences:save", { deviceKey, payload });
  // The settings document deliberately stays out of bootstrap (it changes on
  // every model pick); clients subscribe to preferences.get instead.
  const doc = await convexRun("preferences:get", { deviceKey });
  assertEqual(doc.payload, payload, "payload");
});

await check("non-JSON preferences are rejected", async () => {
  let threw = false;
  try {
    await convexRun("preferences:save", { deviceKey, payload: "not json{" });
  } catch {
    threw = true;
  }
  assertEqual(threw, true, "rejection");
});

await check("onboarding steps merge additively", async () => {
  const first = await convexRun("onboarding:update", {
    deviceKey,
    platform: "web",
    completeSteps: ["connect-server"],
  });
  assertEqual(first.completedSteps, ["connect-server"], "first step");
  const second = await convexRun("onboarding:update", {
    deviceKey,
    platform: "desktop",
    completeSteps: ["agents", "connect-server"],
    markComplete: true,
  });
  assertEqual(
    [...second.completedSteps].sort(),
    ["agents", "connect-server"],
    "merged steps"
  );
  if (typeof second.completedAt !== "number") {
    throw new Error("completedAt missing after markComplete");
  }
});

await check("snapshots push, list, and pull", async () => {
  const record = JSON.stringify({ title: "t", config: { backendId: "cesium-agent" } });
  const events = JSON.stringify([{ kind: "user_message", content: "hi" }]);
  const pushed = await convexRun("snapshots:push", {
    deviceKey,
    snapshotKey: "conv-abc",
    title: "Test conversation",
    backendId: "cesium-agent",
    messageCount: 2,
    recordJson: record,
    eventsJson: events,
    sourceUpdatedAt: Date.now(),
    serverName: "Workstation",
  });
  assertEqual(pushed.created, true, "created");
  const bootstrap = await convexRun("context:bootstrap", { deviceKey });
  assertEqual(bootstrap.snapshots.length, 1, "snapshot listed");
  assertEqual(bootstrap.snapshots[0].title, "Test conversation", "title");
  if (bootstrap.snapshots[0].recordJson !== undefined) {
    throw new Error("bootstrap must not inline transcripts");
  }
  const full = await convexRun("snapshots:get", { deviceKey, snapshotKey: "conv-abc" });
  assertEqual(full.recordJson, record, "record round trip");
  assertEqual(full.eventsJson, events, "events round trip");
});

await check("snapshot transcripts over the size cap are rejected", async () => {
  let threw = false;
  try {
    await convexRun("snapshots:push", {
      deviceKey,
      snapshotKey: "conv-huge",
      title: "Huge",
      backendId: "cesium-agent",
      messageCount: 1,
      recordJson: "{}",
      eventsJson: `"${"x".repeat(950_000)}"`,
      sourceUpdatedAt: Date.now(),
    });
  } catch {
    threw = true;
  }
  assertEqual(threw, true, "rejection");
});

await check("users are isolated by identity", async () => {
  const otherKey = `test-${randomUUID()}`;
  await convexRun("context:register", { deviceKey: otherKey });
  const bootstrap = await convexRun("context:bootstrap", { deviceKey: otherKey });
  assertEqual(bootstrap.servers.length, 0, "no leaked servers");
  assertEqual(bootstrap.snapshots.length, 0, "no leaked snapshots");
});

/* ---- One-link engine pairing --------------------------------------- */

const pairingCode = randomUUID().replace(/-/g, "").slice(0, 26).toLowerCase();
const pairingServerId = randomUUID().replace(/-/g, "").slice(0, 24);
const pollSecretHash = createHash("sha256").update("poll-secret").digest("base64url");

await check("engine registers a pending pairing without secrets", async () => {
  const created = await convexRun("pairings:create", {
    code: pairingCode,
    pollSecretHash,
    serverId: pairingServerId,
    fingerprint: "7945-06CC-202F",
    label: "bennett-box",
    publicUrl: "https://bennett-box.lhr.life/",
  });
  assertEqual(created.ok, true, "created");
  const lookup = await convexRun("pairings:lookup", { code: pairingCode, now: Date.now() });
  assertEqual(lookup.status, "pending", "pending");
  assertEqual(lookup.publicUrl, "https://bennett-box.lhr.life", "normalized public url");
  assertEqual(lookup.fingerprint, "7945-06CC-202F", "fingerprint");
  assertEqual(lookup.label, "bennett-box", "label");
  assertEqual(Object.prototype.hasOwnProperty.call(lookup, "pollSecretHash"), false, "hash hidden");
});

await check("pairing lookup rejects garbage, expiry is honored", async () => {
  assertEqual(await convexRun("pairings:lookup", { code: "nope" }), null, "garbage");
  const expired = await convexRun("pairings:lookup", {
    code: pairingCode,
    now: Date.now() + 20 * 60_000,
  });
  assertEqual(expired.status, "expired", "expired view");
});

await check("engine status poll requires the poll secret hash", async () => {
  const wrong = await convexRun("pairings:status", {
    code: pairingCode,
    pollSecretHash: "x".repeat(43),
    now: Date.now(),
  });
  assertEqual(wrong.status, "unknown", "wrong hash hides the row");
  const right = await convexRun("pairings:status", {
    code: pairingCode,
    pollSecretHash,
    now: Date.now(),
  });
  assertEqual(right.status, "pending", "pending");
});

await check("account approves once; another account cannot reuse the link", async () => {
  await convexRun("pairings:approve", {
    deviceKey,
    code: pairingCode,
    serverId: pairingServerId,
  });
  const status = await convexRun("pairings:status", {
    code: pairingCode,
    pollSecretHash,
    now: Date.now(),
  });
  assertEqual(status.status, "approved", "approved");
  const again = await convexRun("pairings:approve", {
    deviceKey,
    code: pairingCode,
    serverId: pairingServerId,
  });
  assertEqual(again.alreadyApproved, true, "idempotent for the approver");
  let threw = false;
  try {
    await convexRun("pairings:approve", {
      deviceKey: `test-${randomUUID()}`,
      code: pairingCode,
      serverId: pairingServerId,
    });
  } catch {
    threw = true;
  }
  assertEqual(threw, true, "second account rejected");
  let mismatch = false;
  try {
    await convexRun("pairings:approve", {
      deviceKey,
      code: pairingCode,
      serverId: randomUUID().replace(/-/g, "").slice(0, 24),
    });
  } catch {
    mismatch = true;
  }
  assertEqual(mismatch, true, "server id mismatch rejected");
});

await check("a new pairing for the same engine supersedes the pending one", async () => {
  const first = randomUUID().replace(/-/g, "").slice(0, 26).toLowerCase();
  const second = randomUUID().replace(/-/g, "").slice(0, 26).toLowerCase();
  const serverId = randomUUID().replace(/-/g, "").slice(0, 24);
  const args = {
    pollSecretHash,
    serverId,
    fingerprint: "AAAA-BBBB-CCCC",
    label: "box",
    publicUrl: "https://box.lhr.life",
  };
  await convexRun("pairings:create", { ...args, code: first });
  await convexRun("pairings:create", { ...args, code: second });
  assertEqual(await convexRun("pairings:lookup", { code: first, now: Date.now() }), null, "old link gone");
  const current = await convexRun("pairings:lookup", { code: second, now: Date.now() });
  assertEqual(current.status, "pending", "new link pending");
});

await check("sealed engine credentials are accepted as account secrets", async () => {
  const kind = `engine.auth.${pairingServerId}`;
  await convexRun("secrets:save", { deviceKey, kind, payload: "cesium-secret.v1.iv.ct.tag" });
  const bootstrap = await convexRun("context:bootstrap", { deviceKey });
  const stored = bootstrap.secrets.find((secret) => secret.kind === kind);
  assertEqual(stored?.payload, "cesium-secret.v1.iv.ct.tag", "secret listed in bootstrap");
  let threw = false;
  try {
    await convexRun("secrets:save", { deviceKey, kind: "engine.auth.short", payload: "x" });
  } catch {
    threw = true;
  }
  assertEqual(threw, true, "malformed engine kind rejected");
});

await check("paired server rows keep pairing metadata across plain upserts", async () => {
  const rendezvous = {
    version: 1,
    serverId: pairingServerId,
    secret: "s".repeat(43),
    registryBaseUrl: "https://cesium.techlitnow.com",
  };
  await convexRun("servers:save", {
    deviceKey,
    name: "bennett-box",
    baseUrl: "https://bennett-box.lhr.life",
    kind: "remote",
    rendezvous,
    pairing: { fingerprint: "7945-06CC-202F", attachedAt: 1_700_000_000_000 },
  });
  // The client push loop re-upserts the row without pairing metadata.
  await convexRun("servers:save", {
    deviceKey,
    name: "bennett-box",
    baseUrl: "https://rotated-tunnel.lhr.life",
    kind: "remote",
    rendezvous,
  });
  const bootstrap = await convexRun("context:bootstrap", { deviceKey });
  const row = bootstrap.servers.find((server) => server.rendezvous?.serverId === pairingServerId);
  assertEqual(row.baseUrl, "https://rotated-tunnel.lhr.life", "url followed the tunnel");
  assertEqual(row.pairing?.fingerprint, "7945-06CC-202F", "pairing fingerprint kept");
  assertEqual(row.pairing?.attachedAt, 1_700_000_000_000, "pairing time kept");
});

/* ---- Convex-backed rendezvous registry ------------------------------ */

await check("rendezvous records are claimed by write-secret hash", async () => {
  const serverId = randomUUID().replace(/-/g, "").slice(0, 24);
  const ciphertext = `${"a".repeat(16)}.${"b".repeat(48)}`;
  const first = await convexRun("rendezvous:claimAndPut", {
    serverId,
    secretHash: "owner".padEnd(43, "0"),
    ciphertext,
    ttlSeconds: 90,
  });
  assertEqual(first.result, "ok", "first publish claims");
  const intruder = await convexRun("rendezvous:claimAndPut", {
    serverId,
    secretHash: "intruder".padEnd(43, "0"),
    ciphertext,
    ttlSeconds: 90,
  });
  assertEqual(intruder.result, "forbidden", "other secret refused");
  const record = await convexRun("rendezvous:get", { serverId, now: Date.now() });
  assertEqual(record.ciphertext, ciphertext, "record readable");
  assertEqual(record.version, 1, "version");
  const expired = await convexRun("rendezvous:get", { serverId, now: Date.now() + 120_000 });
  assertEqual(expired, null, "expired records hidden");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
