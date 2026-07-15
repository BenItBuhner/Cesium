import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileWorkflowScript, executeWorkflowRun } from "../src/lib/agents/workflow-runtime.js";
import {
  createWorkflowRunRecord,
  hashWorkflowAgentCall,
  persistWorkflowScript,
  upsertWorkflowRun,
} from "../src/lib/agents/workflow-store.js";
import type { WorkspaceRecord } from "../src/lib/workspace-registry.js";
import {
  resolveCesiumModeToolPolicy,
  summarizeCesiumModeToolPolicy,
} from "../src/lib/agents/cesium-mode-policy.js";
import { buildCesiumModeReminder } from "../src/lib/agents/cesium-mode-reminders.js";

const SAMPLE_SCRIPT = `export const meta = {
  name: "fanout-demo",
  description: "Fan out three agents and synthesize",
  phases: [
    { title: "Scan", detail: "parallel research" },
    { title: "Synth", detail: "merge findings" },
  ],
};

phase("Scan");
const parts = await parallel([
  () => agent("alpha", { label: "a", phase: "Scan" }),
  () => agent("beta", { label: "b", phase: "Scan" }),
  () => agent("gamma", { label: "c", phase: "Scan" }),
]);
log("collected " + parts.filter(Boolean).length);
phase("Synth");
const merged = await agent("merge:" + parts.join(","), { label: "synth", phase: "Synth" });
return { parts, merged, args };
`;

test("compileWorkflowScript requires pure meta literal first", () => {
  const ok = compileWorkflowScript(SAMPLE_SCRIPT);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.meta.name, "fanout-demo");
    assert.equal(ok.meta.phases.length, 2);
  }

  const bad = compileWorkflowScript(`const x = 1;\nexport const meta = { name: "x", description: "y" };\nreturn 1;`);
  assert.equal(bad.ok, false);

  const impure = compileWorkflowScript(
    `export const meta = { name: "x", description: "y", phases: [...[]] };\nreturn 1;`
  );
  assert.equal(impure.ok, false);

  const nondet = compileWorkflowScript(
    `export const meta = { name: "x", description: "y", phases: [] };\nconst t = Date.now();\nreturn t;`
  );
  assert.equal(nondet.ok, false);
});

