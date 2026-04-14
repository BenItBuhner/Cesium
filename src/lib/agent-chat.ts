import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConversationRecord,
  AgentPlanEntry,
  AgentStoredEvent,
} from "@/lib/agent-types";
import type {
  AgentModeOption,
  ChatMessage,
  ModelInfo,
  PermissionChoiceOption,
  TodoItem,
  UserMessageSegment,
  WorkedSessionEntry,
} from "@/lib/types";
import { DEFAULT_MODE_OPTIONS, formatModeLabel, resolveCanonicalModeId } from "@/lib/chat-modes";
import {
  findConversationModeConfigOptionForUi,
  findConversationModelConfigOptionForUi,
} from "@/lib/agent-config-option-utils";
import {
  classifyToolCallAsSubagentCard,
  extractAcpToolCallEntries,
  extractCodexSubagentStates,
  extractSubagentSessionIds,
  extractSubagentTaskText,
  getSubagentTaskInput,
  getToolRawUpdate,
} from "@/lib/agent-subagent-routing";
import type { ProjectAgentEventsOptions } from "@/lib/agent-subagent-routing";
import { formatToolFileLabel, toolPathBasename } from "@/lib/workspace-tool-path-display";

export type { ProjectAgentEventsOptions };

function modelProviderForBackend(backendId: AgentBackendId): ModelInfo["provider"] {
  switch (backendId) {
    case "cursor-acp":
      return "cursor";
    case "opencode-acp":
      return "opencode";
    case "codex-adapter":
      return "codex";
    case "claude-adapter":
      return "claude";
    default:
      return "auto";
  }
}

function getBackendForConversation(
  conversation: AgentConversationRecord,
  backends: AgentBackendInfo[]
): AgentBackendInfo | undefined {
  return backends.find((candidate) => candidate.id === conversation.config.backendId);
}

function createBackendDraftConversation(
  backend: AgentBackendInfo
): AgentConversationRecord {
  const configOptions = backend.cachedConfigOptions ?? [];
  const draftConversation: AgentConversationRecord = {
    schemaVersion: 1,
    id: `draft-${backend.id}`,
    workspaceId: "draft",
    title: "New chat",
    createdAt: 0,
    updatedAt: 0,
    lastEventSeq: 0,
    status: "idle",
    config: {
      backendId: backend.id,
      mode: backend.defaultMode,
      modelId: backend.defaultModelId,
      modelName: backend.defaultModelName,
    },
    providerSessionId: null,
    configOptions,
    capabilities: backend.capabilities,
    pendingPermission: null,
    lastError: null,
    experimental: Boolean(backend.experimental),
  };
  const modeOption = findConversationModeConfigOptionForUi(draftConversation);
  const modelOption = findConversationModelConfigOptionForUi(draftConversation);
  const modelId = modelOption?.currentValue || backend.defaultModelId;
  const modelName =
    modelOption?.options.find((option) => option.value === modelId)?.name ||
    backend.defaultModelName;
  draftConversation.config.mode =
    (modeOption?.currentValue || backend.defaultMode) as AgentConversationRecord["config"]["mode"];
  draftConversation.config.modelId = modelId;
  draftConversation.config.modelName = modelName;
  const modeOpts = buildConversationModeOptions(draftConversation, [backend]);
  draftConversation.config.mode = resolveCanonicalModeId(
    String(draftConversation.config.mode),
    modeOpts
  ) as AgentConversationRecord["config"]["mode"];
  return draftConversation;
}

function isPrimaryConfigCategory(category: AgentConversationRecord["configOptions"][number]["category"]): boolean {
  return category === "mode" || category === "model";
}

function mergeConversationConfigOptionsWithBackend(
  conversation: AgentConversationRecord,
  backend: AgentBackendInfo | undefined
): AgentConversationRecord["configOptions"] {
  const conversationOptions = conversation.configOptions;
  const backendOptions = backend?.cachedConfigOptions ?? [];
  if (conversationOptions.length === 0) {
    return backendOptions;
  }
  if (backendOptions.length === 0) {
    return conversationOptions;
  }

  const usedConversationIndexes = new Set<number>();
  const merged = backendOptions.map((backendOption) => {
    const conversationIndex = conversationOptions.findIndex((candidate, index) => {
      if (usedConversationIndexes.has(index)) {
        return false;
      }
      if (candidate.id === backendOption.id) {
        return true;
      }
      return (
        isPrimaryConfigCategory(backendOption.category) &&
        candidate.category === backendOption.category
      );
    });
    if (conversationIndex === -1) {
      return backendOption;
    }

    usedConversationIndexes.add(conversationIndex);
    const conversationOption = conversationOptions[conversationIndex]!;
    const preferBackendCatalog =
      isPrimaryConfigCategory(backendOption.category) &&
      backendOption.options.length >= conversationOption.options.length;
    const baseOption = preferBackendCatalog ? backendOption : conversationOption;
    const fallbackCurrentValue = conversationOption.currentValue || backendOption.currentValue;
    const currentValue =
      backendOption.category === "model"
        ? conversation.config.modelId || fallbackCurrentValue
        : backendOption.category === "mode"
          ? conversation.config.mode || fallbackCurrentValue
          : fallbackCurrentValue;
    return {
      ...baseOption,
      currentValue,
    };
  });

  for (let index = 0; index < conversationOptions.length; index += 1) {
    if (!usedConversationIndexes.has(index)) {
      merged.push(conversationOptions[index]!);
    }
  }

  return merged;
}

function getEffectiveConfigOptions(
  conversation: AgentConversationRecord,
  backends: AgentBackendInfo[]
): AgentConversationRecord["configOptions"] {
  if (conversation.configOptions.length > 0) {
    return mergeConversationConfigOptionsWithBackend(
      conversation,
      getBackendForConversation(conversation, backends)
    );
  }
  return getBackendForConversation(conversation, backends)?.cachedConfigOptions ?? [];
}

function findConfigOptionByCategory(
  conversation: AgentConversationRecord,
  backends: AgentBackendInfo[],
  category: AgentConversationRecord["configOptions"][number]["category"]
): AgentConversationRecord["configOptions"][number] | undefined {
  return getEffectiveConfigOptions(conversation, backends).find(
    (option) => option.category === category && option.options.length > 0
  );
}

export function findConversationModeConfigOption(
  conversation: AgentConversationRecord,
  backends: AgentBackendInfo[] = []
) {
  const configOptions = getEffectiveConfigOptions(conversation, backends);
  return findConversationModeConfigOptionForUi({
    ...conversation,
    configOptions,
  });
}

export function buildConversationModeOptions(
  conversation: AgentConversationRecord,
  backends: AgentBackendInfo[] = []
): AgentModeOption[] {
  const modeOption = findConversationModeConfigOption(conversation, backends);
  if (!modeOption || modeOption.options.length === 0) {
    return DEFAULT_MODE_OPTIONS;
  }
  return modeOption.options.map((option) => ({
    id: option.value,
    label: formatModeLabel(option.name.trim() || option.value),
    description: option.description,
  }));
}

export function findConversationModelConfigOption(
  conversation: AgentConversationRecord,
  backends: AgentBackendInfo[] = []
) {
  const configOptions = getEffectiveConfigOptions(conversation, backends);
  return findConversationModelConfigOptionForUi({
    ...conversation,
    configOptions,
  });
}

function toTodoItems(entries: AgentPlanEntry[]): TodoItem[] {
  return entries.map((entry) => ({
    id: entry.id,
    text: entry.content,
    status: entry.status,
  }));
}

function summarizeTodoLabel(entries: AgentPlanEntry[]): string {
  if (entries.length === 0) {
    return "0 of 0 Done";
  }
  const completed = entries.filter((entry) => entry.status === "completed").length;
  return `${completed} of ${entries.length} Done`;
}

export function agentPermissionOptionsToUiChoices(
  options: { optionId: string; name: string; kind: PermissionChoiceOption["kind"] }[]
): PermissionChoiceOption[] {
  return options.map((option) => ({
    id: option.optionId,
    label: option.name,
    kind: option.kind,
  }));
}

type ProjectedTurn = {
  id: string;
  userMessage?: ChatMessage;
  timeline: Array<
    | { kind: "trace"; entry: WorkedSessionEntry }
    | { kind: "assistant"; text: string; messageId: string }
    | { kind: "message"; message: ChatMessage }
  >;
  /** User-visible worked-session content: tool rows and other non-message trace blocks */
  trace: WorkedSessionEntry[];
  toolEntryById: Map<string, WorkedSessionEntry>;
  /** Next slot for orphan `tool_call_update` → running tool (parallel tools; avoids all binding to open[0]) */
  orphanToolUpdateSlot: number;
  /** First assistant_message_chunk message id (for standalone assistant bubble id) */
  assistantMessageId?: string;
  permissionCards: Map<string, ChatMessage>;
  todoCards: Map<string, ChatMessage>;
  subagentCards: Map<string, ChatMessage>;
  /** The user message ID that should be highlighted as the handoff message */
  handoffMessageId?: string;
};

function createTurn(id: string): ProjectedTurn {
  return {
    id,
    timeline: [],
    trace: [],
    toolEntryById: new Map(),
    orphanToolUpdateSlot: 0,
    permissionCards: new Map(),
    todoCards: new Map(),
    subagentCards: new Map(),
    handoffMessageId: undefined,
  };
}

function appendTraceEntry(turn: ProjectedTurn, entry: WorkedSessionEntry): void {
  turn.trace.push(entry);
  turn.timeline.push({ kind: "trace", entry });
}

function appendTimelineMessage(turn: ProjectedTurn, message: ChatMessage): void {
  turn.timeline.push({ kind: "message", message });
}

