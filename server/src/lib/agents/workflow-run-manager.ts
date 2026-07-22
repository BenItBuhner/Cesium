import {
  appendWorkflowLog,
  updateWorkflowRunStatus,
  upsertWorkflowRun,
} from "./workflow-store.js";
import { executeWorkflowRun } from "./workflow-runtime.js";
import {
  WORKFLOW_LOG_LIMIT,
  type WorkflowAgentSpawner,
  type WorkflowJournalEntry,
  type WorkflowRunLifecycleControl,
  type WorkflowRunRecord,
  type WorkflowRunUpdateHandler,
} from "./workflow-types.js";

type ManagedWorkflowState = "running" | "pause_requested" | "paused" | "stopped";

export type WorkflowRunStartInput = {
  run: WorkflowRunRecord;
  spawnAgent: WorkflowAgentSpawner;
  journalSeed?: WorkflowJournalEntry[];
  onUpdate?: WorkflowRunUpdateHandler;
};

function workflowRunKey(workspaceId: string, runId: string): string {
  return `${workspaceId}:${runId}`;
}

function abortError(): Error {
  const error = new Error("Workflow run cancelled.");
  error.name = "AbortError";
  return error;
}

export function resetWorkflowRunForReplay(
  run: WorkflowRunRecord,
  message: string
): WorkflowRunRecord {
  return {
    ...run,
    status: "pending",
    tokensUsed: 0,
    agentsUsed: 0,
    currentPhase: null,
    agents: [],
    logs: [
      ...run.logs,
      {
        at: Date.now(),
        message,
        phase: null,
      },
    ].slice(-WORKFLOW_LOG_LIMIT),
    returnValue: undefined,
    error: null,
    completedAt: null,
    updatedAt: Date.now(),
  };
}

export class ManagedWorkflowRun implements WorkflowRunLifecycleControl {
  readonly signal: AbortSignal;
  readonly key: string;
  readonly runId: string;
  readonly workspaceId: string;

  private readonly controller = new AbortController();
  private state: ManagedWorkflowState = "running";
  private resumeWaiter: (() => void) | null = null;
  private pausedWaiters: Array<() => void> = [];
  private runPromise: Promise<WorkflowRunRecord> | null = null;

  constructor(run: WorkflowRunRecord) {
    this.key = workflowRunKey(run.workspaceId, run.runId);
    this.runId = run.runId;
    this.workspaceId = run.workspaceId;
    this.signal = this.controller.signal;
  }

  setPromise(promise: Promise<WorkflowRunRecord>): void {
    this.runPromise = promise;
  }

  get promise(): Promise<WorkflowRunRecord> {
    if (!this.runPromise) {
      throw new Error("Workflow run has not started.");
    }
    return this.runPromise;
  }

  pause(): void {
    if (this.state === "stopped") {
      return;
    }
    if (this.state === "paused" || this.state === "pause_requested") {
      return;
    }
    this.state = "pause_requested";
  }

  resume(): void {
    if (this.state === "stopped") {
      return;
    }
    if (this.state === "paused" || this.state === "pause_requested") {
      this.state = "running";
      this.resumeWaiter?.();
      this.resumeWaiter = null;
    }
  }

  stop(): void {
    if (this.state === "stopped") {
      return;
    }
    this.state = "stopped";
    this.controller.abort();
    this.resumeWaiter?.();
    this.resumeWaiter = null;
    this.resolvePausedWaiters();
  }

  isPaused(): boolean {
    return this.state === "paused";
  }

  isPauseRequested(): boolean {
    return this.state === "pause_requested";
  }

  isStopRequested(): boolean {
    return this.state === "stopped" || this.signal.aborted;
  }

  throwIfStopped(): void {
    if (this.isStopRequested()) {
      throw abortError();
    }
  }

