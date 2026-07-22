import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR, readJsonFile, writeJsonFile } from "../persistence.js";
import type { WorkspaceRecord } from "../workspace-registry.js";
import {
  WORKFLOW_DEFAULT_MAX_AGENTS,
  WORKFLOW_DEFAULT_MAX_CONCURRENT,
  WORKFLOW_JOURNAL_LIMIT,
  WORKFLOW_LOG_LIMIT,
  createEmptyWorkflowMeta,
  type WorkflowJournalEntry,
  type WorkflowLogEntry,
  type WorkflowMeta,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
} from "./workflow-types.js";

type PersistedWorkflowRunsFile = {
  schemaVersion: 1;
  runs: WorkflowRunRecord[];
};

const workflowRunFileQueues = new Map<string, Promise<void>>();

function getWorkflowRunsFile(workspaceId: string): string {
  return path.join(DATA_DIR, "workspaces", workspaceId, "workflow-runs.json");
}

function getWorkflowScriptsDir(workspaceId: string): string {
  return path.join(DATA_DIR, "workspaces", workspaceId, "workflows");
}

function nowMs(): number {
  return Date.now();
}

function isWorkflowRunRecord(value: unknown): value is WorkflowRunRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<WorkflowRunRecord>;
  return (
    record.schemaVersion === 1 &&
    typeof record.runId === "string" &&
    typeof record.workspaceId === "string" &&
    typeof record.conversationId === "string" &&
    typeof record.script === "string" &&
    typeof record.scriptPath === "string"
  );
}

async function readRunsFile(workspaceId: string): Promise<WorkflowRunRecord[]> {
  const raw = await readJsonFile<PersistedWorkflowRunsFile | null>(
    getWorkflowRunsFile(workspaceId),
    null
  );
  if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.runs)) {
    return [];
  }
  return raw.runs.filter(isWorkflowRunRecord);
}

async function writeRunsFile(
  workspaceId: string,
  runs: WorkflowRunRecord[]
): Promise<void> {
  await writeJsonFile(getWorkflowRunsFile(workspaceId), {
    schemaVersion: 1,
    runs,
  } satisfies PersistedWorkflowRunsFile);
}

async function withWorkflowRunFileLock<T>(
  workspaceId: string,
  fn: () => Promise<T>
): Promise<T> {
  const filePath = getWorkflowRunsFile(workspaceId);
  const previous = workflowRunFileQueues.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => undefined).then(() => gate);
  workflowRunFileQueues.set(filePath, current);

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (workflowRunFileQueues.get(filePath) === current) {
      workflowRunFileQueues.delete(filePath);
    }
  }
}

export function hashWorkflowAgentCall(
  prompt: string,
  opts: Record<string, unknown>
): string {
  return createHash("sha256")
    .update(JSON.stringify({ prompt, opts }))
    .digest("hex");
}

export async function persistWorkflowScript(input: {
  workspace: WorkspaceRecord;
  runId: string;
  script: string;
}): Promise<string> {
  const workspaceDataDir = path.join(DATA_DIR, "workspaces", input.workspace.id);
  const dir = getWorkflowScriptsDir(input.workspace.id);
  await fs.mkdir(workspaceDataDir, { recursive: true });
  await fs.mkdir(dir, { recursive: true });
  const [resolvedWorkspaceDataDir, resolvedDir] = await Promise.all([
    fs.realpath(workspaceDataDir),
    fs.realpath(dir),
  ]);
  if (!isPathInside(resolvedWorkspaceDataDir, resolvedDir)) {
    throw new Error("Persisted workflow directory must stay inside the workspace data directory.");
  }
  const scriptPath = path.join(dir, `${input.runId}.js`);
  const existing = await fs.lstat(scriptPath).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symlinked workflow script: ${scriptPath}`);
  }
  await fs.writeFile(scriptPath, input.script, "utf8");
  return scriptPath;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function readWorkflowScriptFile(input: {
  workspace: WorkspaceRecord;
  scriptPath: string;
}): Promise<string> {
  const { workspace, scriptPath } = input;
  if (scriptPath.includes("\\") && /^\\\\/.test(scriptPath)) {
    throw new Error(`UNC paths are not allowed for workflow scriptPath: ${scriptPath}`);
  }
  try {
    const requestedPath = path.isAbsolute(scriptPath)
      ? scriptPath
      : path.resolve(workspace.root, scriptPath);
    const [resolvedFile, resolvedWorkspace, resolvedPersistedDir] = await Promise.all([
      fs.realpath(requestedPath),
      fs.realpath(workspace.root).catch(() => path.resolve(workspace.root)),
      fs.realpath(getWorkflowScriptsDir(workspace.id)).catch(() =>
        path.resolve(getWorkflowScriptsDir(workspace.id))
      ),
    ]);
    if (
      !isPathInside(resolvedWorkspace, resolvedFile) &&
      !isPathInside(resolvedPersistedDir, resolvedFile)
    ) {
      throw new Error(
        "workflow scriptPath must resolve inside the active workspace or its persisted Cesium workflows directory"
      );
    }
    return await fs.readFile(resolvedFile, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read workflow script file ${scriptPath}: ${message}`);
  }
}

