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
  WorkedSessionEntry,
} from "@/lib/types";
import { DEFAULT_MODE_OPTIONS } from "@/lib/chat-modes";
import {
  findConversationModeConfigOptionForUi,
  findConversationModelConfigOptionForUi,
} from "@/lib/agent-config-option-utils";

function modelProviderForBackend(backendId: AgentBackendId): ModelInfo["provider"] {
  switch (backendId) {
    case "cursor-acp":
      return "cursor";
    case "opencode-acp":
      return "opencode";
    default:
      return "auto";
  }
}

export function findConversationModeConfigOption(
  conversation: AgentConversationRecord
) {
  return findConversationModeConfigOptionForUi(conversation);
}

export function buildConversationModeOptions(
  conversation: AgentConversationRecord
): AgentModeOption[] {
  const modeOption = findConversationModeConfigOption(conversation);
  if (!modeOption || modeOption.options.length === 0) {
    return DEFAULT_MODE_OPTIONS;
  }
  return modeOption.options.map((option) => ({
    id: option.value,
    label: option.name,
    description: option.description,
  }));
}

export function findConversationModelConfigOption(
  conversation: AgentConversationRecord
) {
  return findConversationModelConfigOptionForUi(conversation);
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

function toPermissionOptions(
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
  assistantMessage?: ChatMessage;
  activityMessage?: ChatMessage;
  toolEntries: WorkedSessionEntry[];
  toolEntryById: Map<string, WorkedSessionEntry>;
  permissionMessages: ChatMessage[];
  permissionCards: Map<string, ChatMessage>;
  todoMessages: ChatMessage[];
  todoCards: Map<string, ChatMessage>;
  trailingMessages: ChatMessage[];
};

function createTurn(id: string): ProjectedTurn {
  return {
    id,
    toolEntries: [],
    toolEntryById: new Map(),
    permissionMessages: [],
    permissionCards: new Map(),
    todoMessages: [],
    todoCards: new Map(),
    trailingMessages: [],
  };
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function toWorkedToolStatus(
  status: string
): Extract<WorkedSessionEntry, { kind: "tool" }>["status"] {
  switch (status) {
    case "in_progress":
      return "running";
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

function updateWorkedMessage(turn: ProjectedTurn): void {
  if (turn.toolEntries.length === 0) {
    turn.activityMessage = undefined;
    return;
  }
  if (!turn.activityMessage) {
    turn.activityMessage = {
      id: `turn-activity-${turn.id}`,
      type: "worked-session",
      workedLabel: "Working through tool calls",
      workedEntries: turn.toolEntries,
      workedDefaultOpen: true,
    };
  }
  const activeCount = turn.toolEntries.filter(
    (entry) =>
      entry.kind === "tool" &&
      (entry.status === "pending" || entry.status === "running")
  ).length;
  const failedCount = turn.toolEntries.filter(
    (entry) => entry.kind === "tool" && entry.status === "failed"
  ).length;
  turn.activityMessage.workedEntries = turn.toolEntries;
  turn.activityMessage.workedDefaultOpen = activeCount > 0;
  if (activeCount > 0) {
    turn.activityMessage.workedLabel = `Working through ${pluralize(
      turn.toolEntries.length,
      "tool call"
    )}`;
    return;
  }
  if (failedCount > 0) {
    turn.activityMessage.workedLabel = `Worked through ${pluralize(
      turn.toolEntries.length,
      "tool call"
    )} with ${pluralize(failedCount, "issue")}`;
    return;
  }
  turn.activityMessage.workedLabel = `Worked through ${pluralize(
    turn.toolEntries.length,
    "tool call"
  )}`;
}

function getToolRawUpdate(
  event: AgentStoredEvent
): Record<string, unknown> | undefined {
  const raw =
    "raw" in event && event.raw && typeof event.raw === "object"
      ? (event.raw as Record<string, unknown>)
      : undefined;
  const update = raw?.update;
  return update && typeof update === "object"
    ? (update as Record<string, unknown>)
    : undefined;
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

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function summarizeReadContent(content: string): { title?: string; detail?: string } {
  const trimmed = content.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.name === "string" &&
      parsed.scripts &&
      parsed.dependencies
    ) {
      return {
        title:
          parsed.name === "opencursor-server"
            ? "Read server package manifest"
            : "Read package manifest",
        detail: `${parsed.name} · ${pluralize(countLines(trimmed), "line")}`,
      };
    }
  } catch {
    // Ignore JSON parse failures.
  }

  if (trimmed.includes("export const agentRoutes = new Hono()")) {
    return {
      title: "Read server route source",
      detail: `${pluralize(countLines(trimmed), "line")} of Hono route code`,
    };
  }
  if (trimmed.includes('redirect("/editor")')) {
    return {
      title: "Read app redirect page",
      detail: `${pluralize(countLines(trimmed), "line")} of route code`,
    };
  }
  if (trimmed.includes("const WorkspaceContext = createContext")) {
    return {
      title: "Read workspace context source",
      detail: `${pluralize(countLines(trimmed), "line")} of React context code`,
    };
  }
  if (trimmed.includes("export function IDELayout()")) {
    return {
      title: "Read IDE layout source",
      detail: `${pluralize(countLines(trimmed), "line")} of layout code`,
    };
  }
  if (
    trimmed.includes("NEXT_PUBLIC_SERVER_URL") &&
    trimmed.includes("setActiveWorkspaceId")
  ) {
    return {
      title: "Read server API client",
      detail: `${pluralize(countLines(trimmed), "line")} of request helpers`,
    };
  }
  if (/^(?:\"use client\";|import\s)/.test(trimmed)) {
    return {
      title: "Read source file",
      detail: `${pluralize(countLines(trimmed), "line")} of source`,
    };
  }

  return {
    detail: `${pluralize(countLines(trimmed), "line")} of text`,
  };
}

function formatToolSummary(
  event: Extract<AgentStoredEvent, { kind: "tool_call" | "tool_call_update" }>,
  existing?: Extract<WorkedSessionEntry, { kind: "tool" }>
): Extract<WorkedSessionEntry, { kind: "tool" }> {
  const rawUpdate = getToolRawUpdate(event);
  const rawInput =
    rawUpdate?.rawInput && typeof rawUpdate.rawInput === "object"
      ? (rawUpdate.rawInput as Record<string, unknown>)
      : undefined;
  const rawOutput =
    rawUpdate?.rawOutput && typeof rawUpdate.rawOutput === "object"
      ? (rawUpdate.rawOutput as Record<string, unknown>)
      : undefined;

  const path =
    event.locations?.[0]?.path ??
    findFirstStringByKey(rawInput, [
      "path",
      "filePath",
      "filepath",
      "relativePath",
      "targetPath",
      "uri",
    ]) ??
    findFirstStringByKey(rawOutput, [
      "path",
      "filePath",
      "filepath",
      "relativePath",
      "targetPath",
      "uri",
    ]);

  const files =
    event.locations?.map((location) => location.path) ??
    findFirstStringArrayByKey(rawOutput, [
      "files",
      "paths",
      "matchedFiles",
      "results",
    ]) ??
    existing?.files;

  const status = toWorkedToolStatus(event.status);
  const explicitTitle = "title" in event ? event.title : undefined;
  const toolKind = "toolKind" in event ? event.toolKind : undefined;
  const detail = event.detail?.trim();

  if (toolKind === "search" || explicitTitle === "Find") {
    const query = findFirstStringByKey(rawInput, [
      "query",
      "pattern",
      "regex",
      "search",
      "searchTerm",
      "term",
      "needle",
    ]);
    const totalFiles = findFirstNumberByKey(rawOutput, [
      "totalFiles",
      "fileCount",
      "count",
    ]);
    return {
      kind: "tool",
      title: query ? `Find "${query}"` : "Find workspace matches",
      detail:
        detail ??
        (totalFiles != null
          ? `${pluralize(totalFiles, "file")} matched`
          : existing?.detail),
      status,
      files,
    };
  }

  if (toolKind === "read" || explicitTitle === "Read File") {
    const content = findFirstStringByKey(rawOutput, ["content", "text"]);
    const inferred = content ? summarizeReadContent(content) : {};
    return {
      kind: "tool",
      title: path ? `Read ${path}` : inferred.title ?? "Read file",
      detail:
        detail ??
        (path && inferred.detail
          ? inferred.detail
          : inferred.detail ?? existing?.detail),
      status,
      files: path ? [path, ...(files ?? []).filter((file) => file !== path)] : files,
    };
  }

  if (
    toolKind === "edit" ||
    toolKind === "write" ||
    /edit|write|patch|replace/i.test(explicitTitle ?? "")
  ) {
    const nextTitle = path
      ? `Update ${path}`
      : explicitTitle ?? existing?.title ?? "Update file";
    return {
      kind: "tool",
      title: nextTitle,
      detail: detail ?? existing?.detail,
      status,
      files: path ? [path, ...(files ?? []).filter((file) => file !== path)] : files,
    };
  }

  const command = findFirstStringByKey(rawInput, ["command", "cmd", "script"]);
  if (command) {
    return {
      kind: "tool",
      title: command,
      detail: detail ?? existing?.detail,
      variant: "terminal",
      status,
      files,
    };
  }

  return {
    kind: "tool",
    title: explicitTitle ?? existing?.title ?? "Tool call",
    detail: detail ?? existing?.detail,
    status,
    files,
    variant: existing?.variant,
  };
}

export function projectAgentEventsToChatMessages(
  events: AgentStoredEvent[]
): ChatMessage[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
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
    switch (event.kind) {
      case "user_message": {
        currentTurn = createTurn(event.messageId);
        currentTurn.userMessage = {
          id: event.messageId,
          type: "user",
          content: event.content,
          showReplyCue: true,
        };
        turns.push(currentTurn);
        break;
      }
      case "assistant_message_chunk": {
        const turn = ensureTurn();
        if (!turn.assistantMessage) {
          turn.assistantMessage = {
            id: event.messageId,
            type: "assistant",
            content: "",
          };
        }
        turn.assistantMessage.content = `${
          turn.assistantMessage.content ?? ""
        }${event.text}`;
        break;
      }
      case "assistant_message_end": {
        const turn = ensureTurn();
        if (!turn.assistantMessage && event.stopReason === "failed") {
          turn.assistantMessage = {
            id: event.messageId,
            type: "assistant",
            content: "The provider ended the turn without returning any visible text.",
          };
        }
        break;
      }
      case "tool_call": {
        const turn = ensureTurn();
        const existing = turn.toolEntryById.get(event.toolCallId) as
          | Extract<WorkedSessionEntry, { kind: "tool" }>
          | undefined;
        const entry = formatToolSummary(event, existing);
        if (!existing) {
          turn.toolEntries.push(entry);
          turn.toolEntryById.set(event.toolCallId, entry);
        } else {
          Object.assign(existing, entry);
        }
        updateWorkedMessage(turn);
        break;
      }
      case "tool_call_update": {
        const turn = ensureTurn();
        const existing = turn.toolEntryById.get(event.toolCallId) as
          | Extract<WorkedSessionEntry, { kind: "tool" }>
          | undefined;
        const entry = formatToolSummary(event, existing);
        if (!existing) {
          turn.toolEntries.push(entry);
          turn.toolEntryById.set(event.toolCallId, entry);
        } else {
          Object.assign(existing, entry);
        }
        updateWorkedMessage(turn);
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
          turn.todoMessages.push(message);
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
        message.permissionDetail = event.toolCallId
          ? `Tool call: ${event.toolCallId}`
          : undefined;
        message.permissionOptions = toPermissionOptions(event.options);
        if (!message.permissionResolved) {
          message.permissionResolved = false;
          message.permissionSelectedOptionId = undefined;
        }
        if (!turn.permissionCards.has(id)) {
          turn.permissionCards.set(id, message);
          turn.permissionMessages.push(message);
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
          turn.trailingMessages.push({
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
        ensureTurn().trailingMessages.push({
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
        if (
          event.status === "running" ||
          event.status === "idle" ||
          event.status === "awaiting_permission"
        ) {
          break;
        }
        ensureTurn().trailingMessages.push({
          id: event.eventId,
          type: "activity-label",
          activityLabel: event.status[0].toUpperCase() + event.status.slice(1),
          activityDetail: event.detail,
        });
        break;
      }
      default:
        break;
    }
  }

  const messages: ChatMessage[] = [];
  for (const turn of turns) {
    if (turn.userMessage) {
      messages.push(turn.userMessage);
    }
    if (turn.activityMessage?.workedEntries?.length) {
      updateWorkedMessage(turn);
      messages.push(turn.activityMessage);
    }
    messages.push(...turn.permissionMessages);
    if (turn.assistantMessage) {
      messages.push(turn.assistantMessage);
    }
    messages.push(...turn.todoMessages);
    messages.push(...turn.trailingMessages);
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
  const modelOption = findConversationModelConfigOption(conversation);
  if (!modelOption || modelOption.options.length === 0) {
    return [
      {
        id: conversation.config.modelId || backend?.defaultModelId || "auto",
        name: formatModelVariantLabel(
          conversation.config.modelName || backend?.defaultModelName || "Auto",
          conversation.config.modelId || backend?.defaultModelId || "auto"
        ),
        provider,
        selected: true,
      },
    ];
  }
  const selectedValue =
    modelOption.currentValue || conversation.config.modelId || backend?.defaultModelId;
  const selectedName = conversation.config.modelName || backend?.defaultModelName;
  return modelOption.options.map((option) => ({
    id: option.value,
    name: formatModelVariantLabel(option.name, option.value),
    provider,
    selected:
      option.value === selectedValue ||
      (!selectedValue &&
        !!selectedName &&
        (option.name === selectedName ||
          formatModelVariantLabel(option.name, option.value) === selectedName)),
  }));
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
      name: formatModelVariantLabel(
        conversation.config.modelName,
        conversation.config.modelId
      ),
      provider: modelProviderForBackend(conversation.config.backendId),
      selected: true,
    }
  );
}
