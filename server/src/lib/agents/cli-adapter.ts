import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  findPrimaryModelConfigOption,
  findPrimaryModeConfigOption,
} from "./config-option-utils.js";
import { spawnSafeEnv } from "./spawn-env.js";
import { writeAgentBackendConfigCache } from "./provider-cache-store.js";
import { formatRejectedToolDetail } from "./tool-rejection-utils.js";
import type {
  AgentBackendInfo,
  AgentConfigOption,
  AgentConversationSnapshot,
  AgentProvider,
  AgentProviderCapabilities,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
  AgentToolCallStatus,
} from "./types.js";

export type CliRuntimeSpec = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  commandPreview: string;
};

/** Use `-` as the prompt argv slot and send the real text on stdin (avoids Linux `ARG_MAX` / `spawn E2BIG`). */
const CLI_PROMPT_STDIN_ARG = "-";

type CliInvocation = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Full prompt passed on stdin (not in argv). Requires `args` to end with {@link CLI_PROMPT_STDIN_ARG}. */
  stdinPrompt?: string;
};

type CliToolEmitPayload = {
  toolCallId: string;
  title: string;
  toolKind: string;
  status: AgentToolCallStatus;
  detail?: string;
  raw?: unknown;
};

type CliPromptCallbacks = {
  appendAssistantText: (text: string) => Promise<void>;
  appendReasoningText: (text: string, raw?: unknown) => Promise<void>;
  setStopReason: (stopReason: string | undefined) => void;
  appendToolCall: (payload: CliToolEmitPayload) => Promise<void>;
  appendToolCallUpdate: (payload: {
    toolCallId: string;
    title?: string;
    toolKind?: string;
    status: AgentToolCallStatus;
    detail?: string;
    raw?: unknown;
  }) => Promise<void>;
};

type CliAdapterDefinition = {
  backend: AgentBackendInfo;
  runtime: CliRuntimeSpec;
  capabilities: AgentProviderCapabilities;
  initialConfigOptions: AgentConfigOption[];
  buildInvocation: (input: {
    workspaceRoot: string;
    prompt: string;
    configOptions: AgentConfigOption[];
  }) => CliInvocation;
  parseStdoutLine: (line: string, callbacks: CliPromptCallbacks) => void;
};

function buildTranscriptPrompt(
  snapshot: AgentConversationSnapshot | null,
  fallbackText: string
): string {
  if (!snapshot || snapshot.events.length === 0) {
    return fallbackText.trim();
  }

  const lines: string[] = [];
  const assistantChunks = new Map<string, string>();
  const flushAssistant = (messageId: string) => {
    const text = assistantChunks.get(messageId)?.trim();
    if (text) {
      lines.push(`Assistant: ${text}`);
    }
    assistantChunks.delete(messageId);
  };

  for (const event of snapshot.events) {
    switch (event.kind) {
      case "user_message":
        lines.push(`User: ${event.content}`);
        break;
      case "assistant_message_chunk": {
        const next = `${assistantChunks.get(event.messageId) ?? ""}${event.text}`;
        assistantChunks.set(event.messageId, next);
        break;
      }
      case "assistant_message_end":
        flushAssistant(event.messageId);
        break;
      default:
        break;
    }
  }

  for (const messageId of assistantChunks.keys()) {
    flushAssistant(messageId);
  }

  if (lines.length === 0) {
    return fallbackText.trim();
  }

  return [
    "You are continuing an existing OpenCursor conversation.",
    "Use the transcript below as context and answer the latest user request.",
    "",
    ...lines,
  ].join("\n");
}

async function spawnCliPrompt(
  invocation: CliInvocation,
  onStdoutLine: (line: string) => void,
  onStderrLine: (line: string) => void,
  onRegisterChild: (child: ChildProcess | null) => void
): Promise<number | null> {
  const stdinPrompt = invocation.stdinPrompt;
  const useStdin = typeof stdinPrompt === "string";
  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: spawnSafeEnv(invocation.env),
    stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  onRegisterChild(child);

  if (useStdin && child.stdin) {
    child.stdin.end(stdinPrompt, "utf8");
  }

  const stdout = child.stdout ? createInterface({ input: child.stdout }) : null;
  const stderr = child.stderr ? createInterface({ input: child.stderr }) : null;

  stdout?.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed) {
      onStdoutLine(trimmed);
    }
  });
  stderr?.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed) {
      onStderrLine(trimmed);
    }
  });

  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      onRegisterChild(null);
      reject(error);
    });
    child.once("exit", (code) => {
      onRegisterChild(null);
      resolve(code);
    });
  });
}

class OneShotCliSessionHandle implements AgentSessionHandle {
  readonly sessionId = randomUUID();
  configOptions: AgentConfigOption[];
  capabilities: AgentProviderCapabilities;

  private readonly backend: AgentBackendInfo;
  private readonly callbacks: AgentRuntimeCallbacks;
  private readonly definition: CliAdapterDefinition;
  private currentChild: ChildProcess | null = null;
  private disposed = false;
  private currentAssistantMessageId: string | null = null;

  constructor(input: {
    backend: AgentBackendInfo;
    callbacks: AgentRuntimeCallbacks;
    definition: CliAdapterDefinition;
    configOptions: AgentConfigOption[];
  }) {
    this.backend = input.backend;
    this.callbacks = input.callbacks;
    this.definition = input.definition;
    this.configOptions = input.configOptions;
    this.capabilities = input.definition.capabilities;
  }

