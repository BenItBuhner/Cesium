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
import { randomUUID } from "node:crypto";
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

await check("preferences round-trip through bootstrap", async () => {
  const payload = JSON.stringify({ version: 1, theme: "dark" });
  await convexRun("preferences:save", { deviceKey, payload });
  const bootstrap = await convexRun("context:bootstrap", { deviceKey });
  assertEqual(bootstrap.preferencesPayload, payload, "payload");
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
