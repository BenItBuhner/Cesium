import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  createWorkflowRunRecord,
  readWorkflowRun,
  updateWorkflowRunStatus,
  upsertWorkflowRun,
} from "../src/lib/agents/workflow-store.js";
import {
  resetWorkflowRunForReplay,
  WorkflowRunManager,
} from "../src/lib/agents/workflow-run-manager.js";
import { DATA_DIR } from "../src/lib/persistence.js";
import type { WorkspaceRecord } from "../src/lib/workspace-registry.js";

function workspace(id: string): WorkspaceRecord {
  return {
    id,
    root: "/tmp",
    name: id,
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
  };
}

async function cleanupWorkspace(id: string): Promise<void> {
  await rm(path.join(DATA_DIR, "workspaces", id), { recursive: true, force: true });
}

test("workflow manager pauses at checkpoint and resumes execution", async () => {
  const ws = workspace(`ws-workflow-pause-${process.pid}-${Date.now()}`);
  const manager = new WorkflowRunManager();
  const script = `export const meta = { name: "pause", description: "pause demo", phases: [] };
const value = await agent("after-pause", { label: "child" });
return value;
`;
  try {
    const run = await upsertWorkflowRun(
      createWorkflowRunRecord({
        workspace: ws,
        conversationId: "conv-pause",
        script,
        scriptPath: "/tmp/pause.js",
      })
    );
    let spawned = 0;
    const managed = manager.start({
      run,
      spawnAgent: async () => {
        spawned += 1;
        return { value: "resumed", tokensUsed: 1 };
      },
    });

    managed.pause();
    await managed.waitUntilPaused();
    const paused = await readWorkflowRun({ workspaceId: ws.id, runId: run.runId });
    assert.equal(paused?.status, "paused");
    assert.equal(spawned, 0);

    managed.resume();
    const completed = await managed.promise;
    assert.equal(completed.status, "completed");
    assert.equal(completed.returnValue, "resumed");
    assert.equal(spawned, 1);
  } finally {
    await cleanupWorkspace(ws.id);
  }
});

test("workflow pause serializes concurrent child checkpoints without deadlock", async () => {
  const ws = workspace(`ws-workflow-pause-concurrent-${process.pid}-${Date.now()}`);
  const manager = new WorkflowRunManager();
  const script = `export const meta = { name: "pause-concurrent", description: "pause concurrent children", phases: [] };
return await parallel([
  () => agent("first", { label: "first" }),
  () => agent("second", { label: "second" }),
]);
`;
  try {
    const run = await upsertWorkflowRun(
      createWorkflowRunRecord({
        workspace: ws,
        conversationId: "conv-pause-concurrent",
        script,
        scriptPath: "/tmp/pause-concurrent.js",
        maxConcurrent: 2,
      })
    );
    let started = 0;
    let releaseChildren!: () => void;
    const childrenReleased = new Promise<void>((resolve) => {
      releaseChildren = resolve;
    });
    let bothStarted!: () => void;
    const bothStartedPromise = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const managed = manager.start({
      run,
      spawnAgent: async (request) => {
        started += 1;
        if (started === 2) {
          bothStarted();
        }
        await childrenReleased;
        await request.checkpoint?.();
        return { value: request.prompt, tokensUsed: 1 };
      },
    });

    await bothStartedPromise;
    managed.pause();
    releaseChildren();
    await managed.waitUntilPaused();
    assert.equal((await readWorkflowRun({ workspaceId: ws.id, runId: run.runId }))?.status, "paused");

    managed.resume();
    const completed = await managed.promise;
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.returnValue, ["first", "second"]);
  } finally {
    await cleanupWorkspace(ws.id);
  }
});