function appendAssistantChunk(turn: ProjectedTurn, text: string, messageId: string): void {
  if (!text) {
    return;
  }
  if (!turn.assistantMessageId) {
    turn.assistantMessageId = messageId;
  }
  const last = turn.timeline[turn.timeline.length - 1];
  if (last?.kind === "assistant") {
    last.text += text;
  } else {
    turn.timeline.push({ kind: "assistant", text, messageId });
  }
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function capitalizeFirst(value: string): string {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const TOOL_TITLE_MAX_LEN = 56;
const TOOL_PATH_LABEL_MAX = 80;
const TOOL_PATTERN_QUOTED_MAX = 42;
const TERMINAL_TITLE_MAX = 72;

function truncateMiddleLabel(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  const ellipsis = "…";
  const keep = max - ellipsis.length;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return value.slice(0, head) + ellipsis + value.slice(value.length - tail);
}

function conciseQuotedSearchPattern(raw: string, max = TOOL_PATTERN_QUOTED_MAX): string {
  const t = raw.trim();
  if (!t) {
    return '""';
  }
  const inner = t.length > max ? truncateMiddleLabel(t, max) : t;
  return `"${inner}"`;
}

/** Drop detail lines that only repeat the title (e.g. path shown twice for reads/updates). */
function stripRedundantToolDetail(
  detail: string | undefined,
  title: string
): string | undefined {
  if (!detail?.trim()) {
    return undefined;
  }
  const d = detail.trim();
  const t = title.trim();
  if (/^updated\s+/i.test(d)) {
    return undefined;
  }
  if (d === t) {
    return undefined;
  }
  const readMatch = /^Read\s+(.+)$/i.exec(t);
  if (readMatch) {
    const titled = readMatch[1]!.trim();
    if (d === titled || toolPathBasename(d) === titled || titled === toolPathBasename(d)) {
      return undefined;
    }
  }
  const updateMatch = /^Update\s+(.+)$/i.exec(t);
  if (updateMatch && d === updateMatch[1]!.trim()) {
    return undefined;
  }
  const deleteMatch = /^Delete\s+(.+)$/i.exec(t);
  if (deleteMatch && d === deleteMatch[1]!.trim()) {
    return undefined;
  }
  const webMatch = /^Web ·\s+(.+)$/i.exec(t);
  if (webMatch && d === webMatch[1]!.trim()) {
    return undefined;
  }
  return detail;
}

const TOOL_PATH_STRING_KEYS = [
  "path",
  "filePath",
  "filepath",
  "relPath",
  "relativePath",
  "relative_path",
  "file",
  "targetPath",
  "uri",
  "file_path",
  "fileName",
  "filename",
  "file_name",
  "target_file",
  "target",
  "source",
  "resourcePath",
  "file_uri",
] as const;

function pathFromReadLikeToolTitle(...candidates: (string | undefined)[]): string | undefined {
  for (const raw of candidates) {
    if (!raw?.trim()) {
      continue;
    }
    const m = /^(?:read|view|open)\s+(.+)$/i.exec(raw.trim());
    if (!m) {
      continue;
    }
    const rest = m[1]!.trim();
    if (!rest || /^file$/i.test(rest)) {
      continue;
    }
    return rest;
  }
  return undefined;
}

function queryFromFindLikeToolTitle(...candidates: (string | undefined)[]): string | undefined {
  for (const raw of candidates) {
    if (!raw?.trim()) {
      continue;
    }
    const m = /^find\s+(.+)$/i.exec(raw.trim());
    if (!m) {
      continue;
    }
    let rest = m[1]!.trim();
    if (!rest || /^in\s+workspace$/i.test(rest) || /^workspace$/i.test(rest)) {
      continue;
    }
    if (
      (rest.startsWith('"') && rest.endsWith('"')) ||
      (rest.startsWith("'") && rest.endsWith("'"))
    ) {
      rest = rest.slice(1, -1).trim();
    }
    return rest;
  }
  return undefined;
}

function patternFromGrepLikeToolTitle(...candidates: (string | undefined)[]): string | undefined {
  for (const raw of candidates) {
    if (!raw?.trim()) {
      continue;
    }
    const m = /^grep\s+(.+)$/i.exec(raw.trim());
    if (!m) {
      continue;
    }
    let rest = m[1]!.trim();
    if (
      (rest.startsWith('"') && rest.endsWith('"')) ||
      (rest.startsWith("'") && rest.endsWith("'"))
    ) {
      rest = rest.slice(1, -1);
    }
    return rest;
  }
  return undefined;
}

function withConciseToolDetail<T extends Extract<WorkedSessionEntry, { kind: "tool" }>>(
  row: T
): T {
  const nextDetail = stripRedundantToolDetail(row.detail, row.title);
  if (nextDetail === row.detail) {
    return row;
  }
  return { ...row, detail: nextDetail };
}

function humanizeToolCallName(value: string): string {
  return value
    .replace(/ToolCall$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .trim();
}

function inferUserSegmentKind(token: string): UserMessageSegment["type"] | null {
  const bare = token.startsWith("@") ? token.slice(1) : token;
  const lowered = bare.toLowerCase();
  if (["codebase", "docs", "web", "terminal"].includes(lowered)) {
    return "context";
  }
  if (
    bare.includes("/") ||
    bare.includes("\\") ||
    bare.startsWith(".") ||
    /\.[a-z0-9]{1,12}$/i.test(bare)
  ) {
    return "file";
  }
  return null;
}

function parseUserMessageSegments(content: string): UserMessageSegment[] | undefined {
  const pattern = /@[^\s]+/g;
  const segments: UserMessageSegment[] = [];
  let lastIndex = 0;
  let sawChip = false;

  for (const match of content.matchAll(pattern)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > lastIndex) {
      segments.push({
        type: "text",
        text: content.slice(lastIndex, start),
      });
    }

    let chip = token;
    let trailing = "";
    while (chip.length > 1 && /[),.;:!?]}]/.test(chip.at(-1) ?? "")) {
      trailing = `${chip.at(-1)}${trailing}`;
      chip = chip.slice(0, -1);
    }

    const kind = inferUserSegmentKind(chip);
    if (kind) {
      sawChip = true;
      segments.push({
        type: kind,
        text: kind === "context" ? chip : chip.slice(1),
      });
      if (trailing) {
        segments.push({ type: "text", text: trailing });
      }
    } else {
      segments.push({ type: "text", text: token });
    }
    lastIndex = start + token.length;
  }

  if (lastIndex < content.length) {
    segments.push({
      type: "text",
      text: content.slice(lastIndex),
    });
  }

  return sawChip ? segments.filter((segment) => segment.text.length > 0) : undefined;
}

function toWorkedToolStatus(
  status: string
): Extract<WorkedSessionEntry, { kind: "tool" }>["status"] {
  switch (status) {
    case "in_progress":
      return "running";
    case "pending":
      return "pending";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "pending";
  }
}

function inferToolKindFromTitle(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("todo")) {
    return "todo";
  }
  if (n.includes("search web") || n.includes("web search") || n.includes("websearch")) {
    return "search_web";
  }
  if (n.includes("grep") || n.includes("ripgrep")) {
    return "grep";
  }
  if (n.includes("glob") || n.includes("find") || n.includes("search")) {
    return "search";
  }
  if (n.includes("delete") || n.includes("remove") || n.includes("unlink")) {
    return "delete";
  }
  if (
    n.includes("write") ||
    n.includes("edit") ||
    n.includes("patch") ||
    n.includes("apply") ||
    n.includes("update") ||
    n.includes("create") ||
    n.includes("insert") ||
    n.includes("str replace") ||
    n.includes("replace") ||
    n.includes("rename") ||
    n.includes("mkdir")
  ) {
    return "edit";
  }
  if (n.includes("read") || n.includes("open") || n.includes("view")) {
    return "read";
  }
  if (
    n.includes("run") ||
    n.includes("shell") ||
    n.includes("command") ||
    n.includes("bash") ||
    n.includes("terminal") ||
    n.includes("execute")
  ) {
    return "terminal";
  }
  return "tool";
}

function recordHasAnyKey(
  record: Record<string, unknown> | undefined,
  keys: readonly string[]
): boolean {
  if (!record) {
    return false;
  }
  return keys.some((key) => key in record && record[key] != null);
}

function looksLikeEditPayload(record: Record<string, unknown> | undefined): boolean {
  if (!record) {
    return false;
  }
  if (
    recordHasAnyKey(record, [
      "diffString",
      "linesAdded",
      "linesRemoved",
      "beforeFullFileContent",
      "afterFullFileContent",
      "old_string",
      "new_string",
      "oldString",
      "newString",
      "replacement",
      "replacements",
      "patch",
      "edits",
      "contents",
      "renameTo",
      "newPath",
    ])
  ) {
    return true;
  }
  const errorText =
    typeof record.error === "string"
      ? record.error
      : record.error &&
          typeof record.error === "object" &&
          typeof (record.error as Record<string, unknown>).error === "string"
        ? ((record.error as Record<string, unknown>).error as string)
        : undefined;
  return Boolean(errorText && /failed to find context|apply patch|replace/i.test(errorText));
}

function looksLikeReadPayload(record: Record<string, unknown> | undefined): boolean {
  if (!record || looksLikeEditPayload(record)) {
    return false;
  }
  if (
    recordHasAnyKey(record, [
      "path",
      "filePath",
      "filepath",
      "file_path",
      "target_file",
      "uri",
    ]) &&
    !recordHasAnyKey(record, ["pattern", "query", "globPattern", "glob_pattern", "regex"])
  ) {
    return true;
  }
  return recordHasAnyKey(record, [
    "content",
    "text",
    "totalLines",
    "readRange",
    "contentBlobId",
    "isEmpty",
    "exceededLimit",
  ]);
}

function looksLikeWorkspaceFindPayload(record: Record<string, unknown> | undefined): boolean {
  if (!record || looksLikeEditPayload(record)) {
    return false;
  }
  return recordHasAnyKey(record, ["globPattern", "glob_pattern", "glob"]);
}

function looksLikeGrepToolPayload(record: Record<string, unknown> | undefined): boolean {
  if (!record || looksLikeEditPayload(record)) {
    return false;
  }
  if (looksLikeWorkspaceFindPayload(record)) {
    return false;
  }
  return recordHasAnyKey(record, ["pattern", "query", "regex", "searchTerm", "search", "needle"]);
}

function inferToolKindFromPayloadRecords(
  values: Array<Record<string, unknown> | undefined>
): string | undefined {
  if (values.some((value) => looksLikeEditPayload(value))) {
    return "edit";
  }
  if (values.some((value) => looksLikeWorkspaceFindPayload(value))) {
    return "search";
  }
  if (values.some((value) => looksLikeGrepToolPayload(value))) {
    return "grep";
  }
  if (values.some((value) => looksLikeReadPayload(value))) {
    return "read";
  }
  return undefined;
}

function turnToolEntries(turn: ProjectedTurn): Extract<WorkedSessionEntry, { kind: "tool" }>[] {
  return turn.trace.filter(
    (entry): entry is Extract<WorkedSessionEntry, { kind: "tool" }> => entry.kind === "tool"
  );
}

function summarizeWorkedToolBucket(
  kind: string,
  count: number,
  fileCount: number
): string {
  const resolvedCount = fileCount > 0 ? fileCount : count;
  switch (kind) {
    case "read":
      return resolvedCount === 1 ? "read 1 file" : `read ${resolvedCount} files`;
    case "edit":
      return resolvedCount === 1 ? "edited 1 file" : `edited ${resolvedCount} files`;
    case "delete":
      return resolvedCount === 1 ? "deleted 1 file" : `deleted ${resolvedCount} files`;
    case "grep":
      return count === 1 ? "grepped" : `grepped ${count} times`;
    case "search_web":
      return count === 1 ? "searched web" : `searched web ${count} times`;
    case "search":
      return count === 1 ? "searched workspace" : `searched workspace ${count} times`;
    case "terminal":
    case "execute":
      return count === 1 ? "ran a command" : `ran ${count} commands`;
    case "todo":
      return count === 1 ? "updated todo list" : `updated todo list ${count} times`;
    default:
      return count === 1 ? "used a tool" : `used ${count} tools`;
  }
}