  async initialize(): Promise<void> {
    const seededConfigOptions =
      this.callbacks.conversation.configOptions.length > 0
        ? this.callbacks.conversation.configOptions
        : this.configOptions.map((option) => {
            if (option.category === "mode" && this.callbacks.conversation.config.mode) {
              return { ...option, currentValue: this.callbacks.conversation.config.mode };
            }
            if (
              option.category === "model" &&
              this.callbacks.conversation.config.modelId &&
              option.options.some((candidate) => candidate.value === this.callbacks.conversation.config.modelId)
            ) {
              return { ...option, currentValue: this.callbacks.conversation.config.modelId };
            }
            return option;
          });
    await this.persistConfigOptions(seededConfigOptions);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      providerSessionId: null,
      capabilities: this.capabilities,
      status: "idle",
      pendingPermission: null,
      lastError: null,
    }));
  }

  async prompt(input: {
    text: string;
    userMessageId: string;
    attachments?: Array<{ mimeType: string; data: string; name?: string }>;
  }): Promise<void> {
    const assistantMessageId = randomUUID();
    this.currentAssistantMessageId = assistantMessageId;
    let sawAssistantText = false;
    let stopReason: string | undefined;
    const snapshot = await this.callbacks.readSnapshot();
    const prompt = buildTranscriptPrompt(snapshot, input.text);

    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
      lastError: null,
    }));

    try {
      const toolEmitOrder: string[] = [];
      const emittedToolIds = new Set<string>();
      const completedEmitIds = new Set<string>();

      const resolveToolUpdateId = (rawId: string, advanceQueue: boolean): string => {
        if (emittedToolIds.has(rawId)) {
          return rawId;
        }
        if (!advanceQueue) {
          return rawId;
        }
        for (const id of toolEmitOrder) {
          if (!completedEmitIds.has(id)) {
            return id;
          }
        }
        return rawId;
      };

      const exitCode = await spawnCliPrompt(
        this.definition.buildInvocation({
          workspaceRoot: this.callbacks.workspace.root,
          prompt,
          configOptions: this.configOptions,
        }),
        (line) => {
          this.definition.parseStdoutLine(line, {
            appendAssistantText: async (text) => {
              if (!text.trim() || !this.currentAssistantMessageId) {
                return;
              }
              sawAssistantText = true;
              await this.callbacks.appendEvents([
                {
                  eventId: randomUUID(),
                  conversationId: this.callbacks.conversation.id,
                  kind: "assistant_message_chunk",
                  messageId: this.currentAssistantMessageId,
                  text,
                },
              ]);
            },
            appendReasoningText: async (text, raw) => {
              if (!text.trim() || !this.currentAssistantMessageId) {
                return;
              }
              sawAssistantText = true;
              await this.callbacks.appendEvents([
                {
                  eventId: randomUUID(),
                  conversationId: this.callbacks.conversation.id,
                  kind: "reasoning",
                  messageId: this.currentAssistantMessageId,
                  text,
                  raw,
                },
              ]);
            },
            setStopReason: (nextStopReason) => {
              stopReason = nextStopReason;
            },
            appendToolCall: async (payload) => {
              sawAssistantText = true;
              emittedToolIds.add(payload.toolCallId);
              toolEmitOrder.push(payload.toolCallId);
              await this.callbacks.appendEvents([
                {
                  eventId: randomUUID(),
                  conversationId: this.callbacks.conversation.id,
                  kind: "tool_call",
                  toolCallId: payload.toolCallId,
                  title: payload.title,
                  toolKind: payload.toolKind,
                  status: payload.status,
                  detail: payload.detail,
                  raw: payload.raw,
                },
              ]);
            },
            appendToolCallUpdate: async (payload) => {
              sawAssistantText = true;
              const terminal =
                payload.status === "completed" ||
                payload.status === "failed" ||
                payload.status === "cancelled";
              const canonicalId = resolveToolUpdateId(payload.toolCallId, terminal);
              if (terminal) {
                completedEmitIds.add(canonicalId);
              }
              await this.callbacks.appendEvents([
                {
                  eventId: randomUUID(),
                  conversationId: this.callbacks.conversation.id,
                  kind: "tool_call_update",
                  toolCallId: canonicalId,
                  title: payload.title,
                  toolKind: payload.toolKind,
                  status: payload.status,
                  detail: payload.detail,
                  raw: payload.raw,
                },
              ]);
            },
          });
        },
        (line) => {
          void this.callbacks.appendEvents([
            {
              eventId: randomUUID(),
              conversationId: this.callbacks.conversation.id,
              kind: "system",
              level: "warning",
              text: `[${this.backend.label}] ${line}`,
            },
          ]);
        },
        (child) => {
          this.currentChild = child;
        }
      );

      if (!sawAssistantText) {
        throw new Error(`${this.backend.label} returned no assistant text.`);
      }
      if (exitCode && exitCode !== 0) {
        throw new Error(`${this.backend.label} exited with code ${exitCode}.`);
      }

      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "assistant_message_end",
          messageId: assistantMessageId,
          stopReason,
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "idle",
          detail: stopReason,
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "idle",
        pendingPermission: null,
        lastError: null,
      }));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `${this.backend.label} prompt failed.`;
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "error",
          text: message,
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "failed",
          detail: message,
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "failed",
        lastError: message,
        pendingPermission: null,
      }));
      throw error;
    } finally {
      this.currentAssistantMessageId = null;
      this.currentChild = null;
    }
  }

  async cancel(): Promise<void> {
    if (this.currentChild && !this.currentChild.killed) {
      this.currentChild.kill();
    }
    this.currentChild = null;
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "cancelled",
        detail: "Prompt turn cancelled by the client.",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "idle",
      pendingPermission: null,
    }));
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    const nextConfigOptions = this.configOptions.map((option) =>
      option.id === configId ? { ...option, currentValue: value } : option
    );
    await this.persistConfigOptions(nextConfigOptions);
  }

  async answerPermission(): Promise<void> {
    throw new Error(`${this.backend.label} does not expose interactive permissions yet.`);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.currentChild && !this.currentChild.killed) {
      this.currentChild.kill();
    }
    this.currentChild = null;
  }

  private async persistConfigOptions(nextConfigOptions: AgentConfigOption[]): Promise<void> {
    this.configOptions = nextConfigOptions;
    await writeAgentBackendConfigCache(this.backend.id, nextConfigOptions);
    await this.callbacks.updateConversation((current) => {
      const modeOption = findPrimaryModeConfigOption(nextConfigOptions);
      const modelOption = findPrimaryModelConfigOption(nextConfigOptions);
      const modelId = modelOption?.currentValue || current.config.modelId;
      const modelName =
        modelOption?.options.find((option) => option.value === modelId)?.name ??
        current.config.modelName;
      return {
        ...current,
        configOptions: nextConfigOptions,
        config: {
          ...current.config,
          mode: (modeOption?.currentValue || current.config.mode) as typeof current.config.mode,
          modelId,
          modelName,
        },
      };
    });
  }
}