test("workflow manager stop aborts active child and records cancelled", async () => {
  const ws = workspace(`ws-workflow-stop-${process.pid}-${Date.now()}`);
  const manager = new WorkflowRunManager();
  const script = `export const meta = { name: "stop", description: "stop demo", phases: [] };
return await agent("long child", { label: "child" });
`;
  try {
    const run = await upsertWorkflowRun(
      createWorkflowRunRecord({
        workspace: ws,
        conversationId: "conv-stop",
        script,
        scriptPath: "/tmp/stop.js",
      })
    );
    let childStarted!: () => void;
    const childStartedPromise = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    const managed = manager.start({
      run,
      spawnAgent: async (request) => {
        childStarted();
        return new Promise<never>((_, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => reject(new Error("child aborted by workflow stop")),
            { once: true }
          );
        });
      },
    });

    await childStartedPromise;
    await manager.stop(ws.id, run.runId);
    const completed = await managed.promise;
    assert.equal(completed.status, "cancelled");
    assert.match(completed.error ?? "", /abort|cancel/i);
  } finally {
    await cleanupWorkspace(ws.id);
  }
});

test("workflow manager stops every active background run for a conversation", async () => {
  const ws = workspace(`ws-workflow-stop-conversation-${process.pid}-${Date.now()}`);
  const manager = new WorkflowRunManager();
  const script = `export const meta = { name: "stop-conversation", description: "stop background runs", phases: [] };
return await agent("long child");
`;
  try {
    const runs = await Promise.all(
      ["first", "second"].map((label) =>
        upsertWorkflowRun(
          createWorkflowRunRecord({
            workspace: ws,
            conversationId: "conv-stop-all",
            script,
            scriptPath: `/tmp/stop-${label}.js`,
          })
        )
      )
    );
    const managed = runs.map((run) =>
      manager.start({
        run,
        spawnAgent: async (request) =>
          new Promise<never>((_, reject) => {
            request.signal?.addEventListener(
              "abort",
              () => reject(new Error("background child aborted")),
              { once: true }
            );
          }),
      })
    );

    assert.equal(manager.stopConversation(ws.id, "conv-stop-all"), 2);
    const completed = await Promise.all(managed.map((entry) => entry.promise));
    assert.deepEqual(completed.map((run) => run.status), ["cancelled", "cancelled"]);
  } finally {
    await cleanupWorkspace(ws.id);
  }
});

test("workflow stop persists queued agents and terminalizes queued and active agents", async () => {
  const ws = workspace(`ws-workflow-stop-queued-${process.pid}-${Date.now()}`);
  const manager = new WorkflowRunManager();
  const script = `export const meta = { name: "stop-queued", description: "stop queued agents", phases: [] };
return await parallel([
  () => agent("first child", { label: "first" }),
  () => agent("second child", { label: "second" }),
]);
`;
  try {
    const run = await upsertWorkflowRun(
      createWorkflowRunRecord({
        workspace: ws,
        conversationId: "conv-stop-queued",
        script,
        scriptPath: "/tmp/stop-queued.js",
        maxConcurrent: 1,
      })
    );
    let observedQueued!: () => void;
    const queued = new Promise<void>((resolve) => {
      observedQueued = resolve;
    });
    let queuedObserved = false;
    const managed = manager.start({
      run,
      onUpdate: (updated) => {
        if (
          updated.agents.some((agent) => agent.status === "running") &&
          updated.agents.some((agent) => agent.status === "queued")
        ) {
          queuedObserved = true;
          observedQueued();
        }
      },
      spawnAgent: async (request) =>
        new Promise<never>((_, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => reject(new Error("active child aborted by workflow stop")),
            { once: true }
          );
        }),
    });

    await queued;
    assert.equal(queuedObserved, true);
    await manager.stop(ws.id, run.runId);
    const completed = await managed.promise;

    assert.equal(completed.status, "cancelled");
    assert.deepEqual(
      completed.agents.map((agent) => agent.status),
      ["skipped", "skipped"]
    );
    assert.ok(completed.agents.every((agent) => agent.completedAt !== null));
    assert.ok(completed.agents.every((agent) => /abort|cancel/i.test(agent.error ?? "")));
    assert.deepEqual(
      completed.agents.map((agent) => agent.tokensUsed),
      [0, 0]
    );
  } finally {
    await cleanupWorkspace(ws.id);
  }
});

