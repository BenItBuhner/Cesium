import type { AgentBackendId, AgentStoredEvent } from "@/lib/agent-types";

/** Tool call events that may be projected as a subagent transcript card. */
export type SubagentToolCallEvent = Extract<
  AgentStoredEvent,
  { kind: "tool_call" | "tool_call_update" }
>;

export type ProjectAgentEventsOptions = {
  /**
   * Which agent backend produced these events. Subagent heuristics differ per server
   * (e.g. Cursor task tools vs OpenCode shell tools).
   * When omitted, the strict classifier is used so unknown backends do not inherit Cursor-only guesses.
   */
  backendId?: AgentBackendId;
};

function parseLooseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function getToolRawUpdate(
  event: AgentStoredEvent
): Record<string, unknown> | undefined {
  const raw =
    "raw" in event && event.raw && typeof event.raw === "object"
      ? (event.raw as Record<string, unknown>)
      : undefined;
  const update = raw?.update;
  return update && typeof update === "object" ? (update as Record<string, unknown>) : undefined;
}

export function getSubagentTaskInput(event: SubagentToolCallEvent): Record<string, unknown> | undefined {
  const rawUpdate = getToolRawUpdate(event);
  return (
    parseLooseJsonObject(rawUpdate?.rawInput) ??
    parseLooseJsonObject(rawUpdate?.input) ??
    parseLooseJsonObject(rawUpdate?.args)
  );
}

function collectNestedText(value: unknown, bucket: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNestedText(item, bucket);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    const trimmed = record.text.trim();
    if (trimmed) {
      bucket.push(trimmed);
    }
  }
  if (record.content !== undefined) {
    collectNestedText(record.content, bucket);
  }
  if (record.contents !== undefined) {
    collectNestedText(record.contents, bucket);
  }
  if (record.items !== undefined) {
    collectNestedText(record.items, bucket);
  }
  if (record.parts !== undefined) {
    collectNestedText(record.parts, bucket);
  }
}

export function extractSubagentTaskText(event: SubagentToolCallEvent): {
  taskId?: string;
  resultText?: string;
} {
  const rawUpdate = getToolRawUpdate(event);
  const texts: string[] = [];
  collectNestedText(rawUpdate?.content, texts);
  const rawText = texts.join("\n\n").trim();
  if (!rawText) {
    return {};
  }
  const taskId = rawText.match(/task_id:\s*(\S+)/i)?.[1];
  const taskResultMatch = rawText.match(/<task_result>\s*([\s\S]*?)(?:<\/task_result>|$)/i);
  const resultText = (taskResultMatch?.[1] ?? rawText).trim();
  return {
    taskId,
    resultText: resultText || undefined,
  };
}

function humanizeToolCallName(value: string): string {
  return value
    .replace(/ToolCall$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .trim();
}

function findFirstStringByKey(
  value: unknown,
  keys: string[],
  depth = 0
): string | undefined {
  if (depth > 4 || value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = findFirstStringByKey(entry, keys, depth + 1);
      if (match) {
        return match;
      }
    }
    return undefined;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) {
      return record[key] as string;
    }
  }
  for (const nestedValue of Object.values(record)) {
    const match = findFirstStringByKey(nestedValue, keys, depth + 1);
    if (match) {
      return match;
    }
  }
  return undefined;
}

export function extractAcpToolCallEntries(
  raw: Record<string, unknown> | undefined
): Array<{ rawName: string; args?: Record<string, unknown>; result?: Record<string, unknown> }> {
  if (!raw) {
    return [];
  }
  const toolCall =
    raw.tool_call && typeof raw.tool_call === "object" && !Array.isArray(raw.tool_call)
      ? (raw.tool_call as Record<string, unknown>)
      : raw.toolCall && typeof raw.toolCall === "object" && !Array.isArray(raw.toolCall)
        ? (raw.toolCall as Record<string, unknown>)
        : undefined;
  if (!toolCall) {
    return [];
  }
  const entries: Array<{
    rawName: string;
    args?: Record<string, unknown>;
    result?: Record<string, unknown>;
  }> = [];
  for (const [rawName, value] of Object.entries(toolCall)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const record = value as Record<string, unknown>;
    const args =
      parseLooseJsonObject(record.args) ??
      parseLooseJsonObject(record.input) ??
      (record.args && typeof record.args === "object" && !Array.isArray(record.args)
        ? (record.args as Record<string, unknown>)
        : record.input && typeof record.input === "object" && !Array.isArray(record.input)
          ? (record.input as Record<string, unknown>)
          : undefined);
    const result =
      parseLooseJsonObject(record.result) ??
      (record.result && typeof record.result === "object" && !Array.isArray(record.result)
        ? (record.result as Record<string, unknown>)
        : undefined);
    entries.push({ rawName, args, result });
  }
  return entries;
}

