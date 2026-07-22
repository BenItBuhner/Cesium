import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileWorkflowScript, executeWorkflowRun } from "../src/lib/agents/workflow-runtime.js";
import {
  createWorkflowRunRecord,
  hashWorkflowAgentCall,
  persistWorkflowScript,
  readWorkflowScriptFile,
  readWorkflowRun,
  upsertWorkflowRun,
} from "../src/lib/agents/workflow-store.js";
import { DATA_DIR } from "../src/lib/persistence.js";
import { serializeWorkflowRunSnapshot } from "../src/lib/agents/workflow-snapshot.js";
import type { WorkspaceRecord } from "../src/lib/workspace-registry.js";
import {
  WORKFLOW_DEFAULT_MAX_AGENTS,
  WORKFLOW_DEFAULT_MAX_CONCURRENT,
  WorkflowAgentSpawnError,
} from "../src/lib/agents/workflow-types.js";
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

  const stringPhases = compileWorkflowScript(
    `export const meta = { name: "strings", description: "string phases", phases: ["Inspect", "Synthesize"] };\nreturn 1;`
  );
  assert.equal(stringPhases.ok, true);
  if (stringPhases.ok) {
    assert.deepEqual(
      stringPhases.meta.phases.map((phase) => phase.title),
      ["Inspect", "Synthesize"]
    );
  }
});

test("workflow snapshots infer the active phase from agent records", () => {
  const workspace: WorkspaceRecord = {
    id: "ws-workflow-snapshot-phase",
    root: "/tmp",
    name: "Snapshot phase",
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
  };
  const run = createWorkflowRunRecord({
    workspace,
    conversationId: "conv-snapshot-phase",
    script: SAMPLE_SCRIPT,
    scriptPath: "/tmp/snapshot-phase.js",
  });
  const snapshot = serializeWorkflowRunSnapshot({
    ...run,
    status: "running",
    agentsUsed: 1,
    agents: [
      {
        id: "inspect-1",
        label: "Inspect package",
        phase: "Inspect",
        prompt: "Inspect package.json",
        status: "running",
        tokensUsed: 0,
        startedAt: 10,
        completedAt: null,
      },
    ],
  });
  assert.equal(snapshot.currentPhase, "Inspect");
});

test("workflow run records default to Claude-parity runtime caps", () => {
  const workspace: WorkspaceRecord = {
    id: "ws-workflow-default-caps",
    root: "/tmp",
    name: "Workflow defaults",
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
  };
  const defaults = createWorkflowRunRecord({
    workspace,
    conversationId: "conv-default-caps",
    script: SAMPLE_SCRIPT,
    scriptPath: "/tmp/default-caps.js",
  });
  assert.equal(WORKFLOW_DEFAULT_MAX_AGENTS, 1000);
  assert.equal(WORKFLOW_DEFAULT_MAX_CONCURRENT, 16);
  assert.equal(defaults.maxAgents, 1000);
  assert.equal(defaults.maxConcurrent, 16);

  const clamped = createWorkflowRunRecord({
    workspace,
    conversationId: "conv-clamped-caps",
    script: SAMPLE_SCRIPT,
    scriptPath: "/tmp/clamped-caps.js",
    maxAgents: 10_000,
    maxConcurrent: 100,
  });
  assert.equal(clamped.maxAgents, 1000);
  assert.equal(clamped.maxConcurrent, 16);
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
    assert.deepEqual(
      completed.agents.map((agent) => agent.tokensUsed),
      [12, 12, 12, 12]
    );
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
  assert.deepEqual(
    completed.agents.map((item) => item.tokensUsed),
    [5, 0]
  );
});

test("workflow semaphore never exceeds configured concurrency", async () => {
  const workspace: WorkspaceRecord = {
    id: `ws-workflow-concurrency-${process.pid}-${Date.now()}`,
    root: "/tmp",
    name: "Workflow concurrency",
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
  };
  const script = `export const meta = { name: "concurrency", description: "concurrency cap", phases: [] };
return await parallel([
  () => agent("one"),
  () => agent("two"),
  () => agent("three"),
  () => agent("four"),
  () => agent("five"),
  () => agent("six"),
]);
`;
  try {
    let run = createWorkflowRunRecord({
      workspace,
      conversationId: "conv-concurrency",
      script,
      scriptPath: "/tmp/concurrency.js",
      maxConcurrent: 2,
    });
    run = await upsertWorkflowRun(run);
    let active = 0;
    let maximum = 0;
    const completed = await executeWorkflowRun({
      run,
      spawnAgent: async (request) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { value: request.prompt, tokensUsed: 1 };
      },
    });

    assert.equal(completed.status, "completed");
    assert.equal(maximum, 2);
  } finally {
    await rm(path.join(DATA_DIR, "workspaces", workspace.id), {
      recursive: true,
      force: true,
    });
  }
});

