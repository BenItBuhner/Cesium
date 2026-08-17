import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR, readJsonFile, writeJsonFile } from "../persistence.js";
import { nextCronRunAfter, parseCronExpression } from "./cesium-cron.js";

/**
 * Cesium agent triggers: the proactive plane. A trigger wakes the agent on a
 * schedule by creating a fresh conversation (with a chosen profile/mode) and
 * injecting the stored prompt as the first user message.
 */

export type CesiumTriggerSchedule =
  | { kind: "cron"; expression: string }
  | { kind: "interval"; everyMs: number }
  | { kind: "once"; atMs: number };

export type CesiumAgentTrigger = {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  schedule: CesiumTriggerSchedule;
  /** User-message text injected when the trigger fires. */
  prompt: string;
  /** Capability profile for the spawned conversation ("code", "work", custom id). */
  profileId?: string;
  /** Conversation mode for the spawned conversation (default "agent"). */
  mode?: string;
  /** Model pinned from the creating conversation so fires never fall back to an unconfigured provider. */
  modelId?: string;
  modelName?: string;
  createdAt: number;
  updatedAt: number;
  /** Next planned fire time; recomputed after every fire/edit. */
  nextRunAt: number | null;
  lastFiredAt?: number;
  lastConversationId?: string;
  runCount: number;
  /** Optional cap; the trigger disables itself once reached. */
  maxRuns?: number;
  sourceConversationId?: string;
};

type PersistedTriggersFile = {
  schemaVersion: 1;
  updatedAt: number;
  triggers: CesiumAgentTrigger[];
};

export const CESIUM_TRIGGERS_MAX_PER_WORKSPACE = 50;
export const CESIUM_TRIGGER_MIN_INTERVAL_MS = 60_000;
export const CESIUM_TRIGGER_MAX_PROMPT_CHARS = 4_000;
export const CESIUM_TRIGGER_MAX_NAME_CHARS = 80;

function triggersFile(workspaceId: string): string {
  return path.join(DATA_DIR, "workspaces", workspaceId, "agent-triggers.json");
}

function asTrimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Compute the next fire time strictly after `afterMs`, or null when done. */
export function computeNextRunAt(
  schedule: CesiumTriggerSchedule,
  afterMs: number
): number | null {
  switch (schedule.kind) {
    case "cron":
      return nextCronRunAfter(parseCronExpression(schedule.expression), afterMs);
    case "interval":
      return afterMs + Math.max(schedule.everyMs, CESIUM_TRIGGER_MIN_INTERVAL_MS);
    case "once":
      return schedule.atMs > afterMs ? schedule.atMs : null;
  }
}

/** Validate + normalize a schedule from tool/API input. Throws on invalid input. */
export function normalizeTriggerSchedule(raw: unknown): CesiumTriggerSchedule {
  if (!raw || typeof raw !== "object") {
    throw new Error("Trigger schedule is required.");
  }
  const record = raw as Record<string, unknown>;
  const kind = asTrimmed(record.kind);
  if (kind === "cron") {
    const expression = asTrimmed(record.expression);
    if (!expression) {
      throw new Error("Cron schedule requires an expression.");
    }
    parseCronExpression(expression); // throws with a useful message
    return { kind: "cron", expression };
  }
  if (kind === "interval") {
    const everyMs = Number(record.everyMs);
    if (!Number.isFinite(everyMs) || everyMs < CESIUM_TRIGGER_MIN_INTERVAL_MS) {
      throw new Error(
        `Interval schedules require everyMs >= ${CESIUM_TRIGGER_MIN_INTERVAL_MS} (one minute).`
      );
    }
    return { kind: "interval", everyMs: Math.floor(everyMs) };
  }
  if (kind === "once") {
    const atMs = Number(record.atMs);
    if (!Number.isFinite(atMs) || atMs <= 0) {
      throw new Error("One-shot schedules require a valid atMs timestamp.");
    }
    return { kind: "once", atMs: Math.floor(atMs) };
  }
  throw new Error('Trigger schedule.kind must be "cron", "interval", or "once".');
}

function normalizePersistedTrigger(raw: unknown, workspaceId: string): CesiumAgentTrigger | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const id = asTrimmed(record.id);
  const name = asTrimmed(record.name)?.slice(0, CESIUM_TRIGGER_MAX_NAME_CHARS);
  const prompt =
    typeof record.prompt === "string" && record.prompt.trim()
      ? record.prompt.trim().slice(0, CESIUM_TRIGGER_MAX_PROMPT_CHARS)
      : null;
  if (!id || !name || !prompt) {
    return null;
  }
  let schedule: CesiumTriggerSchedule;
  try {
    schedule = normalizeTriggerSchedule(record.schedule);
  } catch {
    return null;
  }
  const now = Date.now();
  return {
    id,
    workspaceId,
    name,
    enabled: record.enabled !== false,
    schedule,
    prompt,
    profileId: asTrimmed(record.profileId),
    mode: asTrimmed(record.mode),
    modelId: asTrimmed(record.modelId),
    modelName: asTrimmed(record.modelName),
    createdAt: typeof record.createdAt === "number" ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : now,
    nextRunAt: typeof record.nextRunAt === "number" ? record.nextRunAt : null,
    lastFiredAt: typeof record.lastFiredAt === "number" ? record.lastFiredAt : undefined,
    lastConversationId: asTrimmed(record.lastConversationId),
    runCount: typeof record.runCount === "number" && record.runCount >= 0 ? record.runCount : 0,
    maxRuns:
      typeof record.maxRuns === "number" && record.maxRuns >= 1
        ? Math.floor(record.maxRuns)
        : undefined,
    sourceConversationId: asTrimmed(record.sourceConversationId),
  };
}