test("workflow restart can reuse prior completed journal entries", async () => {
  const ws = workspace(`ws-workflow-restart-${process.pid}-${Date.now()}`);
  const manager = new WorkflowRunManager();
  const script = `export const meta = { name: "restart", description: "restart demo", phases: [] };
const value = await agent("same child", { label: "child" });
return { value, args };
`;
  try {
    const first = await upsertWorkflowRun(
      createWorkflowRunRecord({
        workspace: ws,
        conversationId: "conv-restart",
        script,
        scriptPath: "/tmp/restart.js",
        args: { topic: "journal" },
      })
    );
    const firstCompleted = await manager.start({
      run: first,
      spawnAgent: async () => ({ value: "from-live-child", tokensUsed: 3 }),
    }).promise;
    assert.equal(firstCompleted.journal.length, 1);

    const restarted = await upsertWorkflowRun(
      createWorkflowRunRecord({
        workspace: ws,
        conversationId: firstCompleted.conversationId,
        script: firstCompleted.script,
        scriptPath: "/tmp/restart-new.js",
        args: firstCompleted.args,
        tokenBudget: firstCompleted.tokenBudget,
        maxAgents: firstCompleted.maxAgents,
        maxConcurrent: firstCompleted.maxConcurrent,
        resumeFromRunId: firstCompleted.runId,
      })
    );
    let liveCalls = 0;
    const replayed = await manager.start({
      run: restarted,
      journalSeed: firstCompleted.journal,
      spawnAgent: async () => {
        liveCalls += 1;
        return { value: "unexpected-live", tokensUsed: 1 };
      },
    }).promise;

    assert.equal(replayed.status, "completed");
    assert.deepEqual(replayed.returnValue, {
      value: "from-live-child",
      args: { topic: "journal" },
    });
    assert.equal(liveCalls, 0);
  } finally {
    await cleanupWorkspace(ws.id);
  }
});

test("workflow stale running run reconciles to paused and can replay", async () => {
  const ws = workspace(`ws-workflow-stale-${process.pid}-${Date.now()}`);
  const manager = new WorkflowRunManager();
  const script = `export const meta = { name: "stale", description: "stale demo", phases: [] };
return await agent("replay child", { label: "child" });
`;
  try {
    const run = await updateWorkflowRunStatus(
      await upsertWorkflowRun(
        createWorkflowRunRecord({
          workspace: ws,
          conversationId: "conv-stale",
          script,
          scriptPath: "/tmp/stale.js",
        })
      ),
      "running"
    );

    const reconciled = await manager.reconcileStaleRun(run);
    assert.equal(reconciled.status, "paused");

    const replay = resetWorkflowRunForReplay(
      reconciled,
      "Test replay after stale reconciliation."
    );
    const completed = await manager.start({
      run: replay,
      journalSeed: reconciled.journal,
      spawnAgent: async () => ({ value: "replayed", tokensUsed: 2 }),
    }).promise;
    assert.equal(completed.status, "completed");
    assert.equal(completed.returnValue, "replayed");
  } finally {
    await cleanupWorkspace(ws.id);
  }
});

test("workflow manager removes active registry entry after completion", async () => {
  const ws = workspace(`ws-workflow-cleanup-${process.pid}-${Date.now()}`);
  const manager = new WorkflowRunManager();
  const script = `export const meta = { name: "cleanup", description: "cleanup demo", phases: [] };
return "done";
`;
  try {
    const run = await upsertWorkflowRun(
      createWorkflowRunRecord({
        workspace: ws,
        conversationId: "conv-cleanup",
        script,
        scriptPath: "/tmp/cleanup.js",
      })
    );
    const managed = manager.start({
      run,
      spawnAgent: async () => ({ value: "unused", tokensUsed: 0 }),
    });
    assert.equal(manager.get(ws.id, run.runId), managed);
    const completed = await managed.promise;
    assert.equal(completed.status, "completed");
    assert.equal(manager.get(ws.id, run.runId), null);
  } finally {
    await cleanupWorkspace(ws.id);
  }
});