function currentValueFor(configOptions: AgentConfigOption[], configId: string): string {
  return configOptions.find((option) => option.id === configId)?.currentValue ?? "";
}

function summarizeUnknownForToolDetail(value: unknown, maxLen = 280): string | undefined {
  if (value == null) {
    return undefined;
  }
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    if (!s || s === "{}") {
      return undefined;
    }
    return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
  } catch {
    return undefined;
  }
}

function pluralizeToolCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function tryParseToolArgumentsRecord(input: unknown): Record<string, unknown> | undefined {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input === "string" && input.trim()) {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function firstPathFromToolArgs(record: Record<string, unknown>): string | undefined {
  for (const key of [
    "path",
    "filePath",
    "filepath",
    "relativePath",
    "targetPath",
    "uri",
  ] as const) {
    const v = record[key];
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }
  return undefined;
}

function firstPatternFromToolArgs(record: Record<string, unknown>): string | undefined {
  for (const key of [
    "globPattern",
    "pattern",
    "query",
    "regex",
    "search",
    "searchTerm",
    "term",
    "needle",
  ] as const) {
    const v = record[key];
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }
  return undefined;
}

function firstCommandFromToolArgs(record: Record<string, unknown>): string | undefined {
  for (const key of ["command", "cmd", "script"] as const) {
    const v = record[key];
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }
  return undefined;
}

function humanizeCliToolName(value: string): string {
  return value
    .replace(/ToolCall$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .trim();
}

function cliRecordHasAnyKey(
  record: Record<string, unknown> | undefined,
  keys: readonly string[]
): boolean {
  if (!record) {
    return false;
  }
  return keys.some((key) => key in record && record[key] != null);
}

function looksLikeCliEditPayload(record: Record<string, unknown> | undefined): boolean {
  if (!record) {
    return false;
  }
  if (
    cliRecordHasAnyKey(record, [
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
      "renameTo",
      "newPath",
      "contents",
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

function looksLikeCliReadPayload(record: Record<string, unknown> | undefined): boolean {
  if (!record || looksLikeCliEditPayload(record)) {
    return false;
  }
  return cliRecordHasAnyKey(record, [
    "content",
    "text",
    "totalLines",
    "readRange",
    "contentBlobId",
    "isEmpty",
    "exceededLimit",
  ]);
}

function inferCliToolKind(rawName: string, input: unknown, result?: unknown): string {
  const inputRecord = tryParseToolArgumentsRecord(input);
  const resultRecord = tryParseToolArgumentsRecord(result);
  if (looksLikeCliEditPayload(resultRecord) || looksLikeCliEditPayload(inputRecord)) {
    return "edit";
  }
  const fromName = inferCliToolKindFromName(rawName);
  if (fromName !== "tool") {
    return fromName;
  }
  if (looksLikeCliReadPayload(resultRecord) || looksLikeCliReadPayload(inputRecord)) {
    return "read";
  }
  return "tool";
}

function buildCliToolDisplayTitle(rawName: string, input: unknown, result?: unknown): string {
  const args = tryParseToolArgumentsRecord(input);
  const resultRecord = tryParseToolArgumentsRecord(result);
  const path =
    (args ? firstPathFromToolArgs(args) : undefined) ??
    (resultRecord ? firstPathFromToolArgs(resultRecord) : undefined);
  const pattern =
    (args ? firstPatternFromToolArgs(args) : undefined) ??
    (resultRecord ? firstPatternFromToolArgs(resultRecord) : undefined);
  const command =
    (args ? firstCommandFromToolArgs(args) : undefined) ??
    (resultRecord ? firstCommandFromToolArgs(resultRecord) : undefined);
  const kind = inferCliToolKind(rawName, input, result);
  if (kind === "read") {
    return path ? `Read ${path}` : "Read file";
  }
  if (kind === "grep") {
    return pattern ? `Grep "${pattern}"` : "Grep workspace";
  }
  if (kind === "search_web") {
    return pattern ? `Search web for "${pattern}"` : "Search web";
  }
  if (kind === "search") {
    return pattern ? `Find "${pattern}"` : "Find workspace matches";
  }
  if (kind === "delete") {
    return path ? `Delete ${path}` : "Delete file";
  }
  if (kind === "edit") {
    return path ? `Update ${path}` : "Update file";
  }
  if (kind === "todo") {
    return "Update todo list";
  }
  if (kind === "terminal") {
    return command ?? "Run command";
  }
  return humanizeCliToolName(String(rawName));
}

function countLinesInText(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function extractCliFileCountFromResult(value: unknown): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const directFileEntries = value.filter(
      (entry) =>
        typeof entry === "string" ||
        (entry && typeof entry === "object" && "file" in (entry as Record<string, unknown>))
    );
    return directFileEntries.length > 0 ? directFileEntries.length : undefined;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.totalFiles === "number") {
    return record.totalFiles;
  }
  if (typeof record.fileCount === "number") {
    return record.fileCount;
  }
  for (const key of ["files", "matchedFiles", "results", "matches"] as const) {
    const nested = extractCliFileCountFromResult(record[key]);
    if (nested != null) {
      return nested;
    }
  }
  if (record.workspaceResults && typeof record.workspaceResults === "object") {
    let total = 0;
    for (const workspaceResult of Object.values(record.workspaceResults as Record<string, unknown>)) {
      const nested = extractCliFileCountFromResult(workspaceResult);
      if (nested != null) {
        total += nested;
      }
    }
    if (total > 0) {
      return total;
    }
  }
  if (record.content && typeof record.content === "object") {
    return extractCliFileCountFromResult(record.content);
  }
  return undefined;
}

function inferCliToolKindFromName(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("todo")) {
    return "todo";
  }
  if (n.includes("websearch") || (n.includes("web") && n.includes("search"))) {
    return "search_web";
  }
  if (n.includes("grep") || n.includes("ripgrep")) {
    return "grep";
  }
  if (n.includes("glob") || n.includes("search") || n.includes("find")) {
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
  if (n.includes("read") || n.includes("open") || n.includes("view") || n.includes("load")) {
    return "read";
  }
  if (n.includes("run") || n.includes("shell") || n.includes("command") || n.includes("bash")) {
    return "terminal";
  }
  return "tool";
}

/** Same stable hash inputs as `function_call` when `item.completed` omits explicit link ids. */
function stableIdForCompletedToolItem(item: Record<string, unknown>): string {
  const itemType = typeof item.type === "string" ? item.type : "tool";
  const fn =
    item.function && typeof item.function === "object"
      ? (item.function as Record<string, unknown>)
      : null;
  const fc =
    item.function_call && typeof item.function_call === "object"
      ? (item.function_call as Record<string, unknown>)
      : null;
  const rawName =
    (typeof item.name === "string" && item.name) ||
    (fn && typeof fn.name === "string" && fn.name) ||
    (fc && typeof fc.name === "string" && fc.name) ||
    itemType;
  const input =
    item.arguments ??
    item.input ??
    item.args ??
    (fn && (fn.arguments ?? fn.input)) ??
    (fc && (fc.arguments ?? fc.input));
  return stableCliToolCallId(String(rawName), input);
}

function normalizeStreamJsonToolStatus(value: unknown): AgentToolCallStatus {
  if (
    value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  return "in_progress";
}

function normalizeCliToolEventStatus(
  record: Record<string, unknown>,
  fallback: AgentToolCallStatus = "in_progress"
): AgentToolCallStatus {
  if (record.subtype === "completed") {
    return "completed";
  }
  if (record.subtype === "started") {
    return "in_progress";
  }
  const normalized = normalizeStreamJsonToolStatus(record.status);
  return normalized === "in_progress" && record.status == null ? fallback : normalized;
}

function stableCliToolCallId(rawName: string, input: unknown): string {
  try {
    const payload = `${rawName}:${typeof input === "string" ? input : JSON.stringify(input)}`;
    let h = 0;
    for (let i = 0; i < payload.length; i++) {
      h = (Math.imul(31, h) + payload.charCodeAt(i)) | 0;
    }
    return `cli-tool-${(h >>> 0).toString(16)}`;
  } catch {
    return randomUUID();
  }
}

/** IDs that link `function_call` rows to `tool_result` / `item.completed` in stream-json. */
function extractToolCallIdFromRecord(record: Record<string, unknown>): string | null {
  for (const key of [
    "call_id",
    "tool_call_id",
    "tool_use_id",
    "toolCallId",
    "toolUseId",
    "callId",
  ] as const) {
    const v = record[key];
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }
  if (typeof record.id === "string" && record.id.trim()) {
    return record.id.trim();
  }
  return null;
}

function extractToolCallIdFromNestedItem(item: Record<string, unknown>): string | null {
  const direct = extractToolCallIdFromRecord(item);
  if (direct) {
    return direct;
  }
  for (const key of [
    "tool_call",
    "function_call",
    "tool",
    "function",
    "payload",
    "content",
    "metadata",
    "delta",
  ] as const) {
    const v = item[key];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = extractToolCallIdFromRecord(v as Record<string, unknown>);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function extractToolCallIdFromToolArgs(input: unknown): string | null {
  const record = tryParseToolArgumentsRecord(input);
  if (!record) {
    return null;
  }
  return extractToolCallIdFromRecord(record) || extractToolCallIdFromNestedItem(record);
}

type CliNestedToolCallEntry = {
  rawName: string;
  input: unknown;
  result: unknown;
  record: Record<string, unknown>;
};

function extractCliNestedToolCallEntries(
  record: Record<string, unknown>
): CliNestedToolCallEntry[] {
  const container =
    record.tool_call && typeof record.tool_call === "object" && !Array.isArray(record.tool_call)
      ? (record.tool_call as Record<string, unknown>)
      : record.toolCall && typeof record.toolCall === "object" && !Array.isArray(record.toolCall)
        ? (record.toolCall as Record<string, unknown>)
        : undefined;
  if (!container) {
    return [];
  }
  const entries: CliNestedToolCallEntry[] = [];
  for (const [rawName, value] of Object.entries(container)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const toolRecord = value as Record<string, unknown>;
    entries.push({
      rawName,
      input: toolRecord.args ?? toolRecord.input,
      result: toolRecord.result ?? toolRecord.output,
      record: toolRecord,
    });
  }
  return entries;
}

function resolveCliToolCallId(
  rawName: string,
  input: unknown,
  ...records: Array<Record<string, unknown> | null | undefined>
): string {
  for (const record of records) {
    if (!record) {
      continue;
    }
    const direct = extractToolCallIdFromRecord(record) || extractToolCallIdFromNestedItem(record);
    if (direct) {
      return direct;
    }
  }
  return extractToolCallIdFromToolArgs(input) || stableCliToolCallId(rawName, input);
}

function resolveCliNestedToolCallId(
  parentRecord: Record<string, unknown>,
  entry: CliNestedToolCallEntry,
  entryCount: number
): string {
  const nestedDirect =
    extractToolCallIdFromRecord(entry.record) || extractToolCallIdFromNestedItem(entry.record);
  if (nestedDirect) {
    return nestedDirect;
  }
  const argDirect = extractToolCallIdFromToolArgs(entry.input);
  if (argDirect) {
    return argDirect;
  }
  const parentDirect =
    extractToolCallIdFromRecord(parentRecord) || extractToolCallIdFromNestedItem(parentRecord);
  if (parentDirect && entryCount === 1) {
    return parentDirect;
  }
  if (parentDirect) {
    return `${parentDirect}:${stableCliToolCallId(entry.rawName, entry.input)}`;
  }
  return stableCliToolCallId(entry.rawName, entry.input);
}

function summarizeCliToolResultDetail(
  rawName: string,
  input: unknown,
  result: unknown
): string | undefined {
  const kind = inferCliToolKind(rawName, input, result);
  const record = tryParseToolArgumentsRecord(result);
  if (
    record?.rejected &&
    typeof record.rejected === "object" &&
    !Array.isArray(record.rejected)
  ) {
    const rejected = record.rejected as Record<string, unknown>;
    return formatRejectedToolDetail(rejected);
  }
  const payload =
    record?.success !== undefined
      ? record.success
      : record?.output !== undefined
        ? record.output
        : result;
  const payloadRecord = tryParseToolArgumentsRecord(payload);
  const inputRecord = tryParseToolArgumentsRecord(input);
  if (kind === "read") {
    if (payloadRecord?.isEmpty === true) {
      return "Empty file";
    }
    if (typeof payloadRecord?.totalLines === "number") {
      return `${pluralizeToolCount(payloadRecord.totalLines, "line")} read`;
    }
    if (typeof payloadRecord?.content === "string") {
      return `${pluralizeToolCount(countLinesInText(payloadRecord.content), "line")} read`;
    }
    const path =
      (payloadRecord && typeof payloadRecord.path === "string" && payloadRecord.path) ||
      (inputRecord ? firstPathFromToolArgs(inputRecord) : undefined);
    return path || undefined;
  }
  if (kind === "edit") {
    const path =
      (payloadRecord && typeof payloadRecord.path === "string" && payloadRecord.path) ||
      (inputRecord ? firstPathFromToolArgs(inputRecord) : undefined);
    const linesAdded =
      payloadRecord && typeof payloadRecord.linesAdded === "number"
        ? payloadRecord.linesAdded
        : undefined;
    const linesRemoved =
      payloadRecord && typeof payloadRecord.linesRemoved === "number"
        ? payloadRecord.linesRemoved
        : undefined;
    if (linesAdded != null || linesRemoved != null) {
      return `${linesAdded ?? 0} added, ${linesRemoved ?? 0} removed`;
    }
    return path ? `Updated ${path}` : "Updated file";
  }
  if (kind === "grep" || kind === "search") {
    const fileCount = extractCliFileCountFromResult(payload);
    return fileCount != null ? `${pluralizeToolCount(fileCount, "file")} matched` : undefined;
  }
  if (kind === "todo") {
    const todoCount = Array.isArray(inputRecord?.todos) ? inputRecord.todos.length : undefined;
    return todoCount != null ? `${pluralizeToolCount(todoCount, "item")} updated` : undefined;
  }
  return summarizeUnknownForToolDetail(payload);
}

function emitCliToolEvent(
  callbacks: CliPromptCallbacks,
  payload: CliToolEmitPayload
): void {
  const terminal =
    payload.status === "completed" ||
    payload.status === "failed" ||
    payload.status === "cancelled";
  if (terminal) {
    void callbacks.appendToolCallUpdate({
      toolCallId: payload.toolCallId,
      title: payload.title,
      toolKind: payload.toolKind,
      status: payload.status,
      detail: payload.detail,
      raw: payload.raw,
    });
    return;
  }
  void callbacks.appendToolCall(payload);
}

const SKIP_ASSISTANT_CONTENT_TYPES = new Set([
  "reasoning",
  "thinking",
  "redacted_thinking",
  "citations",
  "image",
  "image_url",
  "input_audio",
]);

/** `item.completed` rows that are not user-visible tool traces */
const SKIP_CLI_ITEM_TRACE_TYPES = new Set([
  "reasoning",
  "thinking",
  "redacted_thinking",
  "citations",
]);

function parseCursorAssistantBlocks(
  message: Record<string, unknown>,
  callbacks: CliPromptCallbacks
): void {
  const content = message.content;
  if (typeof content === "string" && content.trim()) {
    void callbacks.appendAssistantText(content);
    return;
  }
  let parts: unknown[] = [];
  if (Array.isArray(content)) {
    parts = content;
  } else if (content && typeof content === "object" && Array.isArray((content as Record<string, unknown>).parts)) {
    parts = (content as Record<string, unknown>).parts as unknown[];
  }
  for (const entry of parts) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const t = typeof record.type === "string" ? record.type : "";

    if (
      (t === "reasoning" || t === "thinking" || t === "redacted_thinking") &&
      typeof record.text === "string" &&
      record.text.trim()
    ) {
      void callbacks.appendReasoningText(record.text, record);
      continue;
    }

    if (SKIP_ASSISTANT_CONTENT_TYPES.has(t)) {
      continue;
    }

    if (t === "text" && typeof record.text === "string" && record.text) {
      void callbacks.appendAssistantText(record.text);
      continue;
    }

    if (t === "function_call" || t === "function") {
      const fn =
        record.function && typeof record.function === "object"
          ? (record.function as Record<string, unknown>)
          : null;
      const rawName =
        (typeof record.name === "string" && record.name) ||
        (fn && typeof fn.name === "string" && fn.name) ||
        "function";
      const input =
        record.arguments ??
        record.input ??
        record.args ??
        (fn && (fn.arguments ?? fn.input));
      emitCliToolEvent(callbacks, {
        toolCallId: resolveCliToolCallId(String(rawName), input, record, fn),
        title: buildCliToolDisplayTitle(String(rawName), input),
        toolKind: inferCliToolKind(String(rawName), input),
        status: normalizeCliToolEventStatus(record),
        detail: summarizeUnknownForToolDetail(input),
        raw: record,
      });
      continue;
    }

    if (
      t === "tool_result" ||
      t === "tool_output" ||
      t === "function_call_output" ||
      t === "tool_result_block"
    ) {
      const out =
        record.content ?? record.output ?? record.result ?? record.text ?? record.stdout;
      const rawName =
        (typeof record.name === "string" && record.name) ||
        (typeof record.tool_name === "string" && record.tool_name) ||
        t;
      const idInput = record.input ?? record.arguments ?? record.args ?? out;
      emitCliToolEvent(callbacks, {
        toolCallId: resolveCliToolCallId(String(rawName), idInput, record),
        title: buildCliToolDisplayTitle(
          String(rawName),
          record.input ?? record.arguments ?? record.args,
          out
        ),
        toolKind: inferCliToolKind(
          String(rawName),
          record.input ?? record.arguments ?? record.args,
          out
        ),
        status: normalizeCliToolEventStatus(record, "completed"),
        detail: summarizeCliToolResultDetail(
          String(rawName),
          record.input ?? record.arguments ?? record.args,
          out
        ),
        raw: record,
      });
      continue;
    }

    if (!t || t === "text") {
      continue;
    }

    const input = record.input ?? record.arguments ?? record.args ?? record.params;
    const rawName =
      (typeof record.name === "string" && record.name) ||
      (typeof record.tool_name === "string" && record.tool_name) ||
      t;
    emitCliToolEvent(callbacks, {
      toolCallId: resolveCliToolCallId(String(rawName), input, record),
      title: buildCliToolDisplayTitle(String(rawName), input),
      toolKind: inferCliToolKind(String(rawName), input),
      status: normalizeCliToolEventStatus(record),
      detail: summarizeUnknownForToolDetail(input),
      raw: record,
    });
  }
}

function buildCodexInvocation(input: {
  runtime: CliRuntimeSpec;
  workspaceRoot: string;
  prompt: string;
  configOptions: AgentConfigOption[];
}): CliInvocation {
  const model = currentValueFor(input.configOptions, "model");
  const args = [
    ...input.runtime.args,
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "-C",
    input.workspaceRoot,
  ];
  if (model && model !== "__default__") {
    args.push("--model", model);
  }
  args.push(CLI_PROMPT_STDIN_ARG);
  return {
    command: input.runtime.command,
    args,
    env: input.runtime.env,
    cwd: input.workspaceRoot,
    stdinPrompt: input.prompt,
  };
}

function parseCodexStdoutLine(line: string, callbacks: CliPromptCallbacks): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (type === "item.completed") {
    const item = parsed.item && typeof parsed.item === "object"
      ? (parsed.item as Record<string, unknown>)
      : null;
    const itemType = typeof item?.type === "string" ? item.type : "";
    const text = typeof item?.text === "string" ? item.text : "";
    if (itemType === "agent_message" && text) {
      void callbacks.appendAssistantText(text);
      return;
    }
    if (
      itemType &&
      SKIP_CLI_ITEM_TRACE_TYPES.has(itemType) &&
      text.trim() &&
      (itemType === "reasoning" || itemType === "thinking" || itemType === "redacted_thinking")
    ) {
      void callbacks.appendReasoningText(text, item);
      return;
    }
    if (itemType && SKIP_CLI_ITEM_TRACE_TYPES.has(itemType)) {
      return;
    }
    if (item && itemType && itemType !== "agent_message") {
      const ir = item;
      const itemId =
        extractToolCallIdFromNestedItem(ir) ||
        (typeof ir.item_id === "string" && ir.item_id) ||
        stableIdForCompletedToolItem(ir);
      const title = itemType.replace(/_/g, " ");
      const detail =
        text.trim() ||
        summarizeUnknownForToolDetail(ir.output ?? ir.result ?? ir.command ?? ir.arguments);
      void callbacks.appendToolCallUpdate({
        toolCallId: itemId,
        title,
        toolKind: inferCliToolKind(title, ir.arguments, ir.output ?? ir.result ?? ir.command),
        status: "completed",
        detail,
        raw: ir,
      });
    }
    return;
  }
  if (type === "turn.completed") {
    callbacks.setStopReason("completed");
  }
}

function buildCursorInvocation(input: {
  runtime: CliRuntimeSpec;
  workspaceRoot: string;
  prompt: string;
  configOptions: AgentConfigOption[];
}): CliInvocation {
  const model = currentValueFor(input.configOptions, "model") || "auto";
  const mode = currentValueFor(input.configOptions, "mode") || "agent";
  const args = [
    ...input.runtime.args,
    "--print",
    "--output-format",
    "stream-json",
    "--workspace",
    input.workspaceRoot,
  ];
  if (mode && mode !== "agent") {
    args.push("--mode", mode);
  }
  if (model && model !== "auto") {
    args.push("--model", model);
  }
  // Cursor CLI reads from stdin by default without a "-" argument.
  // Passing "-" makes it treat "-" as the literal prompt text.
  return {
    command: input.runtime.command,
    args,
    env: input.runtime.env,
    cwd: input.workspaceRoot,
    stdinPrompt: input.prompt,
  };
}

function parseCursorStdoutLine(line: string, callbacks: CliPromptCallbacks): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const type = typeof parsed.type === "string" ? parsed.type : "";
  const message =
    parsed.message && typeof parsed.message === "object"
      ? (parsed.message as Record<string, unknown>)
      : null;
  const role = message && typeof message.role === "string" ? message.role : "";
  const shouldParseAssistantBlocks =
    message &&
    role !== "user" &&
    (type === "assistant" ||
      (type === "message" && (role === "assistant" || role === "system")) ||
      /** Some stream-json lines omit `type` but carry assistant `message` */
      (!type && role === "assistant"));

  if (shouldParseAssistantBlocks) {
    parseCursorAssistantBlocks(message, callbacks);
    return;
  }
  if (type === "tool_call" || type === "tool_use") {
    const nestedEntries = extractCliNestedToolCallEntries(parsed);
    const status = normalizeCliToolEventStatus(parsed);
    if (nestedEntries.length > 0) {
      for (const entry of nestedEntries) {
        const raw =
          nestedEntries.length === 1
            ? parsed
            : { ...parsed, tool_call: { [entry.rawName]: entry.record } };
        emitCliToolEvent(callbacks, {
          toolCallId: resolveCliNestedToolCallId(parsed, entry, nestedEntries.length),
          title: buildCliToolDisplayTitle(entry.rawName, entry.input, entry.result),
          toolKind: inferCliToolKind(entry.rawName, entry.input, entry.result),
          status,
          detail:
            status === "completed" || status === "failed" || status === "cancelled"
              ? summarizeCliToolResultDetail(entry.rawName, entry.input, entry.result) ??
                summarizeUnknownForToolDetail(entry.input)
              : summarizeUnknownForToolDetail(entry.input),
          raw,
        });
      }
      return;
    }
    const rawName =
      (typeof parsed.name === "string" && parsed.name) ||
      (typeof parsed.tool_name === "string" && parsed.tool_name) ||
      type;
    const input = parsed.input ?? parsed.arguments ?? parsed.args ?? parsed.content;
    emitCliToolEvent(callbacks, {
      toolCallId: resolveCliToolCallId(String(rawName), input, parsed),
      title: buildCliToolDisplayTitle(
        String(rawName),
        input,
        parsed.result ?? parsed.output ?? parsed.content
      ),
      toolKind: inferCliToolKind(
        String(rawName),
        input,
        parsed.result ?? parsed.output ?? parsed.content
      ),
      status,
      detail:
        status === "completed" || status === "failed" || status === "cancelled"
          ? summarizeCliToolResultDetail(
              String(rawName),
              parsed.input ?? parsed.arguments ?? parsed.args,
              parsed.result ?? parsed.output ?? parsed.content
            ) ??
            summarizeUnknownForToolDetail(input)
          : summarizeUnknownForToolDetail(input),
      raw: parsed,
    });
    return;
  }
  if (type === "item.completed") {
    const item = parsed.item && typeof parsed.item === "object"
      ? (parsed.item as Record<string, unknown>)
      : null;
    const itemType = typeof item?.type === "string" ? item.type : "";
    const text = typeof item?.text === "string" ? item.text : "";
    if (itemType === "agent_message" && text) {
      void callbacks.appendAssistantText(text);
      return;
    }
    if (
      itemType &&
      SKIP_CLI_ITEM_TRACE_TYPES.has(itemType) &&
      text.trim() &&
      (itemType === "reasoning" || itemType === "thinking" || itemType === "redacted_thinking")
    ) {
      void callbacks.appendReasoningText(text, item);
      return;
    }
    if (item && itemType && itemType !== "agent_message" && !SKIP_CLI_ITEM_TRACE_TYPES.has(itemType)) {
      const ir = item;
      const itemId =
        extractToolCallIdFromNestedItem(ir) ||
        (typeof ir.item_id === "string" && ir.item_id) ||
        stableIdForCompletedToolItem(ir);
      const title = itemType.replace(/_/g, " ");
      void callbacks.appendToolCallUpdate({
        toolCallId: itemId,
        title,
        toolKind: inferCliToolKind(title, ir.arguments, ir.output ?? ir.result ?? ir.command),
        status: "completed",
        detail: text.trim() || summarizeUnknownForToolDetail(ir),
        raw: ir,
      });
    }
    return;
  }
  if (
    type === "tool_result" ||
    type === "tool_output" ||
    type === "function_call_output"
  ) {
    const out =
      parsed.content ?? parsed.output ?? parsed.result ?? parsed.text ?? parsed.stdout;
    const rawName =
      (typeof parsed.name === "string" && parsed.name) ||
      (typeof parsed.tool_name === "string" && parsed.tool_name) ||
      type;
    const idInput = parsed.input ?? parsed.arguments ?? parsed.args ?? out;
    emitCliToolEvent(callbacks, {
      toolCallId: resolveCliToolCallId(String(rawName), idInput, parsed),
      title: buildCliToolDisplayTitle(
        String(rawName),
        parsed.input ?? parsed.arguments ?? parsed.args,
        out
      ),
      toolKind: inferCliToolKind(
        String(rawName),
        parsed.input ?? parsed.arguments ?? parsed.args,
        out
      ),
      status: normalizeCliToolEventStatus(parsed, "completed"),
      detail: summarizeCliToolResultDetail(
        String(rawName),
        parsed.input ?? parsed.arguments ?? parsed.args,
        out
      ),
      raw: parsed,
    });
    return;
  }
  if (type === "result") {
    const stopReason =
      typeof parsed.subtype === "string"
        ? parsed.subtype
        : typeof parsed.stop_reason === "string"
          ? parsed.stop_reason
          : undefined;
    callbacks.setStopReason(stopReason);
  }
}

function buildClaudeInvocation(input: {
  runtime: CliRuntimeSpec;
  workspaceRoot: string;
  prompt: string;
  configOptions: AgentConfigOption[];
}): CliInvocation {
  const model = currentValueFor(input.configOptions, "model") || "turbo";
  const effort = currentValueFor(input.configOptions, "effort") || "medium";
  return {
    command: input.runtime.command,
    args: [
      ...input.runtime.args,
      "-p",
      "--bare",
      "--output-format",
      "json",
      "--permission-mode",
      "plan",
      "--model",
      model,
      "--effort",
      effort,
      CLI_PROMPT_STDIN_ARG,
    ],
    env: input.runtime.env,
    cwd: input.workspaceRoot,
    stdinPrompt: input.prompt,
  };
}

function parseClaudeStdoutLine(line: string, callbacks: CliPromptCallbacks): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (type === "result") {
    const resultText = typeof parsed.result === "string" ? parsed.result : "";
    if (resultText) {
      void callbacks.appendAssistantText(resultText);
    }
    const stopReason =
      typeof parsed.stop_reason === "string"
        ? parsed.stop_reason
        : typeof parsed.subtype === "string"
          ? parsed.subtype
          : undefined;
    callbacks.setStopReason(stopReason);
  }
}

export function createCodexAdapterProvider(input: {
  backend: AgentBackendInfo;
  runtime: CliRuntimeSpec;
  configOptions: AgentConfigOption[];
  capabilities: AgentProviderCapabilities;
}): AgentProvider {
  const definition: CliAdapterDefinition = {
    backend: input.backend,
    runtime: input.runtime,
    capabilities: input.capabilities,
    initialConfigOptions: input.configOptions,
    buildInvocation: ({ workspaceRoot, prompt, configOptions }) =>
      buildCodexInvocation({ runtime: input.runtime, workspaceRoot, prompt, configOptions }),
    parseStdoutLine: parseCodexStdoutLine,
  };

  return {
    backend: input.backend,
    async startSession(callbacks) {
      const handle = new OneShotCliSessionHandle({
        backend: input.backend,
        callbacks,
        definition,
        configOptions: input.configOptions,
      });
      await handle.initialize();
      return handle;
    },
    async loadSession(callbacks) {
      const handle = new OneShotCliSessionHandle({
        backend: input.backend,
        callbacks,
        definition,
        configOptions: input.configOptions,
      });
      await handle.initialize();
      return handle;
    },
  };
}

export function createCursorAdapterProvider(input: {
  backend: AgentBackendInfo;
  runtime: CliRuntimeSpec;
  configOptions: AgentConfigOption[];
  capabilities: AgentProviderCapabilities;
}): AgentProvider {
  const definition: CliAdapterDefinition = {
    backend: input.backend,
    runtime: input.runtime,
    capabilities: input.capabilities,
    initialConfigOptions: input.configOptions,
    buildInvocation: ({ workspaceRoot, prompt, configOptions }) =>
      buildCursorInvocation({ runtime: input.runtime, workspaceRoot, prompt, configOptions }),
    parseStdoutLine: parseCursorStdoutLine,
  };

  return {
    backend: input.backend,
    async startSession(callbacks) {
      const handle = new OneShotCliSessionHandle({
        backend: input.backend,
        callbacks,
        definition,
        configOptions: input.configOptions,
      });
      await handle.initialize();
      return handle;
    },
    async loadSession(callbacks) {
      const handle = new OneShotCliSessionHandle({
        backend: input.backend,
        callbacks,
        definition,
        configOptions: input.configOptions,
      });
      await handle.initialize();
      return handle;
    },
  };
}

export function createClaudeAdapterProvider(input: {
  backend: AgentBackendInfo;
  runtime: CliRuntimeSpec;
  configOptions: AgentConfigOption[];
  capabilities: AgentProviderCapabilities;
}): AgentProvider {
  const definition: CliAdapterDefinition = {
    backend: input.backend,
    runtime: input.runtime,
    capabilities: input.capabilities,
    initialConfigOptions: input.configOptions,
    buildInvocation: ({ workspaceRoot, prompt, configOptions }) =>
      buildClaudeInvocation({
        runtime: input.runtime,
        workspaceRoot,
        prompt,
        configOptions,
      }),
    parseStdoutLine: parseClaudeStdoutLine,
  };

  return {
    backend: input.backend,
    async startSession(callbacks) {
      const handle = new OneShotCliSessionHandle({
        backend: input.backend,
        callbacks,
        definition,
        configOptions: input.configOptions,
      });
      await handle.initialize();
      return handle;
    },
    async loadSession(callbacks) {
      const handle = new OneShotCliSessionHandle({
        backend: input.backend,
        callbacks,
        definition,
        configOptions: input.configOptions,
      });
      await handle.initialize();
      return handle;
    },
  };
}
