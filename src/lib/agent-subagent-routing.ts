import type { AgentBackendId, AgentStoredEvent } from "@/lib/agent-types";

export type AcpToolCallEntry = {
  rawName: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

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
  /** Absolute workspace root; used for read/edit/delete path titles and file lists. */
  workspaceRoot?: string | null;
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

function pushParsedToolEntry(
  entries: AcpToolCallEntry[],
  rawName: string | undefined,
  argsRaw: unknown,
  resultRaw: unknown
): void {
  if (!rawName?.trim()) {
    return;
  }
  const args =
    parseLooseJsonObject(argsRaw) ??
    (argsRaw && typeof argsRaw === "object" && !Array.isArray(argsRaw)
      ? (argsRaw as Record<string, unknown>)
      : undefined);
  const result =
    parseLooseJsonObject(resultRaw) ??
    (resultRaw && typeof resultRaw === "object" && !Array.isArray(resultRaw)
      ? (resultRaw as Record<string, unknown>)
      : undefined);
  entries.push({ rawName: rawName.trim(), args, result });
}

function extractClassicAcpToolCallMap(raw: Record<string, unknown>): AcpToolCallEntry[] {
  const toolCall =
    raw.tool_call && typeof raw.tool_call === "object" && !Array.isArray(raw.tool_call)
      ? (raw.tool_call as Record<string, unknown>)
      : raw.toolCall && typeof raw.toolCall === "object" && !Array.isArray(raw.toolCall)
        ? (raw.toolCall as Record<string, unknown>)
        : undefined;
  if (!toolCall) {
    return [];
  }
  const entries: AcpToolCallEntry[] = [];
  for (const [rawName, value] of Object.entries(toolCall)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const record = value as Record<string, unknown>;
    pushParsedToolEntry(entries, rawName, record.args ?? record.input, record.result);
  }
  return entries;
}

/** OpenAI / Anthropic-style shapes some ACP agents emit instead of `tool_call: { name: { args } }`. */
function extractAlternateAcpToolCallEntries(
  raw: Record<string, unknown>,
  depth = 0
): AcpToolCallEntry[] {
  if (depth > 4) {
    return [];
  }
  const entries: AcpToolCallEntry[] = [];
  const toolCalls = raw.tool_calls ?? raw.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const item of toolCalls) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const it = item as Record<string, unknown>;
      const fn =
        it.function && typeof it.function === "object" && !Array.isArray(it.function)
          ? (it.function as Record<string, unknown>)
          : undefined;
      const name =
        (typeof it.name === "string" ? it.name.trim() : "") ||
        (typeof fn?.name === "string" ? fn.name.trim() : "") ||
        undefined;
      const argsSrc = fn?.arguments ?? fn?.input ?? it.arguments ?? it.args ?? it.input;
      const res = it.result ?? it.output ?? it.response;
      pushParsedToolEntry(entries, name, argsSrc, res);
    }
  }

  const content = raw.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as Record<string, unknown>;
      const t = b.type;
      const nmFromBlock =
        (typeof b.name === "string" ? b.name : undefined) ||
        (typeof b.toolName === "string" ? b.toolName : undefined) ||
        (typeof b.tool_name === "string" ? b.tool_name : undefined);
      const looksToolBlock =
        t === "tool_use" ||
        t === "tool-call" ||
        t === "tool_call" ||
        t === "function_call" ||
        t === "mcp_tool_use" ||
        (nmFromBlock != null &&
          (b.input != null ||
            b.arguments != null ||
            b.args != null ||
            b.parameters != null));
      if (looksToolBlock) {
        pushParsedToolEntry(
          entries,
          nmFromBlock,
          b.input ?? b.arguments ?? b.args ?? b.parameters,
          b.result ?? b.output
        );
      }
    }
  }

  if (entries.length === 0 && typeof raw.name === "string" && raw.name.trim()) {
    pushParsedToolEntry(
      entries,
      raw.name,
      raw.input ?? raw.arguments ?? raw.args ?? raw.parameters,
      raw.result ?? raw.output ?? raw.response
    );
  }

  if (entries.length > 0) {
    return entries;
  }

  for (const key of ["message", "payload", "delta", "item", "data", "body"] as const) {
    const v = raw[key];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = extractAlternateAcpToolCallEntries(v as Record<string, unknown>, depth + 1);
      if (nested.length > 0) {
        return nested;
      }
    }
  }

  return [];
}

function flatRawInputLooksLikeToolArgs(args: Record<string, unknown>): boolean {
  return Boolean(
    (typeof args.path === "string" && args.path.trim()) ||
      (typeof args.filePath === "string" && args.filePath.trim()) ||
      (typeof args.file_path === "string" && args.file_path.trim()) ||
      (typeof args.target_file === "string" && args.target_file.trim()) ||
      (typeof args.file === "string" && args.file.trim()) ||
      (typeof args.uri === "string" && args.uri.trim()) ||
      (typeof args.command === "string" && args.command.trim()) ||
      (typeof args.cmd === "string" && args.cmd.trim()) ||
      (typeof args.pattern === "string" && args.pattern.trim()) ||
      (typeof args.query === "string" && args.query.trim()) ||
      (typeof args.globPattern === "string" && args.globPattern.trim()) ||
      (typeof args.glob === "string" && args.glob.trim())
  );
}