export async function listCesiumTriggers(workspaceId: string): Promise<CesiumAgentTrigger[]> {
  const raw = await readJsonFile<unknown>(triggersFile(workspaceId), null);
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as PersistedTriggersFile).triggers)) {
    return [];
  }
  return (raw as PersistedTriggersFile).triggers
    .map((entry) => normalizePersistedTrigger(entry, workspaceId))
    .filter((entry): entry is CesiumAgentTrigger => entry != null)
    .slice(0, CESIUM_TRIGGERS_MAX_PER_WORKSPACE);
}

async function writeTriggers(workspaceId: string, triggers: CesiumAgentTrigger[]): Promise<void> {
  const file: PersistedTriggersFile = {
    schemaVersion: 1,
    updatedAt: Date.now(),
    triggers: triggers.slice(0, CESIUM_TRIGGERS_MAX_PER_WORKSPACE),
  };
  await writeJsonFile(triggersFile(workspaceId), file);
}

export async function createCesiumTrigger(input: {
  workspaceId: string;
  name: string;
  prompt: string;
  schedule: CesiumTriggerSchedule;
  profileId?: string;
  mode?: string;
  modelId?: string;
  modelName?: string;
  maxRuns?: number;
  sourceConversationId?: string;
}): Promise<CesiumAgentTrigger> {
  const name = input.name.trim().slice(0, CESIUM_TRIGGER_MAX_NAME_CHARS);
  const prompt = input.prompt.trim().slice(0, CESIUM_TRIGGER_MAX_PROMPT_CHARS);
  if (!name) {
    throw new Error("Trigger name must not be empty.");
  }
  if (!prompt) {
    throw new Error("Trigger prompt must not be empty.");
  }
  const triggers = await listCesiumTriggers(input.workspaceId);
  if (triggers.length >= CESIUM_TRIGGERS_MAX_PER_WORKSPACE) {
    throw new Error(
      `Trigger limit reached (${CESIUM_TRIGGERS_MAX_PER_WORKSPACE} per workspace). Delete one first.`
    );
  }
  const now = Date.now();
  const trigger: CesiumAgentTrigger = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    name,
    enabled: true,
    schedule: input.schedule,
    prompt,
    profileId: input.profileId?.trim() || undefined,
    mode: input.mode?.trim() || undefined,
    modelId: input.modelId?.trim() || undefined,
    modelName: input.modelName?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
    nextRunAt: computeNextRunAt(input.schedule, now),
    runCount: 0,
    maxRuns:
      input.schedule.kind === "once"
        ? 1
        : typeof input.maxRuns === "number" && input.maxRuns >= 1
          ? Math.floor(input.maxRuns)
          : undefined,
    sourceConversationId: input.sourceConversationId,
  };
  if (trigger.nextRunAt == null) {
    throw new Error("Trigger schedule has no future occurrence.");
  }
  await writeTriggers(input.workspaceId, [...triggers, trigger]);
  return trigger;
}

export async function updateCesiumTrigger(input: {
  workspaceId: string;
  id: string;
  patch: Partial<
    Pick<CesiumAgentTrigger, "name" | "prompt" | "enabled" | "profileId" | "mode" | "maxRuns">
  > & { schedule?: CesiumTriggerSchedule };
}): Promise<CesiumAgentTrigger> {
  const triggers = await listCesiumTriggers(input.workspaceId);
  const existing = triggers.find((trigger) => trigger.id === input.id);
  if (!existing) {
    throw new Error(`No trigger with id ${input.id}.`);
  }
  const now = Date.now();
  const next: CesiumAgentTrigger = {
    ...existing,
    ...(input.patch.name !== undefined
      ? { name: input.patch.name.trim().slice(0, CESIUM_TRIGGER_MAX_NAME_CHARS) }
      : {}),
    ...(input.patch.prompt !== undefined
      ? { prompt: input.patch.prompt.trim().slice(0, CESIUM_TRIGGER_MAX_PROMPT_CHARS) }
      : {}),
    ...(input.patch.enabled !== undefined ? { enabled: input.patch.enabled } : {}),
    ...(input.patch.profileId !== undefined
      ? { profileId: input.patch.profileId?.trim() || undefined }
      : {}),
    ...(input.patch.mode !== undefined ? { mode: input.patch.mode?.trim() || undefined } : {}),
    ...(input.patch.maxRuns !== undefined ? { maxRuns: input.patch.maxRuns } : {}),
    ...(input.patch.schedule !== undefined ? { schedule: input.patch.schedule } : {}),
    updatedAt: now,
  };
  // Re-arm on schedule change or re-enable.
  if (input.patch.schedule !== undefined || (input.patch.enabled === true && !existing.enabled)) {
    next.nextRunAt = computeNextRunAt(next.schedule, now);
  }
  await writeTriggers(
    input.workspaceId,
    triggers.map((trigger) => (trigger.id === next.id ? next : trigger))
  );
  return next;
}

