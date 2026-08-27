import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.OPENCURSOR_DATA_DIR = await mkdtemp(
  path.join(os.tmpdir(), "cesium-subagents-v2-protocol-data-")
);

const { SubagentsV2Runtime } = await import(
  "../src/lib/agents/cesium/features/subagents/v2-runtime.js"
);
const { defaultHarnessSettings, normalizeHarnessLimits } = await import(
  "../src/lib/agents/cesium/features/limits.js"
);
import type { CesiumHistoryMessage } from "../src/lib/agents/cesium/cesium-types.js";

function testLimits(overrides: Record<string, number> = {}) {
  return normalizeHarnessLimits({
    ...defaultHarnessSettings().limits,
    waitAgentMinTimeoutMs: 50,
    waitAgentDefaultTimeoutMs: 50,
    waitAgentMaxTimeoutMs: 5_000,
    ...overrides,
  });
}

function runtimeWith(limits = testLimits()) {
  return new SubagentsV2Runtime({
    conversationId: "conv-protocol",
    limits,
    // Unknown provider on purpose: auth resolution fails instantly, so child
    // turns error without touching the network even when OPENAI_API_KEY (or
    // another provider key) is present in the test environment.
    defaultModelId: "unittestprov/missing-model-for-unit-test",
    appendEvents: async () => {},
  });
}

test("spawn depth is enforced at spawn time (Codex agents.max_depth parity)", async () => {
  const runtime = runtimeWith(testLimits({ maxSpawnDepth: 1 }));
  // Root (depth 0) may spawn a depth-1 child.
  const spawned = JSON.parse(await runtime.spawnAgent({ task_name: "child", message: "work" }));
  assert.equal(spawned.path, "/root/child");
  // A depth-1 child may NOT spawn a depth-2 grandchild with max depth 1.
  await assert.rejects(
    runtime.spawnAgent({ task_name: "grandchild", message: "work" }, "/root/child"),
    /maximum agent spawn depth \(1\) exceeded/
  );
  runtime.dispose();
});

test("raising maxSpawnDepth lets children spawn their own sub-agents", async () => {
  const runtime = runtimeWith(testLimits({ maxSpawnDepth: 2 }));
  await runtime.spawnAgent({ task_name: "child", message: "work" });
  const grandchild = JSON.parse(
    await runtime.spawnAgent({ task_name: "grandchild", message: "work" }, "/root/child")
  );
  assert.equal(grandchild.path, "/root/child/grandchild");
  await assert.rejects(
    runtime.spawnAgent(
      { task_name: "great_grandchild", message: "work" },
      "/root/child/grandchild"
    ),
    /maximum agent spawn depth \(2\) exceeded/
  );
  runtime.dispose();
});

test("fork_turns defaults to all (full-history fork, Codex parity)", async () => {
  const parentHistory: CesiumHistoryMessage[] = [
    { role: "user", content: "earlier context message" },
    { role: "assistant", content: "earlier assistant reply" },
  ];
  const runtime = new SubagentsV2Runtime({
    conversationId: "conv-fork",
    limits: testLimits(),
    defaultModelId: "unittestprov/missing-model-for-unit-test",
    appendEvents: async () => {},
    getParentHistory: async () => parentHistory,
  });
  await runtime.spawnAgent({ task_name: "forked", message: "work" });
  const forked = runtime.resolveAgent("/root/forked");
  assert.equal(forked.forkHistory.length, 2);
  assert.equal(forked.forkHistory[0]?.content, "earlier context message");

  await runtime.spawnAgent({ task_name: "fresh", message: "work", fork_turns: "none" });
  assert.equal(runtime.resolveAgent("/root/fresh").forkHistory.length, 0);

  await runtime.spawnAgent({ task_name: "partial", message: "work", fork_turns: "1" });
  assert.equal(runtime.resolveAgent("/root/partial").forkHistory.length, 1);

  await assert.rejects(
    runtime.spawnAgent({ task_name: "bogus", message: "work", fork_turns: "sometimes" }),
    /fork_turns must be/
  );
  runtime.dispose();
});