test("workflow runtime threads remaining budget and records failed child usage", async () => {
  const workspace: WorkspaceRecord = {
    id: `ws-workflow-budget-${process.pid}-${Date.now()}`,
    root: "/tmp",
    name: "Workflow budget",
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
  };
  const script = `export const meta = { name: "budget", description: "budget demo", phases: [] };
return await agent("bounded child");
`;
  try {
    let run = createWorkflowRunRecord({
      workspace,
      conversationId: "conv-budget",
      script,
      scriptPath: "/tmp/budget.js",
      tokenBudget: 25,
      maxAgents: 1,
    });
    run = await upsertWorkflowRun(run);

    const completed = await executeWorkflowRun({
      run,
      spawnAgent: async (request) => {
        assert.equal(request.tokenBudget, 25);
        throw new WorkflowAgentSpawnError("provider failed after a tool turn", 7);
      },
    });

    assert.equal(completed.status, "completed");
    assert.equal(completed.returnValue, null);
    assert.equal(completed.tokensUsed, 7);
    assert.equal(completed.agents[0]?.status, "failed");
    assert.equal(completed.agents[0]?.tokensUsed, 7);
  } finally {
    await rm(path.join(DATA_DIR, "workspaces", workspace.id), { recursive: true, force: true });
  }
});

test("upsertWorkflowRun preserves concurrent distinct runs in one workspace", async () => {
  const workspace: WorkspaceRecord = {
    id: `ws-workflow-upsert-${process.pid}-${Date.now()}`,
    root: "/tmp",
    name: "Workflow upsert race",
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
  };
  try {
    const runs = Array.from({ length: 20 }, (_, index) =>
      createWorkflowRunRecord({
        workspace,
        conversationId: `conv-upsert-${index}`,
        script: SAMPLE_SCRIPT,
        scriptPath: `/tmp/upsert-${index}.js`,
      })
    );

    await Promise.all(runs.map((run) => upsertWorkflowRun(run)));

    const persisted = await Promise.all(
      runs.map((run) => readWorkflowRun({ workspaceId: workspace.id, runId: run.runId }))
    );
    assert.equal(persisted.filter(Boolean).length, runs.length);
  } finally {
    await rm(path.join(DATA_DIR, "workspaces", workspace.id), { recursive: true, force: true });
  }
});