function inferToolNameForFlatArgs(
  raw: Record<string, unknown>,
  args: Record<string, unknown>
): string {
  for (const key of ["toolName", "tool_name", "toolId", "tool_id", "mcpTool", "mcp_tool"] as const) {
    const v = raw[key];
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }
  const kind = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : "";
  if (kind && kind !== "tool" && kind !== "other") {
    if (kind === "read" || kind === "file_read") {
      return "read_file";
    }
    if (kind === "edit" || kind === "write" || kind === "patch") {
      return "write_file";
    }
    if (kind === "delete" || kind === "unlink") {
      return "delete_file";
    }
    if (kind === "grep" || kind === "ripgrep") {
      return "grep";
    }
    if (kind === "glob" || kind === "find" || kind === "file_search") {
      return "glob_file_search";
    }
    if (kind === "terminal" || kind === "shell" || kind === "run") {
      return "run_terminal_cmd";
    }
    if (kind.includes("web")) {
      return "web_search";
    }
  }
  const hasCmd =
    typeof args.command === "string" ||
    typeof args.cmd === "string" ||
    typeof args.shell === "string";
  if (hasCmd) {
    return "run_terminal_cmd";
  }
  const hasPath =
    typeof args.path === "string" ||
    typeof args.filePath === "string" ||
    typeof args.file_path === "string" ||
    typeof args.target_file === "string" ||
    typeof args.file === "string" ||
    typeof args.uri === "string";
  const hasPattern =
    typeof args.pattern === "string" ||
    typeof args.query === "string" ||
    typeof args.regex === "string";
  if (hasPattern && !hasPath) {
    return typeof args.globPattern === "string" || typeof args.glob === "string"
      ? "glob_file_search"
      : "grep";
  }
  if (hasPath && typeof args.new_string === "string") {
    return "write_file";
  }
  if (hasPath) {
    return "read_file";
  }
  return "tool";
}

/** Cursor ACP often sends `rawInput` as the argument object with no `tool_call` wrapper. */
function tryExtractToolEntryFromFlatRawInput(raw: Record<string, unknown>): AcpToolCallEntry[] {
  const ri =
    parseLooseJsonObject(raw.rawInput) ??
    parseLooseJsonObject(raw.raw_input);
  if (!ri) {
    return [];
  }
  const args = ri as Record<string, unknown>;
  if (!flatRawInputLooksLikeToolArgs(args)) {
    return [];
  }
  const rawName = inferToolNameForFlatArgs(raw, args);
  return [{ rawName, args }];
}

export function extractAcpToolCallEntries(
  raw: Record<string, unknown> | undefined
): AcpToolCallEntry[] {
  if (!raw) {
    return [];
  }
  const classic = extractClassicAcpToolCallMap(raw);
  if (classic.length > 0) {
    return classic;
  }
  const alternate = extractAlternateAcpToolCallEntries(raw);
  if (alternate.length > 0) {
    return alternate;
  }
  const flat = tryExtractToolEntryFromFlatRawInput(raw);
  if (flat.length > 0) {
    return flat;
  }
  const nested =
    parseLooseJsonObject(raw.rawInput) ??
    parseLooseJsonObject(raw.raw_input);
  if (nested && nested !== raw) {
    return extractAcpToolCallEntries(nested);
  }
  return [];
}

export function getToolRawUpdate(
  event: AgentStoredEvent
): Record<string, unknown> | undefined {
  const raw =
    "raw" in event && event.raw && typeof event.raw === "object"
      ? (event.raw as Record<string, unknown>)
      : undefined;
  if (!raw) {
    return undefined;
  }
  const fromUpdate = raw.update;
  if (fromUpdate && typeof fromUpdate === "object") {
    return fromUpdate as Record<string, unknown>;
  }
  if (
    typeof raw.sessionUpdate === "string" ||
    typeof raw.session_update === "string" ||
    typeof raw.type === "string" ||
    raw.toolCallId != null ||
    raw.tool_call != null ||
    raw.toolCall != null ||
    raw.tool != null ||
    raw.name != null
  ) {
    return raw;
  }
  return undefined;
}