test("wait_agent updates are scoped to the direct spawner", async () => {
  const runtime = runtimeWith();
  // Spawned child errors quickly (no model credentials) and posts an update
  // addressed to its spawner (/root).
  await runtime.spawnAgent({ task_name: "worker", message: "work" });
  const rootWait = JSON.parse(await runtime.waitAgent({ timeout_ms: 3_000 })) as {
    timed_out: boolean;
    agents_with_updates?: string[];
  };
  assert.equal(rootWait.timed_out, false);
  assert.ok(rootWait.agents_with_updates?.includes("/root/worker"));

  // A different caller (the child itself) has no children - its wait times out
  // instead of stealing updates addressed to /root.
  await runtime.spawnAgent({ task_name: "worker_two", message: "work" });
  const childWait = JSON.parse(
    await runtime.waitAgent({ timeout_ms: 200 }, "/root/worker")
  ) as { timed_out: boolean };
  assert.equal(childWait.timed_out, true);
  runtime.dispose();
});

test("relative targets resolve under the caller path", async () => {
  const runtime = runtimeWith(testLimits({ maxSpawnDepth: 2 }));
  await runtime.spawnAgent({ task_name: "parent_task", message: "work" });
  await runtime.spawnAgent({ task_name: "leaf", message: "work" }, "/root/parent_task");
  const resolved = runtime.resolveAgent("leaf", "/root/parent_task");
  assert.equal(resolved.path, "/root/parent_task/leaf");
  runtime.dispose();
});

// Deliberately unresolvable model ids (unknown provider, no credentials) so
// spawned child turns error immediately instead of reaching a live provider.
const UNIT_MODEL_A = "unittestprov/model-a-for-unit-test";
const UNIT_MODEL_B = "unittestprov/model-b-for-unit-test";

test("spawned agents inherit the parent's current model (not the construction snapshot)", async () => {
  let currentModel = UNIT_MODEL_A;
  const runtime = new SubagentsV2Runtime({
    conversationId: "conv-model-inherit",
    limits: testLimits(),
    defaultModelId: "unittestprov/stale-construction-snapshot",
    resolveDefaultModelId: () => currentModel,
    appendEvents: async () => {},
  });
  const first = JSON.parse(await runtime.spawnAgent({ task_name: "first", message: "work" }));
  assert.equal(first.model, UNIT_MODEL_A);
  assert.equal(first.model_inherited, true);
  // Parent switches model mid-conversation → new children inherit the switch.
  currentModel = UNIT_MODEL_B;
  const second = JSON.parse(await runtime.spawnAgent({ task_name: "second", message: "work" }));
  assert.equal(second.model, UNIT_MODEL_B);
  assert.equal(runtime.resolveAgent("/root/second").modelId, UNIT_MODEL_B);
  runtime.dispose();
});

test("spawn model overrides pass through resolveSpawnModel and rejections abort the spawn", async () => {
  const runtime = new SubagentsV2Runtime({
    conversationId: "conv-model-override",
    limits: testLimits({ maxConcurrentSubagents: 8 }),
    defaultModelId: UNIT_MODEL_A,
    resolveSpawnModel: async (requested, defaultModelId) => {
      if (!requested) return defaultModelId;
      if (requested === "model-b-for-unit-test") return UNIT_MODEL_B; // shorthand resolution
      if (requested === UNIT_MODEL_B) return requested;
      throw new Error(`Model "${requested}" is not available for subagents.`);
    },
    appendEvents: async () => {},
  });
  const overridden = JSON.parse(
    await runtime.spawnAgent({
      task_name: "special",
      message: "work",
      modelId: "model-b-for-unit-test",
    })
  );
  assert.equal(overridden.model, UNIT_MODEL_B);
  assert.equal(overridden.model_inherited, false);
  // Codex arg-name parity: `model` works as an alias for `modelId`.
  const aliased = JSON.parse(
    await runtime.spawnAgent({ task_name: "aliased", message: "work", model: UNIT_MODEL_B })
  );
  assert.equal(aliased.model, UNIT_MODEL_B);
  // A disallowed model fails validation before any agent state is created.
  await assert.rejects(
    runtime.spawnAgent({ task_name: "blocked", message: "work", modelId: "acme/forbidden" }),
    /not available for subagents/
  );
  const listed = runtime.listAgents();
  assert.ok(!listed.some((agent) => agent.agent_name === "/root/blocked"));
  // list_agents reports each agent's model.
  assert.equal(
    listed.find((agent) => agent.agent_name === "/root/special")?.model,
    UNIT_MODEL_B
  );
  runtime.dispose();
});
