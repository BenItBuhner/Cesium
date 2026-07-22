export type WorkflowRunStatus =
  | "pending"
  | "compiling"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowAgentStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cached"
  | "skipped";

export type WorkflowPhaseMeta = {
  title: string;
  detail?: string;
  model?: string;
};

export type WorkflowMeta = {
  name: string;
  description: string;
  whenToUse?: string;
  phases: WorkflowPhaseMeta[];
};

export type WorkflowAgentRecord = {
  id: string;
  label: string;
  phase: string | null;
  prompt: string;
  status: WorkflowAgentStatus;
  startedAt: number | null;
  completedAt: number | null;
  error?: string;
  resultPreview?: string;
};

export type WorkflowLogEntry = {
  at: number;
  message: string;
  phase?: string | null;
};

export type WorkflowJournalEntry = {
  key: string;
  prompt: string;
  optsHash: string;
  result: unknown;
  completedAt: number;
};

export type WorkflowRunRecord = {
  schemaVersion: 1;
  runId: string;
  workspaceId: string;
  conversationId: string;
  status: WorkflowRunStatus;
  meta: WorkflowMeta;
  script: string;
  scriptPath: string;
  args: unknown;
  tokenBudget: number | null;
  tokensUsed: number;
  maxAgents: number;
  maxConcurrent: number;
  agentsUsed: number;
  currentPhase: string | null;
  agents: WorkflowAgentRecord[];
  logs: WorkflowLogEntry[];
  journal: WorkflowJournalEntry[];
  returnValue: unknown;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type WorkflowAgentSpawnRequest = {
  prompt: string;
  workflowRunId?: string;
  label?: string;
  phase?: string | null;
  schema?: Record<string, unknown>;
  model?: string;
  effort?: string;
  /** Remaining best-effort token budget available to this child invocation. */
  tokenBudget?: number;
  /** Optional lifecycle signal for callers that can cancel an active child request. */
  signal?: AbortSignal;
  /** Optional lifecycle checkpoint for child loops between provider/tool work. */
  checkpoint?: () => Promise<void>;
};

export type WorkflowAgentSpawnResult = {
  value: unknown;
  tokensUsed?: number;
};

export type WorkflowAgentSpawner = (
  request: WorkflowAgentSpawnRequest
) => Promise<WorkflowAgentSpawnResult>;

export type WorkflowRunUpdateHandler = (
  run: WorkflowRunRecord
) => void | Promise<void>;

export type WorkflowRunLifecycleControl = {
  readonly signal: AbortSignal;
  checkpoint(
    run: WorkflowRunRecord,
    context?: {
      currentPhase?: string | null;
      onUpdate?: WorkflowRunUpdateHandler;
    }
  ): Promise<WorkflowRunRecord>;
  isStopRequested(): boolean;
  throwIfStopped(): void;
};

export class WorkflowAgentSpawnError extends Error {
  readonly tokensUsed: number;

  constructor(message: string, tokensUsed: number) {
    super(message);
    this.name = "WorkflowAgentSpawnError";
    this.tokensUsed = Math.max(0, Math.floor(tokensUsed));
  }
}

export const WORKFLOW_DEFAULT_MAX_AGENTS = 50;
export const WORKFLOW_DEFAULT_MAX_CONCURRENT = 8;
export const WORKFLOW_LOG_LIMIT = 200;
export const WORKFLOW_JOURNAL_LIMIT = 500;

export function createEmptyWorkflowMeta(): WorkflowMeta {
  return {
    name: "untitled-workflow",
    description: "",
    phases: [],
  };
}

export function formatWorkflowRunForModel(run: WorkflowRunRecord): string {
  const lines = [
    `## Active Workflow Run`,
    `- Run id: ${run.runId}`,
    `- Name: ${run.meta.name}`,
    `- Status: ${run.status}`,
    `- Phase: ${run.currentPhase ?? "(none)"}`,
    `- Agents used: ${run.agentsUsed}/${run.maxAgents}`,
    `- Tokens used: ${run.tokensUsed}${run.tokenBudget != null ? ` / ${run.tokenBudget}` : ""}`,
    `- Script path: ${run.scriptPath}`,
  ];
  if (run.error) {
    lines.push(`- Error: ${run.error}`);
  }
  if (run.returnValue !== undefined && run.status === "completed") {
    const preview =
      typeof run.returnValue === "string"
        ? run.returnValue.slice(0, 1200)
        : JSON.stringify(run.returnValue)?.slice(0, 1200);
    lines.push(`- Return value preview: ${preview ?? "(empty)"}`);
  }
  const recentLogs = run.logs.slice(-8);
  if (recentLogs.length > 0) {
    lines.push("", "### Recent workflow logs");
    for (const entry of recentLogs) {
      lines.push(`- ${entry.message}`);
    }
  }
  return lines.join("\n");
}