export function getSubagentTaskInput(event: SubagentToolCallEvent): Record<string, unknown> | undefined {
  const rawUpdate = getToolRawUpdate(event);
  if (rawUpdate?.type === "collab_tool_call") {
    return rawUpdate;
  }
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
  sessionId?: string;
} {
  const rawUpdate = getToolRawUpdate(event);
  if (rawUpdate?.type === "collab_tool_call") {
    const receiverIds = Array.isArray(rawUpdate.receiver_thread_ids)
      ? rawUpdate.receiver_thread_ids.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
    const states =
      rawUpdate.agents_states && typeof rawUpdate.agents_states === "object" && !Array.isArray(rawUpdate.agents_states)
        ? (rawUpdate.agents_states as Record<string, unknown>)
        : undefined;
    const messages = states
      ? Object.values(states)
          .map((value) => {
            if (!value || typeof value !== "object") {
              return undefined;
            }
            const record = value as Record<string, unknown>;
            return typeof record.message === "string" && record.message.trim()
              ? record.message.trim()
              : undefined;
          })
          .filter((value): value is string => Boolean(value))
      : [];
    return {
      taskId: receiverIds[0],
      sessionId: receiverIds[0],
      resultText: messages.length > 0 ? messages.join("\n\n") : undefined,
    };
  }
  const texts: string[] = [];
  collectNestedText(rawUpdate?.content, texts);
  const rawText = texts.join("\n\n").trim();
  const findSessionId = (value: unknown, depth = 0): string | undefined => {
    if (depth > 6 || value == null) {
      return undefined;
    }
    if (typeof value === "string") {
      const match = value.match(/\b(ses_[A-Za-z0-9]+)\b/);
      return match?.[1];
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const nested = findSessionId(entry, depth + 1);
        if (nested) {
          return nested;
        }
      }
      return undefined;
    }
    if (typeof value !== "object") {
      return undefined;
    }
    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      const nested = findSessionId(nestedValue, depth + 1);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  };
  const sessionId = findSessionId(rawUpdate) ?? findSessionId(getSubagentTaskInput(event));
  if (!rawText) {
    return { sessionId };
  }
  const taskId = rawText.match(/task_id:\s*(\S+)/i)?.[1];
  const taskResultMatch = rawText.match(/<task_result>\s*([\s\S]*?)(?:<\/task_result>|$)/i);
  const resultText = (taskResultMatch?.[1] ?? rawText).trim();
  return {
    taskId,
    resultText: resultText || undefined,
    sessionId,
  };
}

export function extractSubagentSessionIds(event: SubagentToolCallEvent): string[] {
  const rawUpdate = getToolRawUpdate(event);
  if (rawUpdate?.type === "collab_tool_call" && Array.isArray(rawUpdate.receiver_thread_ids)) {
    return rawUpdate.receiver_thread_ids.filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0
    );
  }
  const taskText = extractSubagentTaskText(event);
  return [taskText.sessionId, taskText.taskId].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
}

export function extractCodexSubagentStates(event: SubagentToolCallEvent): Array<{
  sessionId: string;
  status?: string;
  message?: string;
}> {
  const rawUpdate = getToolRawUpdate(event);
  if (rawUpdate?.type !== "collab_tool_call") {
    return [];
  }
  const states =
    rawUpdate.agents_states && typeof rawUpdate.agents_states === "object" && !Array.isArray(rawUpdate.agents_states)
      ? (rawUpdate.agents_states as Record<string, unknown>)
      : undefined;
  if (!states) {
    return [];
  }
  const entries: Array<{ sessionId: string; status?: string; message?: string }> = [];
  for (const [sessionId, value] of Object.entries(states)) {
    if (!sessionId.trim() || !value || typeof value !== "object") {
      continue;
    }
    const record = value as Record<string, unknown>;
    entries.push({
      sessionId,
      status: typeof record.status === "string" ? record.status : undefined,
      message: typeof record.message === "string" ? record.message : undefined,
    });
  }
  return entries;
}

function rawToolNameImpliesSubagent(rawName: string): boolean {
  const n = humanizeToolCallName(rawName).toLowerCase();
  return n === "task" || n.includes("subagent") || n.includes("delegate");
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
  const taskText = extractSubagentTaskText(event);
  if (rawInput) {
    if (
      rawInput.subagent_type != null ||
      rawInput.subagentType != null ||
      (taskText.sessionId &&
        (typeof rawInput.description === "string" || typeof rawInput.prompt === "string"))
    ) {
      return true;
    }
  }
  if (typeof rawUpdate?.title === "string" && rawUpdate.title.trim().toLowerCase() === "task") {
    return true;
  }
  if (rawUpdate) {
    for (const entry of extractAcpToolCallEntries(rawUpdate)) {
      if (rawToolNameImpliesSubagent(entry.rawName)) {
        return true;
      }
    }
  }
  return Boolean(taskText.taskId || taskText.sessionId);
}

export function isCodexSubagentTaskToolEvent(event: SubagentToolCallEvent): boolean {
  const rawUpdate = getToolRawUpdate(event);
  if (rawUpdate?.type !== "collab_tool_call") {
    return false;
  }
  const tool = typeof rawUpdate.tool === "string" ? rawUpdate.tool.toLowerCase() : "";
  return tool === "spawn_agent" || tool === "wait";
}

export const SUBAGENT_TOOL_CALL_CLASSIFIERS: Record<
  AgentBackendId,
  (event: SubagentToolCallEvent) => boolean
> = {
  "cursor-acp": isCursorAcpSubagentTaskToolEvent,
  "opencode-acp": isStrictAcpSubagentTaskToolEvent,
  "codex-adapter": isCodexSubagentTaskToolEvent,
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