test("workflow immediate phase and log writes do not regress persisted completed status", async () => {
  const workspace: WorkspaceRecord = {
    id: `ws-workflow-immediate-${process.pid}-${Date.now()}`,
    root: "/tmp",
    name: "Workflow immediate return",
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
  };
  const script = `export const meta = { name: "instant", description: "instant return", phases: [{ title: "One" }] };
phase("One");
log("ready");
return "done";
`;
  try {
    let run = createWorkflowRunRecord({
      workspace,
      conversationId: "conv-immediate",
      script,
      scriptPath: "/tmp/instant.js",
    });
    run = await upsertWorkflowRun(run);

    const completed = await executeWorkflowRun({
      run,
      spawnAgent: async () => ({ value: null, tokensUsed: 0 }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const persisted = await readWorkflowRun({ workspaceId: workspace.id, runId: run.runId });
    assert.equal(completed.status, "completed");
    assert.equal(persisted?.status, "completed");
    assert.equal(persisted?.returnValue, "done");
    assert.equal(persisted?.logs.some((entry) => entry.message === "ready"), true);
  } finally {
    await rm(path.join(DATA_DIR, "workspaces", workspace.id), { recursive: true, force: true });
  }
});

test("hashWorkflowAgentCall is stable for identical prompt/opts", () => {
  const a = hashWorkflowAgentCall("hello", { label: "x", phase: "Scan" });
  const b = hashWorkflowAgentCall("hello", { label: "x", phase: "Scan" });
  const c = hashWorkflowAgentCall("hello", { label: "y", phase: "Scan" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("Workflow mode policy allows workflow tools and blocks goal/orchestration", () => {
  assert.equal(resolveCesiumModeToolPolicy({ mode: "workflow", toolName: "workflow_run" }).allowed, true);
  assert.equal(resolveCesiumModeToolPolicy({ mode: "workflow", toolName: "workflow_control" }).allowed, true);
  assert.equal(resolveCesiumModeToolPolicy({ mode: "workflow", toolName: "edit_file" }).allowed, true);
  assert.equal(resolveCesiumModeToolPolicy({ mode: "workflow", toolName: "goal_set" }).allowed, false);
  assert.equal(
    resolveCesiumModeToolPolicy({ mode: "workflow", toolName: "orchestration_create_issue" }).allowed,
    false
  );
  assert.equal(resolveCesiumModeToolPolicy({ mode: "agent", toolName: "workflow_run" }).allowed, false);
  assert.equal(resolveCesiumModeToolPolicy({ mode: "goal", toolName: "workflow_run" }).allowed, false);
  const summary = summarizeCesiumModeToolPolicy("workflow");
  assert.equal(summary.allowed.includes("workflow_run"), true);
  assert.equal(summary.allowed.includes("workflow_control"), true);
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
  assert.match(reminder, /workflow_control/);
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

test("workflow script paths stay inside the workspace or persisted workflow directory", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "cesium-workflow-path-workspace-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "cesium-workflow-path-outside-"));
  const workspace: WorkspaceRecord = {
    id: `ws-workflow-path-${process.pid}-${Date.now()}`,
    root: workspaceRoot,
    name: "Workflow path policy",
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
  };
  const script = `export const meta = { name: "path", description: "path policy" }; return 1;`;
  try {
    const workspaceScript = path.join(workspaceRoot, "workflow.js");
    const outsideScript = path.join(outsideRoot, "outside.js");
    const linkedScript = path.join(workspaceRoot, "linked.js");
    await writeFile(workspaceScript, script, "utf8");
    await writeFile(outsideScript, script, "utf8");
    await symlink(outsideScript, linkedScript);

    assert.equal(
      await readWorkflowScriptFile({ workspace, scriptPath: workspaceScript }),
      script
    );
    assert.equal(
      await readWorkflowScriptFile({ workspace, scriptPath: "workflow.js" }),
      script
    );
    await assert.rejects(
      () => readWorkflowScriptFile({ workspace, scriptPath: outsideScript }),
      /must resolve inside the active workspace/
    );
    await assert.rejects(
      () => readWorkflowScriptFile({ workspace, scriptPath: linkedScript }),
      /must resolve inside the active workspace/
    );

    const persistedPath = await persistWorkflowScript({
      workspace,
      runId: "path-policy",
      script,
    });
    assert.equal(
      await readWorkflowScriptFile({ workspace, scriptPath: persistedPath }),
      script
    );
  } finally {
    await Promise.all([
      rm(workspaceRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
      rm(path.join(DATA_DIR, "workspaces", workspace.id), { recursive: true, force: true }),
    ]);
  }
});

test("persistWorkflowScript rejects symlink escapes", async () => {
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "cesium-workflow-persist-outside-"));
  const workspace: WorkspaceRecord = {
    id: `ws-workflow-persist-path-${process.pid}-${Date.now()}`,
    root: "/tmp",
    name: "Workflow persistence path policy",
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
  };
  const workspaceDataDir = path.join(DATA_DIR, "workspaces", workspace.id);
  try {
    await mkdir(workspaceDataDir, { recursive: true });
    await symlink(outsideRoot, path.join(workspaceDataDir, "workflows"));
    await assert.rejects(
      () =>
        persistWorkflowScript({
          workspace,
          runId: "escape",
          script: SAMPLE_SCRIPT,
        }),
      /must stay inside the workspace data directory/
    );
  } finally {
    await Promise.all([
      rm(outsideRoot, { recursive: true, force: true }),
      rm(workspaceDataDir, { recursive: true, force: true }),
    ]);
  }
});