function nextNonAssistantTimelineItem(
  timeline: ProjectedTurn["timeline"],
  fromIndex: number
): ProjectedTurn["timeline"][number] | undefined {
  for (let j = fromIndex + 1; j < timeline.length; j += 1) {
    const item = timeline[j]!;
    if (item.kind !== "assistant") {
      return item;
    }
  }
  return undefined;
}

function buildWorkedSessionLabel(entries: WorkedSessionEntry[]): string {
  const tools = entries.filter(
    (entry): entry is Extract<WorkedSessionEntry, { kind: "tool" }> => entry.kind === "tool"
  );
  const thoughtCount = entries.filter((entry) => entry.kind === "reasoning").length;
  if (tools.length === 0) {
    if (thoughtCount > 0) {
      return thoughtCount === 1 ? "1 thought" : `${thoughtCount} thoughts`;
    }
    return "Tools";
  }
  const orderedBuckets: Array<{ kind: string; count: number; files: Set<string> }> = [];
  const bucketByKind = new Map<string, (typeof orderedBuckets)[number]>();
  for (const tool of tools) {
    const kind =
      tool.toolKind ??
      (tool.variant === "terminal" ? "terminal" : inferToolKindFromTitle(tool.title));
    const bucket =
      bucketByKind.get(kind) ??
      (() => {
        const created = { kind, count: 0, files: new Set<string>() };
        bucketByKind.set(kind, created);
        orderedBuckets.push(created);
        return created;
      })();
    bucket.count += 1;
    if (tool.editPreview?.path) {
      bucket.files.add(tool.editPreview.path);
      continue;
    }
    for (const file of tool.files ?? []) {
      bucket.files.add(file);
    }
  }
  const segments = orderedBuckets
    .map((bucket) =>
      summarizeWorkedToolBucket(bucket.kind, bucket.count, bucket.files.size)
    )
    .concat(thoughtCount > 0 ? [thoughtCount === 1 ? "1 thought" : `${thoughtCount} thoughts`] : []);
  const label = segments.join(", ");
  const failedCount = tools.filter((tool) => tool.status === "failed").length;
  return failedCount > 0
    ? `${capitalizeFirst(label)} · ${failedCount} failed`
    : capitalizeFirst(label);
}

function projectTurnTimelineToMessages(turn: ProjectedTurn): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let assistantText = "";
  let workedEntries: WorkedSessionEntry[] = [];
  let segmentIndex = 0;

  const flushAssistant = () => {
    if (assistantText.trim().length === 0) {
      assistantText = "";
      return;
    }
    messages.push({
      id: `${turn.assistantMessageId ?? `assistant-${turn.id}`}-${segmentIndex++}`,
      type: "assistant",
      content: assistantText,
    });
    assistantText = "";
  };

  const flushWorked = () => {
    if (workedEntries.length === 0) {
      return;
    }
    messages.push({
      id: `turn-worked-${turn.id}-${segmentIndex++}`,
      type: "worked-session",
      workedLabel: buildWorkedSessionLabel(workedEntries),
      workedEntries,
      workedDefaultOpen: true,
    });
    workedEntries = [];
  };

  for (let timelineIndex = 0; timelineIndex < turn.timeline.length; timelineIndex += 1) {
    const item = turn.timeline[timelineIndex]!;
    if (item.kind === "message") {
      flushWorked();
      flushAssistant();
      messages.push(item.message);
      continue;
    }
    if (item.kind === "assistant") {
      const chunk = item.text;
      if (!chunk.trim()) {
        continue;
      }
      const upNext = nextNonAssistantTimelineItem(turn.timeline, timelineIndex);
      if (upNext?.kind === "trace") {
        flushAssistant();
        workedEntries.push({ kind: "assistant_inline", text: chunk });
      } else {
        flushWorked();
        assistantText += chunk;
      }
      continue;
    }
    const entry = item.entry;
    flushAssistant();
    if (entry.kind === "tool" && entry.editPreview) {
      flushWorked();
      messages.push({
        id: `turn-edit-${turn.id}-${segmentIndex++}`,
        type: "worked-session",
        workedLabel: buildWorkedSessionLabel([entry]),
        workedEntries: [],
        workedHighlightedEntry: entry,
        workedDefaultOpen: false,
      });
      continue;
    }
    workedEntries.push(entry);
  }

  flushWorked();
  flushAssistant();

  if (messages.length === 0 && turn.userMessage) {
    messages.push({
      id: `turn-working-${turn.id}`,
      type: "worked-session",
      workedLabel: "Working",
      workedEntries: [],
      workedDefaultOpen: false,
      loading: true,
    });
  }

  return messages;
}

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

function parseVerboseToolDetail(detail: string | undefined): Record<string, unknown> | undefined {
  if (!detail?.trim()) {
    return undefined;
  }
  return parseLooseJsonObject(detail);
}

function isVerboseToolPayloadDetail(detail: string | undefined): boolean {
  const trimmed = detail?.trim();
  if (!trimmed) {
    return false;
  }
  const parsed = parseVerboseToolDetail(trimmed);
  if (
    parsed &&
    ["content", "text", "stdout", "output", "result"].some((key) => key in parsed)
  ) {
    return true;
  }
  return (
    (trimmed.startsWith("{") || trimmed.startsWith("[")) &&
    (trimmed.includes("\\n") || trimmed.includes("\n") || trimmed.length > 180)
  );
}

function safeToolDetailText(
  detail: string | undefined,
  options: { suppressVerbosePayload?: boolean } = {}
): string | undefined {
  const trimmed = detail?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (options.suppressVerbosePayload && isVerboseToolPayloadDetail(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function suppressPathOnlyDetail(detail: string | undefined): string | undefined {
  const parsed = parseVerboseToolDetail(detail);
  if (
    parsed &&
    Object.keys(parsed).length > 0 &&
    Object.keys(parsed).every((key) =>
      ["path", "filePath", "filepath", "relativePath", "targetPath", "uri"].includes(key)
    )
  ) {
    return undefined;
  }
  return detail;
}

/** When stream-json IDs do not line up, completion updates never land — close out on turn end. */
function finalizeOpenToolsInTurn(
  turn: ProjectedTurn,
  finalStatus: "completed" | "failed" | "cancelled"
): void {
  for (const entry of turn.trace) {
    if (entry.kind !== "tool") {
      continue;
    }
    if (entry.status === "pending" || entry.status === "running") {
      entry.status = finalStatus;
    }
  }
}

function firstNonEmptyLine(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function parseSubagentResultMessages(text: string, baseId: string): ChatMessage[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }
  const messages: ChatMessage[] = [];
  const assistantLines: string[] = [];
  const lines = normalized.split("\n");
  let segmentIndex = 0;

  const flushAssistant = () => {
    const content = assistantLines.join("\n").trim();
    assistantLines.length = 0;
    if (!content) {
      return;
    }
    messages.push({
      id: `${baseId}-assistant-${segmentIndex++}`,
      type: "assistant",
      content,
    });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index]?.trim();
    const next = lines[index + 1]?.trim();
    if (
      current &&
      /^used a tool$/i.test(current) &&
      next &&
      !/^used a tool$/i.test(next)
    ) {
      flushAssistant();
      messages.push({
        id: `${baseId}-tool-${segmentIndex++}`,
        type: "worked-session",
        workedLabel: next,
        workedEntries: [
          {
            kind: "tool",
            title: next,
            toolKind: inferToolKindFromTitle(next),
            status: "completed",
          },
        ],
        workedDefaultOpen: true,
      });
      index += 1;
      continue;
    }
    assistantLines.push(lines[index] ?? "");
  }

  flushAssistant();
  return messages;
}

function buildSubagentTranscriptFromTaskEvent(
  event: Extract<AgentStoredEvent, { kind: "tool_call" | "tool_call_update" }>,
  title: string
): ChatMessage[] {
  const rawInput = getSubagentTaskInput(event);
  const { taskId, resultText } = extractSubagentTaskText(event);
  const transcript: ChatMessage[] = [];
  const prompt = typeof rawInput?.prompt === "string" ? rawInput.prompt.trim() : "";
  if (prompt) {
    transcript.push({
      id: `${event.toolCallId}-prompt`,
      type: "user",
      content: prompt,
      segments: parseUserMessageSegments(prompt),
    });
  }
  if (resultText) {
    transcript.push(...parseSubagentResultMessages(resultText, taskId ?? event.toolCallId));
  }
  if (transcript.length === 0) {
    transcript.push({
      id: `${event.toolCallId}-empty`,
      type: "assistant",
      content: `No transcript details were exposed for ${title}.`,
    });
  }
  return transcript;
}

/** Omit meta that only mirrors spinner vs checkmark (icons already show this). */
function subagentMetaForDisplay(meta: string | undefined): string | undefined {
  const t = meta?.trim();
  if (!t) {
    return undefined;
  }
  if (/^(running(\.\.\.)?|completed)$/i.test(t)) {
    return undefined;
  }
  return meta;
}

function buildSubagentRecentActivity(
  transcript: ChatMessage[],
  fallback: string | undefined
): string | undefined {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const message = transcript[index];
    if (message?.type === "worked-session") {
      const toolTitle = message.workedEntries?.find((entry) => entry.kind === "tool");
      if (toolTitle && toolTitle.kind === "tool") {
        return toolTitle.title;
      }
    }
    if (message?.type === "assistant") {
      const line = firstNonEmptyLine(message.content);
      if (line) {
        return line;
      }
    }
  }
  return firstNonEmptyLine(fallback);
}

function findSubagentMessageBySessionId(
  turn: ProjectedTurn,
  sessionIds: string[]
): ChatMessage | undefined {
  if (sessionIds.length === 0) {
    return undefined;
  }
  return Array.from(turn.subagentCards.values()).find(
    (message) => message.subagentId != null && sessionIds.includes(message.subagentId)
  );
}

function codexSubagentRuntimeStatus(
  event: Extract<AgentStoredEvent, { kind: "tool_call" | "tool_call_update" }>
): ChatMessage["subagentStatus"] | null {
  const rawUpdate = getToolRawUpdate(event);
  if (rawUpdate?.type !== "collab_tool_call") {
    return null;
  }
  const tool = typeof rawUpdate.tool === "string" ? rawUpdate.tool.toLowerCase() : "";
  const states =
    rawUpdate.agents_states && typeof rawUpdate.agents_states === "object" && !Array.isArray(rawUpdate.agents_states)
      ? (rawUpdate.agents_states as Record<string, unknown>)
      : undefined;
  const statusValues = states
    ? Object.values(states)
        .map((value) => {
          if (!value || typeof value !== "object") {
            return undefined;
          }
          const record = value as Record<string, unknown>;
          return typeof record.status === "string" ? record.status.toLowerCase() : undefined;
        })
        .filter((value): value is string => Boolean(value))
    : [];

  if (event.status === "failed" || event.status === "cancelled") {
    return "failed";
  }
  if (tool === "spawn_agent") {
    return "running";
  }
  if (tool === "wait") {
    if (
      statusValues.some(
        (value) => !["completed", "failed", "cancelled", "done", "finished"].includes(value)
      )
    ) {
      return "running";
    }
    return event.status === "completed" ? "completed" : "running";
  }
  return null;
}

function codexCollabToolName(
  event: Extract<AgentStoredEvent, { kind: "tool_call" | "tool_call_update" }>
): string | null {
  const rawUpdate = getToolRawUpdate(event);
  if (rawUpdate?.type !== "collab_tool_call") {
    return null;
  }
  return typeof rawUpdate.tool === "string" ? rawUpdate.tool.toLowerCase() : null;
}

function codexStateStatusToSubagentStatus(
  status: string | undefined
): ChatMessage["subagentStatus"] {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) {
    return "running";
  }
  if (["failed", "error", "cancelled", "canceled"].includes(normalized)) {
    return "failed";
  }
  if (["completed", "done", "finished"].includes(normalized)) {
    return "completed";
  }
  return "running";
}