export async function deleteCesiumTrigger(input: {
  workspaceId: string;
  id: string;
}): Promise<CesiumAgentTrigger | null> {
  const triggers = await listCesiumTriggers(input.workspaceId);
  const match = triggers.find((trigger) => trigger.id === input.id);
  if (!match) {
    return null;
  }
  await writeTriggers(
    input.workspaceId,
    triggers.filter((trigger) => trigger.id !== input.id)
  );
  return match;
}

/**
 * Persist the post-fire state for a trigger BEFORE the conversation is
 * prompted, so a crash mid-fire cannot double-fire. Returns the updated
 * record, with `enabled: false` once maxRuns is exhausted or a one-shot ran.
 */
export async function markCesiumTriggerFired(input: {
  workspaceId: string;
  id: string;
  firedAt: number;
  conversationId?: string;
}): Promise<CesiumAgentTrigger | null> {
  const triggers = await listCesiumTriggers(input.workspaceId);
  const existing = triggers.find((trigger) => trigger.id === input.id);
  if (!existing) {
    return null;
  }
  const runCount = existing.runCount + 1;
  const exhausted =
    existing.schedule.kind === "once" ||
    (existing.maxRuns != null && runCount >= existing.maxRuns);
  const next: CesiumAgentTrigger = {
    ...existing,
    runCount,
    lastFiredAt: input.firedAt,
    ...(input.conversationId ? { lastConversationId: input.conversationId } : {}),
    enabled: exhausted ? false : existing.enabled,
    nextRunAt: exhausted ? null : computeNextRunAt(existing.schedule, input.firedAt),
    updatedAt: input.firedAt,
  };
  await writeTriggers(
    input.workspaceId,
    triggers.map((trigger) => (trigger.id === next.id ? next : trigger))
  );
  return next;
}

/** Preamble prepended to the trigger prompt so the spawned agent knows its provenance. */
export function formatTriggerPromptPreamble(
  trigger: CesiumAgentTrigger,
  firedAt: number
): string {
  return (
    `[Scheduled trigger "${trigger.name}" fired at ${new Date(firedAt).toISOString()}. ` +
    "You were woken by the trigger scheduler, not a live user; complete the task " +
    "autonomously and leave a clear summary. Manage this trigger with the schedule tool " +
    `(id: ${trigger.id}).]\n\n${trigger.prompt}`
  );
}

/** Record the spawned conversation id after a fire, without touching run bookkeeping. */
export async function attachCesiumTriggerConversation(input: {
  workspaceId: string;
  id: string;
  conversationId: string;
}): Promise<void> {
  const triggers = await listCesiumTriggers(input.workspaceId);
  const existing = triggers.find((trigger) => trigger.id === input.id);
  if (!existing) {
    return;
  }
  await writeTriggers(
    input.workspaceId,
    triggers.map((trigger) =>
      trigger.id === input.id
        ? { ...trigger, lastConversationId: input.conversationId }
        : trigger
    )
  );
}

/** One-line schedule summary for tool output and the settings UI. */
export function describeTriggerSchedule(schedule: CesiumTriggerSchedule): string {
  switch (schedule.kind) {
    case "cron":
      return `cron "${schedule.expression}"`;
    case "interval": {
      const minutes = Math.round(schedule.everyMs / 60_000);
      return minutes >= 60 && minutes % 60 === 0
        ? `every ${minutes / 60}h`
        : `every ${minutes}m`;
    }
    case "once":
      return `once at ${new Date(schedule.atMs).toISOString()}`;
  }
}

export function formatCesiumTrigger(trigger: CesiumAgentTrigger): string {
  const state = trigger.enabled ? "enabled" : "disabled";
  const nextRun = trigger.nextRunAt
    ? new Date(trigger.nextRunAt).toISOString()
    : "none";
  const extras = [
    trigger.profileId ? `profile: ${trigger.profileId}` : null,
    trigger.mode ? `mode: ${trigger.mode}` : null,
    trigger.modelId ? `model: ${trigger.modelId}` : null,
    trigger.maxRuns != null ? `runs: ${trigger.runCount}/${trigger.maxRuns}` : `runs: ${trigger.runCount}`,
  ]
    .filter(Boolean)
    .join(", ");
  return `- ${trigger.name} (id: ${trigger.id}) — ${describeTriggerSchedule(trigger.schedule)}, ${state}, next: ${nextRun} (${extras})\n  prompt: ${trigger.prompt.slice(0, 140)}${trigger.prompt.length > 140 ? "…" : ""}`;
}