  waitUntilPaused(): Promise<void> {
    if (this.state === "paused" || this.state === "stopped") {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.pausedWaiters.push(resolve);
    });
  }

  async checkpoint(
    run: WorkflowRunRecord,
    context: {
      currentPhase?: string | null;
      onUpdate?: WorkflowRunUpdateHandler;
    } = {}
  ): Promise<WorkflowRunRecord> {
    this.throwIfStopped();
    if (this.state !== "pause_requested" && this.state !== "paused") {
      return run;
    }

    this.state = "paused";
    let paused = await updateWorkflowRunStatus(run, "paused", {
      currentPhase: context.currentPhase ?? run.currentPhase,
    });
    paused = await appendWorkflowLog(
      paused,
      "Workflow paused at lifecycle checkpoint.",
      context.currentPhase ?? run.currentPhase
    );
    await context.onUpdate?.(paused);
    this.resolvePausedWaiters();
    this.throwIfStopped();

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.signal.removeEventListener("abort", onAbort);
        this.resumeWaiter = null;
        reject(abortError());
      };
      this.resumeWaiter = () => {
        this.signal.removeEventListener("abort", onAbort);
        this.resumeWaiter = null;
        resolve();
      };
      this.signal.addEventListener("abort", onAbort, { once: true });
      if (this.signal.aborted) {
        onAbort();
        return;
      }
      if (this.state !== "paused") {
        this.resumeWaiter();
      }
    });
    this.throwIfStopped();

    let resumed = await updateWorkflowRunStatus(paused, "running", {
      currentPhase: paused.currentPhase,
      error: null,
      completedAt: null,
    });
    resumed = await appendWorkflowLog(
      resumed,
      "Workflow resumed from lifecycle checkpoint.",
      resumed.currentPhase
    );
    await context.onUpdate?.(resumed);
    return resumed;
  }

  private resolvePausedWaiters(): void {
    const waiters = this.pausedWaiters;
    this.pausedWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }
}

export class WorkflowRunManager {
  private readonly active = new Map<string, ManagedWorkflowRun>();

  start(input: WorkflowRunStartInput): ManagedWorkflowRun {
    const key = workflowRunKey(input.run.workspaceId, input.run.runId);
    const existing = this.active.get(key);
    if (existing) {
      return existing;
    }

    const managed = new ManagedWorkflowRun(input.run);
    this.active.set(key, managed);
    const promise = executeWorkflowRun({
      run: input.run,
      spawnAgent: input.spawnAgent,
      journalSeed: input.journalSeed,
      onUpdate: input.onUpdate,
      control: managed,
    }).finally(() => {
      if (this.active.get(key) === managed) {
        this.active.delete(key);
      }
    });
    managed.setPromise(promise);
    void promise.catch(() => undefined);
    return managed;
  }

  get(workspaceId: string, runId: string): ManagedWorkflowRun | null {
    return this.active.get(workflowRunKey(workspaceId, runId)) ?? null;
  }

  has(workspaceId: string, runId: string): boolean {
    return this.active.has(workflowRunKey(workspaceId, runId));
  }

  async reconcileStaleRun(
    run: WorkflowRunRecord,
    onUpdate?: WorkflowRunUpdateHandler
  ): Promise<WorkflowRunRecord> {
    if (this.has(run.workspaceId, run.runId)) {
      return run;
    }
    if (run.status !== "running" && run.status !== "pending") {
      return run;
    }
    let paused = await updateWorkflowRunStatus(run, "paused", {
      currentPhase: run.currentPhase,
      error: null,
      completedAt: null,
    });
    paused = await appendWorkflowLog(
      paused,
      "Workflow paused after server restart because no active in-process manager owns it.",
      run.currentPhase
    );
    await onUpdate?.(paused);
    return paused;
  }

  async stop(workspaceId: string, runId: string): Promise<boolean> {
    const managed = this.get(workspaceId, runId);
    if (!managed) {
      return false;
    }
    managed.stop();
    return true;
  }
}

export const workflowRunManager = new WorkflowRunManager();