function subagentStatusFromToolEventStatus(
  status: AgentStoredEvent extends infer T
    ? T extends { kind: "tool_call" | "tool_call_update"; status: infer S }
      ? S
      : never
    : never
): ChatMessage["subagentStatus"] {
  if (status === "failed" || status === "cancelled") {
    return "failed";
  }
  if (status === "completed") {
    return "completed";
  }
  return "running";
}

function compactJsonForRejected(record: Record<string, unknown>): string | undefined {
  try {
    const compact = JSON.stringify(record);
    if (!compact || compact === "{}" || compact === "null") {
      return undefined;
    }
    return compact.length > 800 ? `${compact.slice(0, 797)}...` : compact;
  } catch {
    return undefined;
  }
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

function findFirstNumberByKey(
  value: unknown,
  keys: string[],
  depth = 0
): number | undefined {
  if (depth > 4 || value == null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = findFirstNumberByKey(entry, keys, depth + 1);
      if (match != null) {
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
    if (typeof record[key] === "number") {
      return record[key] as number;
    }
  }
  for (const nestedValue of Object.values(record)) {
    const match = findFirstNumberByKey(nestedValue, keys, depth + 1);
    if (match != null) {
      return match;
    }
  }
  return undefined;
}

function findFirstStringArrayByKey(
  value: unknown,
  keys: string[],
  depth = 0
): string[] | undefined {
  if (depth > 4 || value == null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.every((entry) => typeof entry === "string")) {
      return value as string[];
    }
    for (const entry of value) {
      const match = findFirstStringArrayByKey(entry, keys, depth + 1);
      if (match?.length) {
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
    if (Array.isArray(record[key]) && record[key].every((entry) => typeof entry === "string")) {
      return record[key] as string[];
    }
  }
  for (const nestedValue of Object.values(record)) {
    const match = findFirstStringArrayByKey(nestedValue, keys, depth + 1);
    if (match?.length) {
      return match;
    }
  }
  return undefined;
}

function extractToolNameFromCliRaw(raw: Record<string, unknown> | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const fromFn =
    raw.function && typeof raw.function === "object"
      ? pick((raw.function as Record<string, unknown>).name)
      : undefined;
  if (fromFn) {
    return fromFn;
  }
  const fromFc =
    raw.function_call && typeof raw.function_call === "object"
      ? pick((raw.function_call as Record<string, unknown>).name)
      : undefined;
  if (fromFc) {
    return fromFc;
  }
  const direct = pick(raw.tool_name) ?? pick(raw.toolName) ?? pick(raw.name);
  if (direct && !/^(text|assistant)$/i.test(direct)) {
    return direct;
  }
  return findFirstStringByKey(raw, ["tool_name", "function_name", "toolName"]);
}

function extractAcpToolCallPayload(raw: Record<string, unknown> | undefined): {
  rawName?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
} {
  const [entry] = extractAcpToolCallEntries(raw);
  return entry ?? {};
}

function findFirstStringAcrossValues(
  values: unknown[],
  keys: string[]
): string | undefined {
  for (const value of values) {
    const match = findFirstStringByKey(value, keys);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function findFirstNumberAcrossValues(
  values: unknown[],
  keys: string[]
): number | undefined {
  for (const value of values) {
    const match = findFirstNumberByKey(value, keys);
    if (match != null) {
      return match;
    }
  }
  return undefined;
}

function findFirstStringArrayAcrossValues(
  values: unknown[],
  keys: string[]
): string[] | undefined {
  for (const value of values) {
    const match = findFirstStringArrayByKey(value, keys);
    if (match?.length) {
      return match;
    }
  }
  return undefined;
}

function isGenericToolTitle(title: string | undefined): boolean {
  const normalized = title?.trim().toLowerCase();
  return (
    !normalized ||
    normalized === "tool call" ||
    normalized === "tool" ||
    normalized === "function call" ||
    normalized === "function" ||
    normalized === "read" ||
    normalized === "grep" ||
    normalized === "find" ||
    normalized === "search" ||
    normalized === "read file" ||
    normalized === "find in workspace" ||
    normalized === "grep workspace" ||
    normalized === "web search"
  );
}

/** `locations` on the stored event can be empty while `raw.update.locations` still has uri/path. */
function stripFileSchemePrefix(p: string): string {
  if (!/^file:\/\//i.test(p)) {
    return p;
  }
  try {
    return decodeURIComponent(p.replace(/^file:\/\//i, ""));
  } catch {
    return p.replace(/^file:\/\//i, "");
  }
}

function pathFromRawLocationItem(item: Record<string, unknown>): string | undefined {
  const keys = ["path", "filePath", "file_path", "file", "uri", "href"] as const;
  let raw: string | undefined;
  for (const k of keys) {
    const v = item[k];
    if (typeof v === "string" && v.trim()) {
      raw = v;
      break;
    }
  }
  const t = raw?.trim();
  return t ? stripFileSchemePrefix(t) : undefined;
}

const PATH_SCAVENGE_KEYS = [
  ...TOOL_PATH_STRING_KEYS,
  "workspacePath",
  "workspace_path",
  "cwd",
  "directory",
  "folder",
  "absolutePath",
  "absolute_path",
  "localPath",
  "local_path",
  "fullPath",
  "full_path",
  "source",
  "destination",
  "rootPath",
] as const;

function looksLikeFsPathString(s: string): boolean {
  const t = s.trim();
  if (!t || t.includes("\n") || t.length > 4096) {
    return false;
  }
  if (/^file:/i.test(t)) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(t)) {
    return true;
  }
  if (t.includes("/") || t.includes("\\")) {
    return true;
  }
  return false;
}

function isLikelyBareFileReferenceString(s: string): boolean {
  const t = s.trim();
  if (!t || t.includes("\n") || t.length > 384 || /\s/.test(t)) {
    return false;
  }
  return /^[\w./%-]+\.[A-Za-z0-9]{1,12}$/.test(t);
}

function collectPathsFromUnknown(value: unknown, depth: number, out: string[]): void {
  if (depth > 14 || out.length >= 24) {
    return;
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (t.startsWith("{") && (t.includes("path") || t.includes("file"))) {
      const o = parseLooseJsonObject(t);
      if (o) {
        collectPathsFromUnknown(o, depth + 1, out);
      }
    } else if (looksLikeFsPathString(t) || isLikelyBareFileReferenceString(t)) {
      out.push(stripFileSchemePrefix(t));
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    if (
      value.length > 0 &&
      value.every(
        (x): x is string =>
          typeof x === "string" && x.trim().length > 0 && !x.includes("\n")
      ) &&
      value.every(
        (x) => Boolean(looksLikeFsPathString(x) || isLikelyBareFileReferenceString(x))
      )
    ) {
      for (const s of value) {
        out.push(stripFileSchemePrefix(s.trim()));
      }
      return;
    }
    for (const item of value) {
      collectPathsFromUnknown(item, depth + 1, out);
    }
    return;
  }
  const o = value as Record<string, unknown>;
  for (const key of PATH_SCAVENGE_KEYS) {
    const v = o[key];
    if (
      typeof v === "string" &&
      v.trim() &&
      (looksLikeFsPathString(v) || isLikelyBareFileReferenceString(v))
    ) {
      out.push(stripFileSchemePrefix(v.trim()));
    }
  }
  for (const v of Object.values(o)) {
    collectPathsFromUnknown(v, depth + 1, out);
  }
}

function scavengePathsFromToolEventRaw(
  event: Extract<AgentStoredEvent, { kind: "tool_call" | "tool_call_update" }>
): string[] {
  const raw =
    "raw" in event && event.raw && typeof event.raw === "object"
      ? (event.raw as Record<string, unknown>)
      : undefined;
  if (!raw) {
    return [];
  }
  const collected: string[] = [];
  collectPathsFromUnknown(raw, 0, collected);
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const p of collected) {
    if (!seen.has(p)) {
      seen.add(p);
      deduped.push(p);
    }
  }
  return deduped;
}

function extractPathsFromToolEventRaw(
  event: Extract<AgentStoredEvent, { kind: "tool_call" | "tool_call_update" }>
): string[] | undefined {
  const raw =
    "raw" in event && event.raw && typeof event.raw === "object"
      ? (event.raw as Record<string, unknown>)
      : undefined;
  const update =
    raw?.update && typeof raw.update === "object" && !Array.isArray(raw.update)
      ? (raw.update as Record<string, unknown>)
      : undefined;
  const out: string[] = [];
  const pushPath = (p: string | undefined) => {
    const t = p?.trim();
    if (t && !out.includes(t)) {
      out.push(stripFileSchemePrefix(t));
    }
  };
  const locs = update?.locations;
  if (Array.isArray(locs)) {
    for (const loc of locs) {
      if (!loc || typeof loc !== "object") {
        continue;
      }
      pushPath(pathFromRawLocationItem(loc as Record<string, unknown>));
    }
  }
  const singleLoc = update?.location;
  if (singleLoc && typeof singleLoc === "object" && !Array.isArray(singleLoc)) {
    pushPath(pathFromRawLocationItem(singleLoc as Record<string, unknown>));
  }
  pushPath(
    typeof update?.path === "string"
      ? update.path
      : typeof update?.filePath === "string"
        ? update.filePath
        : typeof update?.file_path === "string"
          ? update.file_path
          : typeof update?.target_file === "string"
            ? update.target_file
            : typeof update?.uri === "string"
              ? update.uri
              : undefined
  );
  return out.length > 0 ? out : undefined;
}

function extractPathFromToolEventRaw(
  event: Extract<AgentStoredEvent, { kind: "tool_call" | "tool_call_update" }>
): string | undefined {
  return extractPathsFromToolEventRaw(event)?.[0];
}

function pathFromPriorWorkedToolTitle(
  existing: Extract<WorkedSessionEntry, { kind: "tool" }> | undefined
): string | undefined {
  if (!existing?.title?.trim()) {
    return undefined;
  }
  const m = /^(Read|Update|Delete)\s+(.+)$/i.exec(existing.title.trim());
  const rest = m?.[2]?.trim();
  if (!rest || /^file$/i.test(rest)) {
    return undefined;
  }
  return rest;
}

/** Stream-json `type` values that are not useful as a user-visible tool title */
const GENERIC_STREAM_TOOL_TYPES = new Set([
  "agent_message",
  "function_call",
  "function",
  "tool_call",
  "tool_use",
  "tool_result",
  "tool_output",
  "mcp_tool_use",
  "custom_tool_call",
]);

function formatToolSummary(
  event: Extract<AgentStoredEvent, { kind: "tool_call" | "tool_call_update" }>,
  existing?: Extract<WorkedSessionEntry, { kind: "tool" }>,
  workspaceRoot?: string | null
): Extract<WorkedSessionEntry, { kind: "tool" }> {
  const ws = workspaceRoot ?? undefined;
  const rawUpdate = getToolRawUpdate(event);
  const rawTop =
    "raw" in event && event.raw && typeof event.raw === "object"
      ? (event.raw as Record<string, unknown>)
      : undefined;
  const rawToolRecord =
    (rawUpdate &&
    (extractAcpToolCallEntries(rawUpdate).length > 0 ||
      typeof rawUpdate.type === "string" ||
      typeof rawUpdate.title === "string")
      ? rawUpdate
      : undefined) ?? rawTop;
  const rawType =
    typeof rawToolRecord?.type === "string" &&
    rawToolRecord.type &&
    rawToolRecord.type !== "agent_message"
      ? rawToolRecord.type
      : undefined;
  /** ACP often sends `rawInput` / `rawOutput` as JSON strings; parse like `getSubagentTaskInput`. */
  const rawInputRecords = [
    parseLooseJsonObject(rawUpdate?.rawInput),
    parseLooseJsonObject(rawUpdate?.raw_input),
    parseLooseJsonObject(rawTop?.rawInput),
    parseLooseJsonObject(rawTop?.raw_input),
  ].filter((value): value is Record<string, unknown> => value != null);
  const rawOutputRecords = [
    parseLooseJsonObject(rawUpdate?.rawOutput),
    parseLooseJsonObject(rawUpdate?.raw_output),
    parseLooseJsonObject(rawTop?.rawOutput),
    parseLooseJsonObject(rawTop?.raw_output),
  ].filter((value): value is Record<string, unknown> => value != null);
  const acpToolCallsBase = rawToolRecord ? extractAcpToolCallEntries(rawToolRecord) : [];
  const acpToolCallsFromWrapped = rawInputRecords.flatMap((rec) =>
    extractAcpToolCallEntries(rec)
  );
  const acpToolCalls = [...acpToolCallsBase, ...acpToolCallsFromWrapped];
  const acpToolCall = acpToolCalls[0];
  const acpToolName = acpToolCall?.rawName
    ? humanizeToolCallName(acpToolCall.rawName)
    : undefined;
  const acpToolKinds = acpToolCalls
    .map((entry) => inferToolKindFromTitle(humanizeToolCallName(entry.rawName)))
    .filter((kind) => kind !== "tool");
  const acpToolResultSuccess = acpToolCalls
    .map((entry) =>
      entry.result?.success &&
      typeof entry.result.success === "object" &&
      !Array.isArray(entry.result.success)
        ? (entry.result.success as Record<string, unknown>)
        : undefined
    )
    .find((value) => value != null);
  const acpToolResultRejected = acpToolCalls
    .map((entry) =>
      entry.result?.rejected &&
      typeof entry.result.rejected === "object" &&
      !Array.isArray(entry.result.rejected)
        ? (entry.result.rejected as Record<string, unknown>)
        : undefined
    )
    .find((value) => value != null);
  const rawTypeLabel =
    rawType && !GENERIC_STREAM_TOOL_TYPES.has(rawType)
      ? String(rawType).replace(/_/g, " ")
      : undefined;
  const nestedArgRecord =
    acpToolCall?.args ??
    parseLooseJsonObject(rawToolRecord?.arguments) ??
    parseLooseJsonObject(rawToolRecord?.input) ??
    parseLooseJsonObject(rawToolRecord?.args) ??
    parseLooseJsonObject(rawToolRecord?.params);
  const nestedFromFunction =
    rawToolRecord?.function && typeof rawToolRecord.function === "object"
      ? parseLooseJsonObject((rawToolRecord.function as Record<string, unknown>).arguments) ??
        parseLooseJsonObject((rawToolRecord.function as Record<string, unknown>).input)
      : undefined;
  const titleFromRaw =
    extractToolNameFromCliRaw(rawToolRecord) ??
    acpToolName ??
    (typeof rawToolRecord?.tool_name === "string" ? rawToolRecord.tool_name : undefined) ??
    (typeof rawToolRecord?.name === "string" ? rawToolRecord.name : undefined) ??
    rawTypeLabel;
  const rawTitleLabel =
    titleFromRaw != null && titleFromRaw !== ""
      ? String(titleFromRaw).replace(/[_-]/g, " ")
      : undefined;
  const acpKind = typeof rawToolRecord?.kind === "string" ? rawToolRecord.kind : undefined;
  const rawInputs = [
    ...rawInputRecords,
    ...acpToolCalls.map((entry) => entry.args),
    nestedArgRecord,
    nestedFromFunction,
    rawToolRecord,
    rawTop,
  ].filter((value): value is Record<string, unknown> => value != null);
  const rawOutputs = [
    ...rawOutputRecords,
    acpToolResultSuccess,
    acpToolResultRejected,
    ...acpToolCalls.map((entry) => entry.result),
  ].filter((value): value is Record<string, unknown> => value != null);

  const scavengedPaths = scavengePathsFromToolEventRaw(event);
  const normalizedLocations =
    event.locations
      ?.flatMap((loc) => {
        const p = typeof loc.path === "string" ? loc.path.trim() : "";
        if (!p) {
          return [];
        }
        return [{
          path: p,
          line: typeof loc.line === "number" ? loc.line : undefined,
        }];
      }) ?? existing?.locations;
  /** `locations: []` is truthy for `??` — treat empty like missing so we still scan raw / scavenger. */
  const locationPaths = normalizedLocations?.map((loc) => loc.path) ?? [];
  const editPreview = event.editPreview ?? existing?.editPreview;
  const path =
    locationPaths[0] ??
    editPreview?.path ??
    extractPathFromToolEventRaw(event) ??
    findFirstStringAcrossValues(rawInputs, [...TOOL_PATH_STRING_KEYS]) ??
    findFirstStringAcrossValues(rawOutputs, [...TOOL_PATH_STRING_KEYS]) ??
    scavengedPaths[0] ??
    existing?.files?.[0] ??
    pathFromPriorWorkedToolTitle(existing);

  const files =
    (locationPaths.length > 0 ? locationPaths : undefined) ??
    extractPathsFromToolEventRaw(event) ??
    findFirstStringArrayAcrossValues(rawOutputs, [
      "files",
      "paths",
      "matchedFiles",
      "results",
    ]) ??
    (scavengedPaths.length > 0 ? scavengedPaths : undefined) ??
    existing?.files;

  let status = toWorkedToolStatus(event.status);
  if (acpToolResultRejected) {
    status = "failed";
  } else if (rawToolRecord?.subtype === "completed") {
    status = "completed";
  } else if (rawToolRecord?.subtype === "started" && status === "pending") {
    status = "running";
  }
  const explicitTitle = "title" in event ? event.title : undefined;
  const toolKindFromEvent = "toolKind" in event ? event.toolKind : undefined;
  const payloadToolKind = inferToolKindFromPayloadRecords([
    ...rawInputs,
    ...rawOutputs,
  ]);
  const rawKind =
    (toolKindFromEvent && toolKindFromEvent !== "tool" ? toolKindFromEvent : undefined) ??
    payloadToolKind ??
    existing?.toolKind ??
    (acpToolKinds.length === 1 ? acpToolKinds[0] : undefined) ??
    (acpToolName ? inferToolKindFromTitle(acpToolName) : undefined) ??
    (acpKind && acpKind !== "tool" ? acpKind : undefined) ??
    (titleFromRaw ? inferToolKindFromTitle(titleFromRaw) : undefined) ??
    (rawTitleLabel ? inferToolKindFromTitle(rawTitleLabel) : undefined);
  const toolKind = rawKind === "execute" ? "terminal" : rawKind;
  const resolvedTitleLabel = isGenericToolTitle(explicitTitle)
    ? rawTitleLabel
    : explicitTitle ?? rawTitleLabel;
  const streamToolTitle =
    typeof explicitTitle === "string" && explicitTitle.trim()
      ? explicitTitle.trim()
      : undefined;
  const rejectedReason = findFirstStringByKey(acpToolResultRejected, [
    "reason",
    "message",
    "error",
    "detail",
    "description",
  ]);
  const rejectedFallback =
    acpToolResultRejected &&
    typeof acpToolResultRejected === "object" &&
    !Array.isArray(acpToolResultRejected)
      ? compactJsonForRejected(acpToolResultRejected as Record<string, unknown>)
      : undefined;
  const detail =
    safeToolDetailText(event.detail) ??
    (acpToolResultRejected
      ? rejectedReason?.trim() ||
        rejectedFallback ||
        "Tool call was rejected by the current approval settings."
      : undefined);
  const likelyEdit =
    toolKind === "edit" ||
    toolKind === "write" ||
    payloadToolKind === "edit" ||
    /\b(write|edit|patch|apply|replace|str_replace|update)\b/i.test(
      `${resolvedTitleLabel ?? ""} ${titleFromRaw ?? ""}`
    );
  const likelyRead =
    !likelyEdit &&
    (toolKind === "read" ||
      payloadToolKind === "read" ||
      /\bread\b/i.test(resolvedTitleLabel ?? "") ||
      Boolean(pathFromReadLikeToolTitle(streamToolTitle, resolvedTitleLabel, rawTitleLabel)) ||
      (Boolean(path) &&
        /\bread|cat|open|load|view\b/i.test(
          `${resolvedTitleLabel ?? ""} ${titleFromRaw ?? ""}`
        )));

  if (toolKind === "grep" || /\bgrep\b/i.test(acpToolName ?? "")) {
    const query =
      findFirstStringAcrossValues(rawInputs, [
        "query",
        "pattern",
        "regex",
        "search",
        "searchTerm",
        "term",
        "needle",
      ]) ??
      patternFromGrepLikeToolTitle(streamToolTitle, resolvedTitleLabel, rawTitleLabel);
    const totalFiles = findFirstNumberAcrossValues(rawOutputs, [
      "totalFiles",
      "fileCount",
      "count",
    ]);
    const matchedFiles =
      findFirstStringArrayAcrossValues(rawOutputs, ["files", "matchedFiles", "results"])?.length ??
      totalFiles;
    const grepTitle = query?.trim()
      ? `Grep ${conciseQuotedSearchPattern(query)}`
      : "Grep workspace";
    return withConciseToolDetail({
      kind: "tool",
      toolCallId: event.toolCallId,
      toolKind,
      title: grepTitle,
      detail:
        safeToolDetailText(detail, { suppressVerbosePayload: true }) ??
        (matchedFiles != null
          ? `${pluralize(matchedFiles, "file")} matched`
          : existing?.detail),
      status,
      locations: normalizedLocations,
      editPreview,
      files,
    });
  }

  if (toolKind === "search_web") {
    const query = findFirstStringAcrossValues(rawInputs, [
      "query",
      "searchTerm",
      "term",
      "search",
    ]);
    const webTitle = query?.trim()
      ? `Web · ${truncateMiddleLabel(query.trim(), 44)}`
      : "Web search";
    return withConciseToolDetail({
      kind: "tool",
      toolCallId: event.toolCallId,
      toolKind,
      title: webTitle,
      detail: safeToolDetailText(detail, { suppressVerbosePayload: true }) ?? existing?.detail,
      status,
      locations: normalizedLocations,
      editPreview,
      files,
    });
  }

  if (
    toolKind === "search" ||
    explicitTitle === "Find" ||
    resolvedTitleLabel === "Find" ||
    (resolvedTitleLabel && /^find\b/i.test(resolvedTitleLabel.trim()))
  ) {
    const query =
      findFirstStringAcrossValues(rawInputs, ["globPattern"]) ??
      findFirstStringAcrossValues(rawInputs, [
        "query",
        "pattern",
        "regex",
        "search",
        "searchTerm",
        "term",
        "needle",
        "include",
      ]) ??
      queryFromFindLikeToolTitle(streamToolTitle, resolvedTitleLabel, rawTitleLabel);
    const totalFiles = findFirstNumberAcrossValues(rawOutputs, [
      "totalFiles",
      "fileCount",
      "count",
    ]);
    const matchedFiles =
      findFirstStringArrayAcrossValues(rawOutputs, ["files", "matchedFiles", "results"])?.length ??
      totalFiles;
    const findTitle = query?.trim()
      ? `Find ${conciseQuotedSearchPattern(query)}`
      : "Find in workspace";
    return withConciseToolDetail({
      kind: "tool",
      toolCallId: event.toolCallId,
      toolKind,
      title: findTitle,
      detail:
        safeToolDetailText(detail, { suppressVerbosePayload: true }) ??
        (matchedFiles != null
          ? `${pluralize(matchedFiles, "file")} matched`
          : existing?.detail),
      status,
      locations: normalizedLocations,
      editPreview,
      files,
    });
  }

  if (likelyRead) {
    const safeReadDetail = safeToolDetailText(suppressPathOnlyDetail(detail), {
      suppressVerbosePayload: true,
    });
    const readPath =
      path?.trim() ||
      (files?.length === 1 && files[0]?.trim() ? files[0]!.trim() : undefined) ||
      pathFromReadLikeToolTitle(streamToolTitle, resolvedTitleLabel, rawTitleLabel);
    const readTitle = readPath
      ? `Read ${truncateMiddleLabel(
          formatToolFileLabel(readPath, ws) ?? toolPathBasename(readPath),
          TOOL_PATH_LABEL_MAX
        )}`
      : "Read file";
    let readFiles = readPath
      ? [readPath, ...(files ?? []).filter((file) => file !== readPath)]
      : files;
    if (readFiles?.length === 1 && readPath && readFiles[0] === readPath) {
      readFiles = undefined;
    }
    return withConciseToolDetail({
      kind: "tool",
      toolCallId: event.toolCallId,
      toolKind,
      title: readTitle,
      detail: safeReadDetail ?? existing?.detail,
      status,
      locations: normalizedLocations,
      editPreview,
      files: readFiles,
    });
  }

  if (likelyEdit) {
    const nextTitle = path?.trim()
      ? `Update ${truncateMiddleLabel(
          formatToolFileLabel(path, ws) ?? toolPathBasename(path),
          TOOL_PATH_LABEL_MAX
        )}`
      : truncateMiddleLabel(
          resolvedTitleLabel ?? existing?.title ?? "Update file",
          TOOL_TITLE_MAX_LEN
        );
    let editFiles = path ? [path, ...(files ?? []).filter((file) => file !== path)] : files;
    if (editFiles?.length === 1 && path && editFiles[0] === path) {
      editFiles = undefined;
    }
    return withConciseToolDetail({
      kind: "tool",
      toolCallId: event.toolCallId,
      toolKind,
      title: nextTitle,
      detail:
        safeToolDetailText(suppressPathOnlyDetail(detail), { suppressVerbosePayload: true }) ??
        existing?.detail,
      status,
      locations: normalizedLocations,
      editPreview,
      files: editFiles,
    });
  }

  if (toolKind === "delete") {
    const delTitle = path?.trim()
      ? `Delete ${truncateMiddleLabel(
          formatToolFileLabel(path, ws) ?? toolPathBasename(path),
          TOOL_PATH_LABEL_MAX
        )}`
      : truncateMiddleLabel(
          resolvedTitleLabel ?? existing?.title ?? "Delete file",
          TOOL_TITLE_MAX_LEN
        );
    let delFiles = path ? [path, ...(files ?? []).filter((file) => file !== path)] : files;
    if (delFiles?.length === 1 && path && delFiles[0] === path) {
      delFiles = undefined;
    }
    return withConciseToolDetail({
      kind: "tool",
      toolCallId: event.toolCallId,
      toolKind,
      title: delTitle,
      detail:
        safeToolDetailText(suppressPathOnlyDetail(detail), { suppressVerbosePayload: true }) ??
        existing?.detail,
      status,
      locations: normalizedLocations,
      editPreview,
      files: delFiles,
    });
  }

  if (toolKind === "todo") {
    const todoCount = Array.isArray(rawInputs[0]?.todos)
      ? (rawInputs[0]?.todos as unknown[]).length
      : findFirstNumberAcrossValues(rawInputs, ["count", "total"]);
    return withConciseToolDetail({
      kind: "tool",
      toolCallId: event.toolCallId,
      toolKind,
      title: "Update todo list",
      detail:
        safeToolDetailText(detail, { suppressVerbosePayload: true }) ??
        (todoCount != null ? `${pluralize(todoCount, "item")} updated` : existing?.detail),
      status,
      locations: normalizedLocations,
      editPreview,
      files,
    });
  }

  const command = findFirstStringAcrossValues(rawInputs, ["command", "cmd", "script"]);
  if (command) {
    return withConciseToolDetail({
      kind: "tool",
      toolCallId: event.toolCallId,
      toolKind: toolKind === "tool" ? "terminal" : toolKind,
      title: truncateMiddleLabel(command, TERMINAL_TITLE_MAX),
      detail: safeToolDetailText(detail, { suppressVerbosePayload: true }) ?? existing?.detail,
      variant: "terminal",
      status,
      locations: normalizedLocations,
      editPreview,
      files,
    });
  }

  return withConciseToolDetail({
    kind: "tool",
    toolCallId: event.toolCallId,
    toolKind,
    title: truncateMiddleLabel(
      resolvedTitleLabel ?? existing?.title ?? "Tool call",
      TOOL_TITLE_MAX_LEN
    ),
    detail: safeToolDetailText(detail, { suppressVerbosePayload: true }) ?? existing?.detail,
    status,
    locations: normalizedLocations,
    editPreview,
    files,
    variant: existing?.variant,
  });
}

export function projectAgentEventsToChatMessages(
  events: AgentStoredEvent[],
  options?: ProjectAgentEventsOptions
): ChatMessage[] {
  const workspaceRoot = options?.workspaceRoot;
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const hiddenHandoffTranscriptMessageIds = new Set<string>();
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const current = ordered[index];
    const next = ordered[index + 1];
    if (
      current?.kind === "assistant_message_end" &&
      next?.kind === "agent_handoff"
    ) {
      hiddenHandoffTranscriptMessageIds.add(current.messageId);
    }
  }
  const turns: ProjectedTurn[] = [];
  let currentTurn: ProjectedTurn | null = null;

  const ensureTurn = () => {
    if (!currentTurn) {
      currentTurn = createTurn(`synthetic-${turns.length + 1}`);
      turns.push(currentTurn);
    }
    return currentTurn;
  };

  for (const event of ordered) {
    try {
    switch (event.kind) {
      case "user_message": {
        const prev = currentTurn;
        currentTurn = createTurn(event.messageId);
        currentTurn.userMessage = {
          id: event.messageId,
          type: "user",
          content: event.content,
          segments: parseUserMessageSegments(event.content),
          showReplyCue: true,
          attachments: event.attachments,
        };
        if (
          prev &&
          prev.id.startsWith("synthetic-") &&
          !prev.userMessage &&
          prev.timeline.length > 0
        ) {
          currentTurn.trace = prev.trace;
          currentTurn.timeline = prev.timeline;
          currentTurn.toolEntryById = prev.toolEntryById;
          currentTurn.orphanToolUpdateSlot = prev.orphanToolUpdateSlot;
          currentTurn.assistantMessageId = prev.assistantMessageId;
          currentTurn.permissionCards = prev.permissionCards;
          currentTurn.todoCards = prev.todoCards;
          currentTurn.subagentCards = prev.subagentCards;
          const prevIdx = turns.indexOf(prev);
          if (prevIdx >= 0) {
            turns.splice(prevIdx, 1);
          }
        }
        turns.push(currentTurn);
        break;
      }
      case "assistant_message_chunk": {
        if (hiddenHandoffTranscriptMessageIds.has(event.messageId)) {
          break;
        }
        const turn = ensureTurn();
        appendAssistantChunk(turn, event.text, event.messageId);
        break;
      }
      case "assistant_message_end": {
        if (hiddenHandoffTranscriptMessageIds.has(event.messageId)) {
          break;
        }
        const turn = ensureTurn();
        const hasAssistantText = turn.timeline.some(
          (item) => item.kind === "assistant" && item.text.trim().length > 0
        );
        if (!hasAssistantText && event.stopReason === "failed") {
          appendAssistantChunk(
            turn,
            "The provider ended the turn without returning any visible text.",
            event.messageId
          );
        }
        finalizeOpenToolsInTurn(turn, event.stopReason === "failed" ? "failed" : "completed");
        break;
      }
      case "reasoning": {
        const turn = ensureTurn();
        appendTraceEntry(turn, {
          kind: "reasoning",
          text: event.text,
        });
        break;
      }
      case "tool_call": {
        const turn = ensureTurn();
        if (classifyToolCallAsSubagentCard(options?.backendId, event)) {
          const rawInput = getSubagentTaskInput(event);
          const taskText = extractSubagentTaskText(event);
          const sessionIds = extractSubagentSessionIds(event);
          const codexStates =
            options?.backendId === "codex-adapter" ? extractCodexSubagentStates(event) : [];
          const codexTool = options?.backendId === "codex-adapter" ? codexCollabToolName(event) : null;
          if (options?.backendId === "codex-adapter" && codexTool === "wait" && codexStates.length === 0) {
            break;
          }
          if (options?.backendId === "codex-adapter" && codexStates.length > 0) {
            const fallbackTitle =
              (typeof rawInput?.description === "string" && rawInput.description.trim()) ||
              (typeof rawInput?.prompt === "string" && rawInput.prompt.trim()) ||
              "Subagent task";
            for (const state of codexStates) {
              const existingMessage =
                (codexTool === "spawn_agent" ? turn.subagentCards.get(event.toolCallId) : undefined) ??
                findSubagentMessageBySessionId(turn, [state.sessionId]);
              const message =
                existingMessage ??
                ({
                  id: `subagent-${state.sessionId}`,
                  type: "subagent",
                  subagentId: state.sessionId,
                } satisfies ChatMessage);
              const baseTranscript =
                message.subagentTranscript?.length
                  ? message.subagentTranscript
                  : buildSubagentTranscriptFromTaskEvent(event, fallbackTitle);
              const transcript = state.message
                ? [...baseTranscript, ...parseSubagentResultMessages(state.message, state.sessionId)]
                : baseTranscript;
              message.subagentId = state.sessionId;
              message.subagentTitle = message.subagentTitle ?? fallbackTitle;
              message.subagentMeta = undefined;
              message.subagentStatus = codexStateStatusToSubagentStatus(state.status);
              message.subagentComplete = message.subagentStatus !== "running";
              message.subagentTranscript = transcript;
              message.recentActivity = buildSubagentRecentActivity(transcript, state.message);
              if (!existingMessage) {
                turn.subagentCards.set(
                  codexTool === "spawn_agent" ? event.toolCallId : `${event.toolCallId}:${state.sessionId}`,
                  message
                );
                appendTimelineMessage(turn, message);
              }
            }
            break;
          }
          const title =
            (typeof rawInput?.description === "string" && rawInput.description.trim()) ||
            (typeof rawInput?.prompt === "string" && rawInput.prompt.trim()) ||
            (typeof event.title === "string" && event.title.trim() && event.title.trim().toLowerCase() !== "task"
              ? event.title.trim()
              : undefined) ||
            "Subagent task";
          const transcript = buildSubagentTranscriptFromTaskEvent(event, title);
          const existingMessage =
            findSubagentMessageBySessionId(turn, sessionIds) ?? turn.subagentCards.get(event.toolCallId);
          const message =
            existingMessage ??
            ({
              id: `subagent-${event.toolCallId}`,
              type: "subagent",
              subagentId: taskText.sessionId ?? taskText.taskId ?? event.toolCallId,
            } satisfies ChatMessage);
          message.subagentId = taskText.sessionId ?? taskText.taskId ?? event.toolCallId;
          message.subagentTitle = title;
          message.subagentMeta = undefined;
          message.subagentStatus =
            codexSubagentRuntimeStatus(event) ?? subagentStatusFromToolEventStatus(event.status);
          message.subagentComplete = message.subagentStatus !== "running";
          message.subagentTranscript = transcript;
          message.recentActivity = buildSubagentRecentActivity(
            transcript,
            (typeof rawInput?.description === "string" ? rawInput.description : undefined) ??
              (typeof rawInput?.prompt === "string" ? rawInput.prompt : undefined)
          );
          if (!existingMessage) {
            turn.subagentCards.set(event.toolCallId, message);
            appendTimelineMessage(turn, message);
          } else {
            turn.subagentCards.set(event.toolCallId, message);
          }
          break;
        }
        const existing = turn.toolEntryById.get(event.toolCallId) as
          | Extract<WorkedSessionEntry, { kind: "tool" }>
          | undefined;
        const entry = formatToolSummary(event, existing, workspaceRoot);
        if (!existing) {
          appendTraceEntry(turn, entry);
          turn.toolEntryById.set(event.toolCallId, entry);
        } else {
          Object.assign(existing, entry);
        }
        break;
      }
      case "tool_call_update": {
        const turn = ensureTurn();
        if (classifyToolCallAsSubagentCard(options?.backendId, event)) {
          const rawInput = getSubagentTaskInput(event);
          const taskText = extractSubagentTaskText(event);
          const sessionIds = extractSubagentSessionIds(event);
          const codexStates =
            options?.backendId === "codex-adapter" ? extractCodexSubagentStates(event) : [];
          const codexTool = options?.backendId === "codex-adapter" ? codexCollabToolName(event) : null;
          if (options?.backendId === "codex-adapter" && codexTool === "wait" && codexStates.length === 0) {
            break;
          }
          if (options?.backendId === "codex-adapter" && codexStates.length > 0) {
            const fallbackTitle =
              (typeof rawInput?.description === "string" && rawInput.description.trim()) ||
              (typeof rawInput?.prompt === "string" && rawInput.prompt.trim()) ||
              "Subagent task";
            for (const state of codexStates) {
              const existingMessage =
                (codexTool === "spawn_agent" ? turn.subagentCards.get(event.toolCallId) : undefined) ??
                findSubagentMessageBySessionId(turn, [state.sessionId]);
              const message =
                existingMessage ??
                ({
                  id: `subagent-${state.sessionId}`,
                  type: "subagent",
                  subagentId: state.sessionId,
                } satisfies ChatMessage);
              const baseTranscript =
                message.subagentTranscript?.length
                  ? message.subagentTranscript
                  : buildSubagentTranscriptFromTaskEvent(event, fallbackTitle);
              const transcript = state.message
                ? [...baseTranscript, ...parseSubagentResultMessages(state.message, state.sessionId)]
                : baseTranscript;
              message.subagentId = state.sessionId;
              message.subagentTitle = message.subagentTitle ?? fallbackTitle;
              message.subagentMeta = undefined;
              message.subagentStatus = codexStateStatusToSubagentStatus(state.status);
              message.subagentComplete = message.subagentStatus !== "running";
              message.subagentTranscript = transcript;
              message.recentActivity = buildSubagentRecentActivity(transcript, state.message);
              if (!existingMessage) {
                turn.subagentCards.set(
                  codexTool === "spawn_agent" ? event.toolCallId : `${event.toolCallId}:${state.sessionId}`,
                  message
                );
                appendTimelineMessage(turn, message);
              }
            }
            break;
          }
          const title =
            (typeof rawInput?.description === "string" && rawInput.description.trim()) ||
            (typeof rawInput?.prompt === "string" && rawInput.prompt.trim()) ||
            (typeof event.title === "string" && event.title.trim() && event.title.trim().toLowerCase() !== "task"
              ? event.title.trim()
              : undefined) ||
            "Subagent task";
          const transcript = buildSubagentTranscriptFromTaskEvent(event, title);
          const existingMessage =
            findSubagentMessageBySessionId(turn, sessionIds) ?? turn.subagentCards.get(event.toolCallId);
          const message =
            existingMessage ??
            ({
              id: `subagent-${event.toolCallId}`,
              type: "subagent",
              subagentId: taskText.sessionId ?? taskText.taskId ?? event.toolCallId,
            } satisfies ChatMessage);
          message.subagentId = taskText.sessionId ?? taskText.taskId ?? event.toolCallId;
          message.subagentTitle = title;
          message.subagentStatus =
            codexSubagentRuntimeStatus(event) ?? subagentStatusFromToolEventStatus(event.status);
          message.subagentComplete = message.subagentStatus !== "running";
          message.subagentMeta = undefined;
          message.subagentTranscript = transcript;
          message.recentActivity = buildSubagentRecentActivity(
            transcript,
            taskText.resultText ??
              (typeof rawInput?.description === "string" ? rawInput.description : undefined) ??
              (typeof rawInput?.prompt === "string" ? rawInput.prompt : undefined)
          );
          if (!existingMessage) {
            turn.subagentCards.set(event.toolCallId, message);
            appendTimelineMessage(turn, message);
          } else {
            turn.subagentCards.set(event.toolCallId, message);
          }
          break;
        }
        let existing = turn.toolEntryById.get(event.toolCallId) as
          | Extract<WorkedSessionEntry, { kind: "tool" }>
          | undefined;
        const unmatchedEntry = !existing ? formatToolSummary(event, undefined, workspaceRoot) : undefined;
        if (!existing) {
          const open = turn.trace.filter(
            (e): e is Extract<WorkedSessionEntry, { kind: "tool" }> =>
              e.kind === "tool" &&
              (e.status === "pending" || e.status === "running")
          );
          const terminalOrphan =
            event.status === "completed" ||
            event.status === "failed" ||
            event.status === "cancelled";
          const previewPath = unmatchedEntry?.files?.[0];
          const previewKind = unmatchedEntry?.toolKind;
          const previewTitle = unmatchedEntry?.title;
          const matchedByPath =
            previewPath != null
              ? open.find(
                  (entry) =>
                    entry.files?.includes(previewPath) &&
                    (!previewKind || !entry.toolKind || entry.toolKind === previewKind)
                )
              : undefined;
          const matchedByKindAndTitle =
            !matchedByPath && previewKind && previewTitle
              ? open.find(
                  (entry) =>
                    entry.toolKind === previewKind &&
                    entry.title === previewTitle
                )
              : undefined;
          if (matchedByPath || matchedByKindAndTitle) {
            existing = (matchedByPath ?? matchedByKindAndTitle)!;
            if (existing.toolCallId) {
              turn.toolEntryById.set(existing.toolCallId, existing);
            }
            turn.toolEntryById.set(event.toolCallId, existing);
          } else if (open.length >= 1) {
            const idx = terminalOrphan
              ? Math.min(turn.orphanToolUpdateSlot, open.length - 1)
              : 0;
            existing = open[idx];
            if (terminalOrphan) {
              turn.orphanToolUpdateSlot += 1;
            }
            if (existing.toolCallId) {
              turn.toolEntryById.set(existing.toolCallId, existing);
            }
            turn.toolEntryById.set(event.toolCallId, existing);
          }
        }
        const entry = existing
          ? formatToolSummary(event, existing, workspaceRoot)
          : unmatchedEntry ?? formatToolSummary(event, undefined, workspaceRoot);
        if (!existing) {
          appendTraceEntry(turn, entry);
          turn.toolEntryById.set(event.toolCallId, entry);
        } else {
          const keepToolCallId = existing.toolCallId;
          Object.assign(existing, entry);
          if (keepToolCallId) {
            existing.toolCallId = keepToolCallId;
          }
        }
        break;
      }
      case "plan": {
        const todos = toTodoItems(event.entries);
        const turn = ensureTurn();
        const message: ChatMessage =
          turn.todoCards.get(event.planId) ??
          {
            id: event.planId,
            type: "todo",
            todos: [],
            todoLabel: "0 of 0 Done",
          };
        message.todos = todos;
        message.todoLabel = summarizeTodoLabel(event.entries);
        if (!turn.todoCards.has(event.planId)) {
          turn.todoCards.set(event.planId, message);
          appendTimelineMessage(turn, message);
        }
        break;
      }
      case "permission_request": {
        const id = `permission-${event.requestId}`;
        const turn = ensureTurn();
        const message: ChatMessage =
          turn.permissionCards.get(id) ??
          {
            id,
            type: "permission-request",
            permissionRequestId: event.requestId,
          };
        message.permissionRequestId = event.requestId;
        message.permissionTitle = event.title ?? "Permission required";
        const toolEntry = event.toolCallId
          ? (turn.toolEntryById.get(event.toolCallId) as
              | Extract<WorkedSessionEntry, { kind: "tool" }>
              | undefined)
          : undefined;
        const fromTool =
          toolEntry?.title && toolEntry.title !== message.permissionTitle
            ? toolEntry.title
            : event.toolCallId
              ? `Tool call: ${event.toolCallId}`
              : undefined;
        message.permissionDetail =
          event.detail?.trim() ||
          fromTool ||
          undefined;
        message.permissionOptions = agentPermissionOptionsToUiChoices(event.options);
        if (!message.permissionResolved) {
          message.permissionResolved = false;
          message.permissionSelectedOptionId = undefined;
        }
        if (!turn.permissionCards.has(id)) {
          turn.permissionCards.set(id, message);
          appendTimelineMessage(turn, message);
        }
        break;
      }
      case "permission_resolved": {
        const id = `permission-${event.requestId}`;
        const turn = ensureTurn();
        const message = turn.permissionCards.get(id);
        if (message) {
          message.permissionResolved = true;
          message.permissionSelectedOptionId = event.optionId;
          message.permissionDetail =
            event.outcome === "cancelled"
              ? "Permission request cancelled."
              : event.optionId
                ? `Selected ${event.optionId}.`
                : "Permission resolved.";
        } else {
          appendTimelineMessage(turn, {
            id,
            type: "activity-label",
            activityLabel:
              event.outcome === "cancelled"
                ? "Permission cancelled"
                : "Permission resolved",
            activityDetail: event.optionId,
          });
        }
        break;
      }
      case "system": {
        appendTimelineMessage(ensureTurn(), {
          id: event.eventId,
          type: "assistant",
          content:
            event.level === "info"
              ? event.text
              : `[${event.level}] ${event.text}`,
        });
        break;
      }
      case "status": {
        if (event.status === "failed" || event.status === "cancelled") {
          finalizeOpenToolsInTurn(ensureTurn(), event.status);
        } else if (event.status === "idle") {
          finalizeOpenToolsInTurn(ensureTurn(), "completed");
        }
        if (
          event.status === "running" ||
          event.status === "idle" ||
          event.status === "awaiting_permission"
        ) {
          break;
        }
        appendTimelineMessage(ensureTurn(), {
          id: event.eventId,
          type: "activity-label",
          activityLabel: event.status[0].toUpperCase() + event.status.slice(1),
          activityDetail: event.detail,
        });
        break;
      }
      case "subagent": {
        const turn = ensureTurn();
        const transcript = projectAgentEventsToChatMessages(event.transcript || [], options);
        const message: ChatMessage = {
          id: event.eventId,
          type: "subagent",
          subagentId: event.subagentId,
          subagentTitle: event.title,
          subagentMeta: subagentMetaForDisplay(event.meta),
          subagentStatus: event.status,
          subagentComplete: event.status !== "running",
          subagentTranscript: transcript,
          recentActivity: event.recentActivity,
        };
        appendTimelineMessage(turn, message);
        break;
      }
      case "agent_handoff": {
        const turn = ensureTurn();
        turn.handoffMessageId = event.handoffMessageId;
        const message: ChatMessage = {
          id: event.eventId,
          type: "agent-handoff",
          handoffFromAgent: event.fromAgent,
          handoffToAgent: event.toAgent,
        };
        appendTimelineMessage(turn, message);
        break;
      }
      default:
        break;
    }
    } catch {
      // Skip events that cause rendering errors
    }
  }

  const messages: ChatMessage[] = [];
  for (const turn of turns) {
    if (turn.userMessage) {
      if (turn.handoffMessageId && turn.userMessage.id === turn.handoffMessageId) {
        messages.push({ ...turn.userMessage, isHandoffMessage: true });
      } else {
        messages.push(turn.userMessage);
      }
    }
    messages.push(...projectTurnTimelineToMessages(turn));
  }
  return messages;
}

export function getConversationLatestSeq(
  events: AgentStoredEvent[]
): number {
  return events.reduce((max, event) => Math.max(max, event.seq), 0);
}

function normalizeModelDetailLabel(label: string): string {
  return label.trim().toLowerCase();
}

function titleCaseModelDetail(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) {
    return trimmed;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "xhigh") {
    return "Extra High";
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function resolveThoughtOptionsForModel(
  modelOptionValue: NonNullable<ReturnType<typeof findConversationModelConfigOption>>["options"][number],
  thoughtLevelOption: NonNullable<ReturnType<typeof findConfigOptionByCategory>>
) {
  const supported = Array.isArray(modelOptionValue.metadata?.reasoningLevels)
    ? modelOptionValue.metadata?.reasoningLevels
    : null;
  if (!supported || supported.length === 0) {
    return [];
  }
  return thoughtLevelOption.options.filter((option) => supported.includes(option.value));
}

function formatModelVariantLabel(name: string, modelId: string): string {
  const trimmedName = name.trim() || modelId.trim() || "Model";
  const normalizedName = trimmedName.toLowerCase();
  const details: string[] = [];

  const bracketMatch = /^(.*)\[(.*)\]$/.exec(modelId.trim());
  if (bracketMatch) {
    for (const rawEntry of bracketMatch[2].split(",")) {
      const [rawKey, rawValue] = rawEntry.split("=");
      const key = rawKey?.trim().toLowerCase();
      const value = rawValue?.trim();
      if (!key || !value) {
        continue;
      }
      if (key === "reasoning" || key === "effort") {
        details.push(value);
        continue;
      }
      if (key === "context") {
        details.push(value.toUpperCase());
        continue;
      }
      if (key === "fast" && value === "true") {
        details.push("fast");
        continue;
      }
      if (key === "thinking" && value === "true") {
        details.push("thinking");
        continue;
      }
    }
  } else {
    const slashVariant = modelId.trim().split("/").at(-1)?.trim().toLowerCase();
    if (
      slashVariant &&
      ["low", "medium", "high", "xhigh", "thinking", "fast"].includes(slashVariant)
    ) {
      details.push(slashVariant);
    }
  }

  const uniqueDetails = details.filter((detail, index, array) => {
    const normalized = normalizeModelDetailLabel(detail);
    return (
      !normalizedName.includes(normalized) &&
      array.findIndex((candidate) => normalizeModelDetailLabel(candidate) === normalized) ===
        index
    );
  });

  return uniqueDetails.length > 0
    ? `${trimmedName} (${uniqueDetails.join(", ")})`
    : trimmedName;
}

export function buildConversationModelOptions(
  conversation: AgentConversationRecord,
  backends: AgentBackendInfo[]
): ModelInfo[] {
  const backend =
    backends.find((candidate) => candidate.id === conversation.config.backendId) ??
    backends[0];
  const provider = modelProviderForBackend(conversation.config.backendId);
  const modelOption = findConversationModelConfigOption(conversation, backends);
  const thoughtLevelOption = findConfigOptionByCategory(
    conversation,
    backends,
    "thought_level"
  );
  if (!modelOption || modelOption.options.length === 0) {
    return [
      {
        id: conversation.config.modelId || backend?.defaultModelId || "auto",
        modelValue: conversation.config.modelId || backend?.defaultModelId || "auto",
        name: formatModelVariantLabel(
          conversation.config.modelName || backend?.defaultModelName || "Auto",
          conversation.config.modelId || backend?.defaultModelId || "auto"
        ),
        provider,
        backendId: conversation.config.backendId,
        selected: true,
      },
    ];
  }
  /** Prefer persisted `config.modelId` so UI matches PATCH updates; option `currentValue` can lag when no runtime session. */
  const selectedValue =
    conversation.config.modelId ||
    modelOption.currentValue ||
    backend?.defaultModelId;
  const selectedName = conversation.config.modelName || backend?.defaultModelName;
  if (thoughtLevelOption && thoughtLevelOption.options.length > 0) {
    const selectedThought = thoughtLevelOption.currentValue;
    const variantRows = modelOption.options.flatMap((option) =>
      resolveThoughtOptionsForModel(option, thoughtLevelOption).map((thought) => {
        const baseName = formatModelVariantLabel(option.name, option.value);
        const thoughtLabel = titleCaseModelDetail(thought.name || thought.value);
        const normalizedThought = normalizeModelDetailLabel(thoughtLabel);
        const name = baseName.toLowerCase().includes(normalizedThought)
          ? baseName
          : `${baseName} ${thoughtLabel}`;
        return {
          id: `${option.value}::${thoughtLevelOption.id}::${thought.value}`,
          modelValue: option.value,
          name,
          description: option.description,
          detail: `${backend?.label ?? conversation.config.backendId} · ${thoughtLevelOption.name}: ${thoughtLabel}`,
          provider,
          backendId: conversation.config.backendId,
          configSelections: [{ configId: thoughtLevelOption.id, value: thought.value }],
          selected:
            option.value === selectedValue &&
            (!selectedThought || thought.value === selectedThought),
        } satisfies ModelInfo;
      })
    );
    if (variantRows.length > 0) {
      return variantRows;
    }
  }

  return modelOption.options.map((option) => ({
    id: option.value,
    modelValue: option.value,
    name: formatModelVariantLabel(option.name, option.value),
    description: option.description,
    detail: backend?.label ?? conversation.config.backendId,
    provider,
    backendId: conversation.config.backendId,
    selected:
      option.value === selectedValue ||
      (!selectedValue &&
        !!selectedName &&
        (option.name === selectedName ||
          formatModelVariantLabel(option.name, option.value) === selectedName)),
  }));
}

export function buildDraftModelOptionsForBackend(
  backend: AgentBackendInfo
): ModelInfo[] {
  return buildConversationModelOptions(createBackendDraftConversation(backend), [backend]);
}

export function resolveDraftModelForBackend(
  backend: AgentBackendInfo
): ModelInfo {
  return resolveConversationModel(createBackendDraftConversation(backend), [backend]);
}

export function buildDraftModeOptionsForBackend(
  backend: AgentBackendInfo
): AgentModeOption[] {
  return buildConversationModeOptions(createBackendDraftConversation(backend), [backend]);
}

export function resolveConversationModel(
  conversation: AgentConversationRecord,
  backends: AgentBackendInfo[]
): ModelInfo {
  const models = buildConversationModelOptions(conversation, backends);
  return (
    models.find((model) => model.selected) ??
    models[0] ?? {
      id: conversation.config.modelId,
      modelValue: conversation.config.modelId,
      name: formatModelVariantLabel(
        conversation.config.modelName,
        conversation.config.modelId
      ),
      provider: modelProviderForBackend(conversation.config.backendId),
      selected: true,
    }
  );
}
