import type { WorkflowRunSnapshot } from "@cesium/core";
import type { WorkflowRunRecord, WorkflowRunStatus } from "./workflow-types.js";

const PREVIEW_LIMIT = 2000;
const PROMPT_PREVIEW_LIMIT = 400;
const RECENT_LOG_LIMIT = 12;

function previewUnknown(value: unknown, limit = PREVIEW_LIMIT): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value.slice(0, limit);
  }
  try {
    return JSON.stringify(value)?.slice(0, limit) ?? null;
  } catch {
    return String(value).slice(0, limit);
  }
}

export function workflowSnapshotToolStatus(
  status: WorkflowRunStatus
): "in_progress" | "completed" | "failed" | "cancelled" {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "in_progress";
  }
}

export function serializeWorkflowRunSnapshot(
  run: WorkflowRunRecord,
  options: { agentLimit?: number } = {}
): WorkflowRunSnapshot {
  const agentLimit =
    typeof options.agentLimit === "number" && Number.isFinite(options.agentLimit)
      ? Math.max(1, Math.floor(options.agentLimit))
      : run.agents.length || 1;
  const agents = run.agents.slice(-agentLimit);
  const inferredActivePhase =
    [...run.agents]
      .reverse()
      .find((agent) => agent.status === "running" || agent.status === "queued")
      ?.phase ?? null;
  const inferredLatestPhase =
    [...run.agents]
      .reverse()
      .find((agent) => agent.phase && agent.startedAt != null)
      ?.phase ?? null;
  const currentPhase =
    run.currentPhase ??
    inferredActivePhase ??
    (run.status === "running" || run.status === "paused"
      ? inferredLatestPhase
      : null);
  return {
    runId: run.runId,
    name: run.meta.name,
    description: run.meta.description,
    status: run.status,
    currentPhase,
    tokenBudget: run.tokenBudget,
    tokensUsed: run.tokensUsed,
    maxAgents: run.maxAgents,
    agentsUsed: run.agentsUsed,
    maxConcurrent: run.maxConcurrent,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    scriptPath: run.scriptPath,
    recentLogs: run.logs.slice(-RECENT_LOG_LIMIT).map((entry) => ({
      at: entry.at,
      message: entry.message,
      phase: entry.phase ?? null,
    })),
    returnPreview: previewUnknown(run.returnValue),
    errorPreview: previewUnknown(run.error),
    phases: run.meta.phases.map((phase) => ({
      title: phase.title,
      ...(phase.detail ? { detail: phase.detail } : {}),
      ...(phase.model ? { model: phase.model } : {}),
    })),
    agentRecordsTotal: run.agents.length,
    agentsTruncated: agents.length < run.agents.length,
    agents: agents.map((agent) => ({
      id: agent.id,
      label: agent.label,
      phase: agent.phase,
      status: agent.status,
      tokensUsed: Math.max(0, Math.floor(agent.tokensUsed ?? 0)),
      startedAt: agent.startedAt,
      completedAt: agent.completedAt,
      promptPreview: agent.prompt.slice(0, PROMPT_PREVIEW_LIMIT),
      ...(agent.resultPreview ? { resultPreview: agent.resultPreview } : {}),
      ...(agent.error ? { errorPreview: agent.error.slice(0, PREVIEW_LIMIT) } : {}),
    })),
  };
}

export function summarizeWorkflowSnapshotDetail(snapshot: WorkflowRunSnapshot): string {
  const phase = snapshot.currentPhase ? ` - ${snapshot.currentPhase}` : "";
  const tokens =
    snapshot.tokenBudget != null
      ? ` - ${snapshot.tokensUsed}/${snapshot.tokenBudget} tokens`
      : ` - ${snapshot.tokensUsed} tokens`;
  const agents = ` - ${snapshot.agentsUsed}/${snapshot.maxAgents} agents`;
  const error = snapshot.errorPreview ? ` - ${snapshot.errorPreview.slice(0, 240)}` : "";
  return `${snapshot.name}: ${snapshot.status}${phase}${agents}${tokens}${error}`;
}