export function createWorkflowRunRecord(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
  script: string;
  scriptPath: string;
  meta?: WorkflowMeta;
  args?: unknown;
  tokenBudget?: number | null;
  maxAgents?: number;
  maxConcurrent?: number;
  resumeFromRunId?: string;
}): WorkflowRunRecord {
  const now = nowMs();
  return {
    schemaVersion: 1,
    runId: randomUUID(),
    workspaceId: input.workspace.id,
    conversationId: input.conversationId,
    status: "pending",
    meta: input.meta ?? createEmptyWorkflowMeta(),
    script: input.script,
    scriptPath: input.scriptPath,
    args: input.args,
    tokenBudget:
      typeof input.tokenBudget === "number" && Number.isFinite(input.tokenBudget)
        ? Math.max(0, Math.floor(input.tokenBudget))
        : null,
    tokensUsed: 0,
    maxAgents: input.maxAgents ?? WORKFLOW_DEFAULT_MAX_AGENTS,
    maxConcurrent: input.maxConcurrent ?? WORKFLOW_DEFAULT_MAX_CONCURRENT,
    agentsUsed: 0,
    currentPhase: null,
    agents: [],
    logs: [],
    journal: [],
    returnValue: undefined,
    error: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

export async function upsertWorkflowRun(record: WorkflowRunRecord): Promise<WorkflowRunRecord> {
  return withWorkflowRunFileLock(record.workspaceId, async () => {
    const runs = await readRunsFile(record.workspaceId);
    const index = runs.findIndex((item) => item.runId === record.runId);
    const next = { ...record, updatedAt: nowMs() };
    if (index >= 0) {
      runs[index] = next;
    } else {
      runs.push(next);
    }
    // Keep the newest 100 runs.
    runs.sort((a, b) => b.updatedAt - a.updatedAt);
    await writeRunsFile(record.workspaceId, runs.slice(0, 100));
    return next;
  });
}

export async function readWorkflowRun(input: {
  workspaceId: string;
  runId: string;
}): Promise<WorkflowRunRecord | null> {
  const runs = await readRunsFile(input.workspaceId);
  return runs.find((item) => item.runId === input.runId) ?? null;
}

export async function readLatestWorkflowRunForConversation(input: {
  workspaceId: string;
  conversationId: string;
}): Promise<WorkflowRunRecord | null> {
  const runs = await readRunsFile(input.workspaceId);
  const matches = runs
    .filter((item) => item.conversationId === input.conversationId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return matches[0] ?? null;
}

export async function updateWorkflowRunStatus(
  record: WorkflowRunRecord,
  status: WorkflowRunStatus,
  patch: Partial<Pick<WorkflowRunRecord, "error" | "returnValue" | "completedAt" | "meta" | "currentPhase">> = {}
): Promise<WorkflowRunRecord> {
  const next: WorkflowRunRecord = {
    ...record,
    ...patch,
    status,
    updatedAt: nowMs(),
    completedAt:
      status === "completed" || status === "failed" || status === "cancelled"
        ? patch.completedAt ?? nowMs()
        : record.completedAt,
  };
  return upsertWorkflowRun(next);
}

export async function appendWorkflowLog(
  record: WorkflowRunRecord,
  message: string,
  phase?: string | null
): Promise<WorkflowRunRecord> {
  const entry: WorkflowLogEntry = {
    at: nowMs(),
    message,
    phase: phase ?? record.currentPhase,
  };
  const logs = [...record.logs, entry].slice(-WORKFLOW_LOG_LIMIT);
  return upsertWorkflowRun({ ...record, logs, updatedAt: nowMs() });
}

export async function appendWorkflowJournal(
  record: WorkflowRunRecord,
  entry: WorkflowJournalEntry
): Promise<WorkflowRunRecord> {
  const journal = [...record.journal.filter((item) => item.key !== entry.key), entry].slice(
    -WORKFLOW_JOURNAL_LIMIT
  );
  return upsertWorkflowRun({ ...record, journal, updatedAt: nowMs() });
}

export async function seedJournalFromPriorRun(input: {
  workspaceId: string;
  priorRunId: string;
}): Promise<WorkflowJournalEntry[]> {
  const prior = await readWorkflowRun({
    workspaceId: input.workspaceId,
    runId: input.priorRunId,
  });
  return prior?.journal ?? [];
}