test("executeWorkflowRun fans out agent calls and returns synthesized value", async () => {
  const previous = process.env.OPENCURSOR_DATA_DIR;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cesium-workflow-"));
  process.env.OPENCURSOR_DATA_DIR = tempRoot;
  try {
    // Re-import store helpers are fine; DATA_DIR is resolved at module load.
    // Use in-memory execute path with a synthetic run that never hits disk paths
    // from the already-loaded DATA_DIR by writing through upsert after create.
    const workspace: WorkspaceRecord = {
      id: "ws-workflow",
      root: tempRoot,
      name: "Workflow workspace",
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
    };

    // Because DATA_DIR is captured at import time in persistence.ts, we keep
    // the run object in-memory and only use executeWorkflowRun's persistence
    // against the process DATA_DIR. For unit coverage we still validate the
    // orchestration semantics via a custom spawnAgent.
    const scriptPath = path.join(tempRoot, "demo.js");
    let run = createWorkflowRunRecord({
      workspace,
      conversationId: "conv-workflow",
      script: SAMPLE_SCRIPT,
      scriptPath,
      args: { topic: "auth" },
      maxAgents: 10,
      maxConcurrent: 3,
    });
    run = await upsertWorkflowRun(run);

    const prompts: string[] = [];
    const completed = await executeWorkflowRun({
      run,
      spawnAgent: async (request) => {
        prompts.push(request.prompt);
        return { value: `ok:${request.prompt}`, tokensUsed: 12 };
      },
    });

    assert.equal(completed.status, "completed");
    assert.equal(completed.agentsUsed, 4);
    assert.deepEqual(prompts, ["alpha", "beta", "gamma", "merge:ok:alpha,ok:beta,ok:gamma"]);
    assert.deepEqual(completed.returnValue, {
      parts: ["ok:alpha", "ok:beta", "ok:gamma"],
      merged: "ok:merge:ok:alpha,ok:beta,ok:gamma",
      args: { topic: "auth" },
    });
    assert.equal(completed.tokensUsed, 48);
    assert.ok(completed.logs.some((entry) => entry.message.includes("collected 3")));
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCURSOR_DATA_DIR;
    } else {
      process.env.OPENCURSOR_DATA_DIR = previous;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("workflow journal resumes unchanged agent calls", async () => {
  const workspace: WorkspaceRecord = {
    id: "ws-workflow-resume",
    root: "/tmp",
    name: "Workflow resume",
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
  };
  const script = `export const meta = { name: "resume", description: "resume demo", phases: [{ title: "One" }] };
phase("One");
const a = await agent("same", { label: "one" });
const b = await agent("same", { label: "one" });
return [a, b];
`;
  let run = createWorkflowRunRecord({
    workspace,
    conversationId: "conv-resume",
    script,
    scriptPath: "/tmp/resume.js",
    maxAgents: 5,
  });
  run = await upsertWorkflowRun(run);

  let liveCalls = 0;
  const completed = await executeWorkflowRun({
    run,
    spawnAgent: async (request) => {
      liveCalls += 1;
      return { value: `live:${request.prompt}`, tokensUsed: 5 };
    },
  });
  assert.equal(completed.status, "completed");
  assert.equal(liveCalls, 1);
  assert.deepEqual(completed.returnValue, ["live:same", "live:same"]);
  assert.equal(completed.agents.filter((item) => item.status === "cached").length, 1);
});

test("hashWorkflowAgentCall is stable for identical prompt/opts", () => {
  const a = hashWorkflowAgentCall("hello", { label: "x", phase: "Scan" });
  const b = hashWorkflowAgentCall("hello", { label: "x", phase: "Scan" });
  const c = hashWorkflowAgentCall("hello", { label: "y", phase: "Scan" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("Workflow mode policy allows workflow tools and blocks burn/orchestration", () => {
  assert.equal(resolveCesiumModeToolPolicy({ mode: "workflow", toolName: "workflow_run" }).allowed, true);
  assert.equal(resolveCesiumModeToolPolicy({ mode: "workflow", toolName: "edit_file" }).allowed, true);
  assert.equal(resolveCesiumModeToolPolicy({ mode: "workflow", toolName: "burn_goal_set" }).allowed, false);
  assert.equal(
    resolveCesiumModeToolPolicy({ mode: "workflow", toolName: "orchestration_create_issue" }).allowed,
    false
  );
  assert.equal(resolveCesiumModeToolPolicy({ mode: "agent", toolName: "workflow_run" }).allowed, false);
  assert.equal(resolveCesiumModeToolPolicy({ mode: "burn", toolName: "workflow_run" }).allowed, false);
  const summary = summarizeCesiumModeToolPolicy("workflow");
  assert.equal(summary.allowed.includes("workflow_run"), true);
});

test("Workflow mode reminder documents script primitives", () => {
  const reminder = buildCesiumModeReminder({
    mode: "workflow",
    workspaceRoot: "/workspace",
    dateLabel: "Wed",
    gitSummary: "main",
    mcpSummaries: [],
  });
  assert.match(reminder, /Workflow mode/);
  assert.match(reminder, /workflow_run/);
  assert.match(reminder, /pipeline\(\)/);
  assert.match(reminder, /export const meta/);
});

test("persistWorkflowScript writes under the workspace workflows directory", async () => {
  const previous = process.env.OPENCURSOR_DATA_DIR;
  // DATA_DIR already resolved; this test only asserts the helper returns a path ending in .js
  const workspace: WorkspaceRecord = {
    id: `ws-${Date.now()}`,
    root: "/tmp",
    name: "Persist",
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
  };
  const scriptPath = await persistWorkflowScript({
    workspace,
    runId: "run-123",
    script: SAMPLE_SCRIPT,
  });
  assert.match(scriptPath, /run-123\.js$/);
  void previous;
});
