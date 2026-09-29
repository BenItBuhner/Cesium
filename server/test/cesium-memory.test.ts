import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AgentConversationRecord } from "../src/lib/agents/types.js";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-memory-tests-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
await fs.mkdir(TEST_DATA_DIR, { recursive: true });

// Dynamic imports after the OPENCURSOR_DATA_DIR override so persistence.ts
// never freezes DATA_DIR to the real data directory.
const [
  memory,
  { AGENT_BACKENDS },
  { createCesiumAgentProvider },
] = await Promise.all([
  import("../src/lib/agents/cesium-memory.js"),
  import("../src/lib/agents/providers.js"),
  import("../src/lib/agents/cesium-provider.js"),
]);
const {
  CESIUM_MEMORY_MAX_CONTENT_CHARS,
  CESIUM_MEMORY_MAX_ENTRIES_PER_SCOPE,
  CESIUM_MEMORY_SNAPSHOT_MAX_CHARS,
  formatCesiumMemorySaveResult,
  listCesiumMemoryEntries,
  renderCesiumMemorySnapshot,
  saveCesiumMemoryEntry,
} = memory;

after(async () => {
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

let workspaceCounter = 0;
function freshWorkspace(): string {
  workspaceCounter += 1;
  return `ws-memory-${workspaceCounter}`;
}

test("saving the same fact again updates the entry instead of appending", async () => {
  const workspaceId = freshWorkspace();
  const first = await saveCesiumMemoryEntry({
    workspaceId,
    scope: "workspace",
    category: "fact",
    content: "The API server listens on port 9100.",
  });
  assert.equal(first.mergedBy, undefined);

  const exact = await saveCesiumMemoryEntry({
    workspaceId,
    scope: "workspace",
    category: "constraint",
    content: "the api server listens on PORT 9100",
  });
  assert.equal(exact.mergedBy, "duplicate");
  assert.equal(exact.entry.id, first.entry.id);
  assert.equal(exact.entry.category, "constraint");
  assert.equal(exact.previousContent, "The API server listens on port 9100.");

  const near = await saveCesiumMemoryEntry({
    workspaceId,
    scope: "workspace",
    category: "fact",
    content: "The API server listens on port 9100 locally.",
  });
  assert.equal(near.mergedBy, "near-duplicate");
  assert.equal(near.entry.id, first.entry.id);
  const text = formatCesiumMemorySaveResult(near);
  assert.match(text, new RegExp(`^Updated memory entry ${first.entry.id} \\(near-duplicate of an existing entry\\)`));
  assert.match(text, /Previous text: the api server listens on PORT 9100/);

  const entries = await listCesiumMemoryEntries({ workspaceId, scope: "workspace" });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.content, "The API server listens on port 9100 locally.");
});

test("short or different facts are kept apart", async () => {
  const workspaceId = freshWorkspace();
  await saveCesiumMemoryEntry({ workspaceId, scope: "workspace", category: "preference", content: "Use tabs" });
  const spaces = await saveCesiumMemoryEntry({
    workspaceId,
    scope: "workspace",
    category: "preference",
    content: "Use spaces",
  });
  assert.equal(spaces.mergedBy, undefined);
  const other = await saveCesiumMemoryEntry({
    workspaceId,
    scope: "workspace",
    category: "fact",
    content: "Frontend dev server runs on port 3000 with Next.js.",
  });
  assert.equal(other.mergedBy, undefined);
  const userScope = await saveCesiumMemoryEntry({ workspaceId, scope: "user", category: "preference", content: "Use tabs" });
  assert.equal(userScope.mergedBy, undefined, "scopes never merge into each other");
  assert.equal((await listCesiumMemoryEntries({ workspaceId, scope: "workspace" })).length, 3);
  assert.equal((await listCesiumMemoryEntries({ workspaceId, scope: "user" })).length, 1);
});

test("a key identifies a changing fact; updating by id folds exact duplicates", async () => {
  const workspaceId = freshWorkspace();
  const npm = await saveCesiumMemoryEntry({
    workspaceId,
    scope: "workspace",
    category: "decision",
    content: "Use npm workspaces for installs.",
    key: "Package Manager",
  });
  assert.equal(npm.entry.key, "package-manager");
  const pnpm = await saveCesiumMemoryEntry({
    workspaceId,
    scope: "workspace",
    category: "decision",
    content: "Switched to pnpm; do not run npm install.",
    key: "package-manager",
  });
  assert.equal(pnpm.mergedBy, "key");
  assert.equal(pnpm.entry.id, npm.entry.id);
  assert.match(formatCesiumMemorySaveResult(pnpm), /\(same key\)[\s\S]*key: package-manager[\s\S]*Previous text: Use npm workspaces/);

  const dup = await saveCesiumMemoryEntry({ workspaceId, scope: "workspace", category: "fact", content: "Staging deploys run nightly." });
  const target = await saveCesiumMemoryEntry({ workspaceId, scope: "workspace", category: "fact", content: "Release notes live in docs/releases." });
  const rewritten = await saveCesiumMemoryEntry({
    workspaceId,
    scope: "workspace",
    category: "fact",
    content: "Staging deploys run nightly!",
    id: target.entry.id,
  });
  assert.equal(rewritten.mergedBy, "id");
  assert.deepEqual(rewritten.foldedDuplicates.map((entry) => entry.id), [dup.entry.id]);
  assert.match(formatCesiumMemorySaveResult(rewritten), /Removed 1 duplicate entry with the same text/);
  const ids = (await listCesiumMemoryEntries({ workspaceId, scope: "workspace" })).map((entry) => entry.id).sort();
  assert.deepEqual(ids, [npm.entry.id, target.entry.id].sort());
});

test("a full scope evicts the least recently updated entries and says which", async () => {
  const workspaceId = freshWorkspace();
  const seeded = Array.from({ length: CESIUM_MEMORY_MAX_ENTRIES_PER_SCOPE }, (_, index) => ({
    id: `seed-${index}`,
    scope: "workspace",
    category: "fact",
    content: `Seeded fact number ${index} about subsystem ${index * 7}`,
    createdAt: 1_000 + index,
    updatedAt: 1_000 + index,
  }));
  const file = path.join(TEST_DATA_DIR, "workspaces", workspaceId, "agent-memory.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, updatedAt: 1, entries: seeded }), "utf8");

  const saved = await saveCesiumMemoryEntry({
    workspaceId,
    scope: "workspace",
    category: "decision",
    content: "Ship the migration behind a feature flag.",
  });
  assert.deepEqual(saved.evicted.map((entry) => entry.id), ["seed-0"]);
  const text = formatCesiumMemorySaveResult(saved);
  assert.match(
    text,
    new RegExp(`Evicted 1 least recently updated entry because the workspace scope is at its ${CESIUM_MEMORY_MAX_ENTRIES_PER_SCOPE}-entry cap`)
  );
  assert.ok(text.includes("Seeded fact number 0 about subsystem 0 (id: seed-0)"), text);
  const remaining = await listCesiumMemoryEntries({ workspaceId, scope: "workspace" });
  assert.equal(remaining.length, CESIUM_MEMORY_MAX_ENTRIES_PER_SCOPE);
  assert.ok(!remaining.some((entry) => entry.id === "seed-0"));
  assert.ok(remaining.some((entry) => entry.id === saved.entry.id));
});

test("long content is cut with a notice and the snapshot stays bounded", async () => {
  const workspaceId = freshWorkspace();
  const long = await saveCesiumMemoryEntry({
    workspaceId,
    scope: "workspace",
    category: "fact",
    content: `Rationale: ${"detail ".repeat(400)}`,
  });
  assert.equal(long.truncated, true);
  assert.equal(long.entry.content.length, CESIUM_MEMORY_MAX_CONTENT_CHARS);
  assert.match(formatCesiumMemorySaveResult(long), /Content was cut to 1000 characters\./);
  for (let index = 0; index < 30; index += 1) {
    await saveCesiumMemoryEntry({
      workspaceId,
      scope: "workspace",
      category: "fact",
      content: `Independent fact ${index}: component-${index} owns route /r${index}.`,
    });
  }
  const snapshot = renderCesiumMemorySnapshot(await listCesiumMemoryEntries({ workspaceId }));
  assert.ok(snapshot.length <= CESIUM_MEMORY_SNAPSHOT_MAX_CHARS, `snapshot is ${snapshot.length} chars`);
  const longLine = renderCesiumMemorySnapshot([long.entry]);
  assert.ok(longLine.length < 500, longLine);
  assert.match(longLine, /more chars\]/);
});

test("the memory tool reports merges and passes the key through", async () => {
  const backend = AGENT_BACKENDS["cesium-agent"]!;
  const provider = await createCesiumAgentProvider({ backend });
  const workspaceId = freshWorkspace();
  let conversation: AgentConversationRecord = {
    schemaVersion: 1,
    id: "cesium-memory-tool",
    workspaceId,
    title: "Memory tool",
    createdAt: 1,
    updatedAt: 1,
    lastEventSeq: 0,
    status: "idle",
    config: { backendId: "cesium-agent", mode: "agent", modelId: "openai/gpt-5.1", modelName: "GPT-5.1" },
    providerSessionId: null,
    configOptions: [],
    capabilities: backend.capabilities,
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: false,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
  };
  const handle = (await provider.startSession({
    conversation,
    workspace: { id: workspaceId, root: TEST_DATA_DIR, name: "memory", createdAt: 1 },
    appendEvents: async () => undefined,
    readSnapshot: async () => null,
    updateConversation: async (patch) => {
      conversation = typeof patch === "function" ? patch(conversation) : { ...conversation, ...patch };
      return conversation;
    },
  })) as unknown as { toolMemory: (args: Record<string, unknown>) => Promise<string>; dispose: () => Promise<void> };
  try {
    const first = await handle.toolMemory({ action: "save", content: "CI runs on GitHub Actions.", key: "ci" });
    assert.match(first, /^Saved memory entry\.\n- \[workspace\/fact\] CI runs on GitHub Actions\. \(id: [^,]+, key: ci\)$/);
    const again = await handle.toolMemory({ action: "save", content: "CI moved to Buildkite.", key: "ci" });
    assert.match(again, /^Updated memory entry \S+ \(same key\) instead of adding a new one\./);
    assert.match(await handle.toolMemory({ action: "search", query: "ci" }), /CI moved to Buildkite/);
  } finally {
    await handle.dispose();
  }
});