function rawToolNameImpliesTerminal(rawName: string): boolean {
  const n = humanizeToolCallName(rawName).toLowerCase();
  return (
    n.includes("run") ||
    n.includes("shell") ||
    n.includes("command") ||
    n.includes("bash") ||
    n.includes("terminal") ||
    n.includes("execute")
  );
}

/**
 * Best-effort: shell / PTY tools should never use the subagent transcript card.
 * Uses structured `toolKind` from the bridge when present, then payload + ACP tool names.
 */
export function isLikelyTerminalToolCall(event: SubagentToolCallEvent): boolean {
  const tk =
    "toolKind" in event && typeof event.toolKind === "string" ? event.toolKind : undefined;
  if (tk === "terminal" || tk === "execute" || tk === "shell") {
    return true;
  }
  const rawUpdate = getToolRawUpdate(event);
  const rawInput = getSubagentTaskInput(event);
  const buckets: Array<Record<string, unknown> | undefined> = [rawInput, rawUpdate];
  if (rawUpdate) {
    for (const entry of extractAcpToolCallEntries(rawUpdate)) {
      if (entry.args) {
        buckets.push(entry.args);
      }
    }
  }
  for (const record of buckets) {
    if (!record) {
      continue;
    }
    if (findFirstStringByKey(record, ["command", "cmd", "script"])) {
      return true;
    }
  }
  if (rawUpdate) {
    for (const entry of extractAcpToolCallEntries(rawUpdate)) {
      if (rawToolNameImpliesTerminal(entry.rawName)) {
        return true;
      }
    }
  }
  return false;
}

/** Cursor CLI / ACP: matches legacy "task" subagent tool shapes (prompt, description, task_id, …). */
export function isCursorAcpSubagentTaskToolEvent(event: SubagentToolCallEvent): boolean {
  if (event.kind !== "tool_call" && event.kind !== "tool_call_update") {
    return false;
  }
  if (isLikelyTerminalToolCall(event)) {
    return false;
  }
  const rawUpdate = getToolRawUpdate(event);
  const rawInput = getSubagentTaskInput(event);
  if (rawInput) {
    if (
      typeof rawInput.prompt === "string" ||
      typeof rawInput.description === "string" ||
      rawInput.subagent_type != null ||
      rawInput.subagentType != null
    ) {
      return true;
    }
  }
  if (typeof rawUpdate?.title === "string" && rawUpdate.title.trim().toLowerCase() === "task") {
    return true;
  }
  return Boolean(extractSubagentTaskText(event).taskId);
}

/**
 * OpenCode and other ACP servers: do not treat generic `prompt` / `description` fields as subagent tasks
 * (shell tools often populate those keys).
 */
export function isStrictAcpSubagentTaskToolEvent(event: SubagentToolCallEvent): boolean {
  if (event.kind !== "tool_call" && event.kind !== "tool_call_update") {
    return false;
  }
  if (isLikelyTerminalToolCall(event)) {
    return false;
  }
  const rawUpdate = getToolRawUpdate(event);
  const rawInput = getSubagentTaskInput(event);
  if (rawInput) {
    if (rawInput.subagent_type != null || rawInput.subagentType != null) {
      return true;
    }
  }
  if (typeof rawUpdate?.title === "string" && rawUpdate.title.trim().toLowerCase() === "task") {
    return true;
  }
  return Boolean(extractSubagentTaskText(event).taskId);
}

export const SUBAGENT_TOOL_CALL_CLASSIFIERS: Record<
  AgentBackendId,
  (event: SubagentToolCallEvent) => boolean
> = {
  "cursor-acp": isCursorAcpSubagentTaskToolEvent,
  "opencode-acp": isStrictAcpSubagentTaskToolEvent,
  "codex-adapter": isStrictAcpSubagentTaskToolEvent,
  "claude-adapter": isStrictAcpSubagentTaskToolEvent,
};

export function classifyToolCallAsSubagentCard(
  backendId: AgentBackendId | undefined,
  event: SubagentToolCallEvent
): boolean {
  const classifier =
    backendId && backendId in SUBAGENT_TOOL_CALL_CLASSIFIERS
      ? SUBAGENT_TOOL_CALL_CLASSIFIERS[backendId]
      : isStrictAcpSubagentTaskToolEvent;
  return classifier(event);
}
