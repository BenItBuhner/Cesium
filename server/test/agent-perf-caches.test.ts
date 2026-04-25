/**
 * Performance-adjacent and stress-adjacent checks for agent cache layers, rail
 * payload assembly, and key stability. Iterate on this file as you add new
 * batching, Redis TTLs, or read paths — the intent is to catch regressions on
 * “cold cache after write” and unbounded I/O, not to assert exact stopwatch ms.
 */
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

const TEST_ROOT = path.join(
  os.tmpdir(),
  `opencursor-perf-caches-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = TEST_ROOT;
process.env.WORKSPACE_ALLOWED_ROOTS = TEST_ROOT;
process.env.NODE_ENV = "test";

const { ensureDataDir } = await import("../src/lib/persistence.js");
await ensureDataDir();

const { snapshotHeadCacheKey, RAIL_ALL_FIRST_PAGE_CACHE_KEY } = await import(
  "../src/lib/agents/cache-keys.js"
);
const { buildAgentConversationsAllPayload, repopulateAgentRailFirstPageCache } =
  await import("../src/lib/agents/rail-payload.js");
const { ensureWorkspaceRegistered } = await import(
  "../src/lib/workspace-registry.js"
);

after(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => undefined);
});

describe("agent cache keys and rail payload invariants", () => {
  test("snapshot and rail key shapes stay stable (Redis contract)", () => {
    assert.equal(
      snapshotHeadCacheKey("ws-a", "conv-b"),
      "agent:snap-head:ws-a:conv-b"
    );
    assert.equal(RAIL_ALL_FIRST_PAGE_CACHE_KEY, "agent:rail:all:page0");
  });

  test("buildAgentConversationsAllPayload: empty rail sorts without throwing", async () => {
    const repo = path.join(TEST_ROOT, "empty-repo");
    await mkdir(repo, { recursive: true });
    await ensureWorkspaceRegistered(repo, "E");
    const body = await buildAgentConversationsAllPayload({ limit: 20, offset: 0 });
    assert.ok(Array.isArray(body.groups));
    assert.equal(body.nextCursor, null);
    assert.ok(Array.isArray(body.backends));
  });

  test("repopulateAgentRailFirstPageCache: stores JSON in KV in-process fallback", async () => {
    const { getJSON } = await import("../src/cache/kv.js");
    const repo = path.join(TEST_ROOT, "rail-warm");
    await mkdir(repo, { recursive: true });
    await ensureWorkspaceRegistered(repo, "R");
    await repopulateAgentRailFirstPageCache();
    const cached = await getJSON<unknown>(RAIL_ALL_FIRST_PAGE_CACHE_KEY);
    assert.ok(
      cached && typeof cached === "object" && "groups" in (cached as object)
    );
  });
});

describe("write throughput smoke (one megaphone, not a microbench)", () => {
  test("listWorkspaceConversationRecords tolerates 120 synthetic conversation rows in one workspace", async () => {
    const { getStorage } = await import("../src/storage/runtime.js");
    const { randomUUID } = await import("node:crypto");
    const repo = path.join(TEST_ROOT, "many-conv");
    await mkdir(repo, { recursive: true });
    const workspace = await ensureWorkspaceRegistered(repo, "M");
    const storage = await getStorage();

    const { upsertAgentConversation: upsert } = storage;
    const base = {
      schemaVersion: 1 as const,
      workspaceId: workspace.id,
      title: "t",
      status: "idle" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastEventSeq: 0,
      lastReadSeq: 0,
      config: { backendId: "cursor-acp" as const, mode: "agent" as const, modelId: "x" },
      providerSessionId: null,
      configOptions: [],
      capabilities: {
        supportsLoadSession: true,
        supportsModeSelection: true,
        supportsModelSelection: true,
        supportsSlashCommands: true,
        supportsPermissions: true,
        supportsToolCalls: true,
        supportsStructuredPlans: true,
        supportsTodos: true,
        supportsSessionResume: true,
        supportsPromptImages: true,
        supportsInlineReasoning: false,
      },
      pendingPermission: null,
      lastError: null,
      experimental: false,
      archivedAt: null,
    };
    for (let i = 0; i < 120; i += 1) {
      const id = randomUUID();
      await upsert({
        ...base,
        id,
        title: `row-${i}`,
        createdAt: base.createdAt + i,
        updatedAt: base.updatedAt + i,
      });
    }

    const { listWorkspaceConversationRecords } = await import(
      "../src/lib/agents/session-store.js"
    );
    const t0 = performance.now();
    const rows = await listWorkspaceConversationRecords(workspace.id);
    const ms = performance.now() - t0;
    assert.equal(rows.length, 120, "all upserted rows are listable for this workspace");
    assert.ok(
      ms < 10_000,
      `listWorkspaceConversationRecords should not hang: took ${ms.toFixed(0)}ms (threshold is generous for CI).`
    );
  });
});
