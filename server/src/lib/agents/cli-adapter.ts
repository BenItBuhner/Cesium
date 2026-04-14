import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  findPrimaryModelConfigOption,
  findPrimaryModeConfigOption,
} from "./config-option-utils.js";
import { spawnSafeEnv } from "./spawn-env.js";
import { writeAgentBackendConfigCache } from "./provider-cache-store.js";
import { extractToolEditPreview } from "./tool-edit-preview.js";
import { formatRejectedToolDetail } from "./tool-rejection-utils.js";
import {
  formatDeleteToolTitle,
  formatFindToolTitle,
  formatGrepToolTitle,
  formatReadToolTitle,
  formatTerminalCommandTitle,
  formatUpdateToolTitle,
  formatWebSearchTitle,
  truncateGenericToolTitle,
} from "./tool-display-labels.js";
import type {
  AgentBackendInfo,
  AgentConfigOption,
  AgentConversationSnapshot,
  AgentToolEditPreview,
  AgentToolLocation,
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
  locations?: AgentToolLocation[];
  editPreview?: AgentToolEditPreview;
  rawName?: string;
  input?: unknown;
  result?: unknown;
  raw?: unknown;
};

type CliPromptCallbacks = {
  workspaceRoot?: string;
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
    locations?: AgentToolLocation[];
    editPreview?: AgentToolEditPreview;
    raw?: unknown;
  }) => Promise<void>;
};

const codexKnownFileContentByCallbacks = new WeakMap<CliPromptCallbacks, Map<string, string>>();

function getCodexKnownFileContentMap(callbacks: CliPromptCallbacks): Map<string, string> {
  const existing = codexKnownFileContentByCallbacks.get(callbacks);
  if (existing) {
    return existing;
  }
  const created = new Map<string, string>();
  codexKnownFileContentByCallbacks.set(callbacks, created);
  return created;
}

function readCodexPreviewFileContent(filePath: string): string | undefined {
  try {
    if (!existsSync(filePath)) {
      return undefined;
    }
    const text = readFileSync(filePath, "utf8");
    return text.length <= 120_000 ? text : undefined;
  } catch {
    return undefined;
  }
}

function codexChangeKinds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) =>
      entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).kind === "string"
        ? ((entry as Record<string, unknown>).kind as string).toLowerCase()
        : ""
    )
    .filter(Boolean);
}

function trackCodexFileStateBeforeChange(
  callbacks: CliPromptCallbacks,
  item: Record<string, unknown>
): void {
  const path = firstPathFromCodexChanges(item.changes);
  if (!path) {
    return;
  }
  const current = readCodexPreviewFileContent(path);
  if (current == null) {
    return;
  }
  getCodexKnownFileContentMap(callbacks).set(path, current);
}

function enrichCodexFileChangeResult(
  callbacks: CliPromptCallbacks,
  item: Record<string, unknown>,
  normalized: { rawName: string; input: unknown; result: unknown }
): { rawName: string; input: unknown; result: unknown } {
  if (item.type !== "file_change") {
    return normalized;
  }
  const path = firstPathFromCodexChanges(item.changes);
  if (!path) {
    return normalized;
  }
  const kinds = codexChangeKinds(item.changes);
  const fileState = getCodexKnownFileContentMap(callbacks);
  const before = fileState.get(path);
  const after = readCodexPreviewFileContent(path);

  if (after != null) {
    fileState.set(path, after);
  } else {
    fileState.delete(path);
  }

  const resultRecord: Record<string, unknown> = {
    path,
    changes: item.changes,
    status: item.status,
  };

  if (before != null && after != null && before !== after) {
    resultRecord.beforeFullFileContent = before;
    resultRecord.afterFullFileContent = after;
    return { ...normalized, result: resultRecord };
  }
  if (after != null && kinds.every((kind) => kind === "add" || kind === "create")) {
    resultRecord.beforeFullFileContent = "";
    resultRecord.afterFullFileContent = after;
    return { ...normalized, result: resultRecord };
  }
  if (before != null && after == null && kinds.every((kind) => kind === "delete" || kind === "remove")) {
    resultRecord.beforeFullFileContent = before;
    resultRecord.afterFullFileContent = "";
    return { ...normalized, result: resultRecord };
  }
  return { ...normalized, result: resultRecord };
}

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

      const promptCallbacks: CliPromptCallbacks = {
        workspaceRoot: this.callbacks.workspace.root,
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
              locations: payload.locations,
              editPreview: payload.editPreview,
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
              locations: payload.locations,
              editPreview: payload.editPreview,
              raw: payload.raw,
            },
          ]);
        },
      };

      const exitCode = await spawnCliPrompt(
        this.definition.buildInvocation({
          workspaceRoot: this.callbacks.workspace.root,
          prompt,
          configOptions: this.configOptions,
        }),
        (line) => {
          this.definition.parseStdoutLine(line, promptCallbacks);
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
    "file_path",
    "filePath",
    "filepath",
    "relativePath",
    "targetPath",
    "target_path",
    "from",
    "to",
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

function firstPathFromCodexChanges(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const path = firstPathFromToolArgs(record);
    if (path) {
      return path;
    }
  }
  return undefined;
}

function inferCodexFileChangeRawName(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    return "write_file";
  }
  const kinds = value
    .map((entry) =>
      entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).kind === "string"
        ? ((entry as Record<string, unknown>).kind as string).toLowerCase()
        : ""
    )
    .filter(Boolean);
  if (kinds.length > 0 && kinds.every((kind) => kind === "delete" || kind === "remove")) {
    return "delete_file";
  }
  return "write_file";
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
    return formatReadToolTitle(path);
  }
  if (kind === "grep") {
    return formatGrepToolTitle(pattern);
  }
  if (kind === "search_web") {
    return formatWebSearchTitle(pattern);
  }
  if (kind === "search") {
    return formatFindToolTitle(pattern);
  }
  if (kind === "delete") {
    return formatDeleteToolTitle(path, "Delete file");
  }
  if (kind === "edit") {
    return formatUpdateToolTitle(path, "Update file");
  }
  if (kind === "todo") {
    return "Update todo list";
  }
  if (kind === "task") {
    return "Task";
  }
  if (kind === "terminal") {
    return command ? formatTerminalCommandTitle(command) : "Run command";
  }
  return truncateGenericToolTitle(
    humanizeCliToolName(String(rawName)),
    "Tool call"
  );
}

function countLinesInText(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function extractCliFileCountFromResult(value: unknown): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    const match = /\bfound\s+(\d+)\s+files?\b/i.exec(value);
    if (match) {
      return Number.parseInt(match[1] ?? "", 10);
    }
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
  if (n.includes("subagent") || n.includes("spawn agent") || n === "task") {
    return "task";
  }
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
  const normalizedStatus =
    record && typeof record.status === "string" ? normalizeStreamJsonToolStatus(record.status) : undefined;
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
  if (normalizedStatus === "failed") {
    if (kind === "terminal") {
      const failureOutput =
        (record &&
          (typeof record.stderr === "string"
            ? record.stderr
            : typeof record.aggregated_output === "string"
              ? record.aggregated_output
              : undefined)) ??
        (typeof payload === "string" ? payload : undefined);
      const trimmed = failureOutput?.trim();
      if (trimmed) {
        return trimmed.length > 400 ? `${trimmed.slice(0, 397)}...` : trimmed;
      }
    }
    if (kind === "edit") {
      const path =
        (payloadRecord && typeof payloadRecord.path === "string" && payloadRecord.path) ||
        (inputRecord ? firstPathFromToolArgs(inputRecord) : undefined);
      return path ? `Failed to update ${path}` : "File update failed";
    }
    if (kind === "task") {
      return "Subagent task failed";
    }
  }
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
  if (kind === "search_web") {
    return undefined;
  }
  if (kind === "todo") {
    const todoCount = Array.isArray(inputRecord?.todos) ? inputRecord.todos.length : undefined;
    return todoCount != null ? `${pluralizeToolCount(todoCount, "item")} updated` : undefined;
  }
  if (kind === "terminal") {
    const output =
      (payloadRecord &&
        (typeof payloadRecord.aggregated_output === "string"
          ? payloadRecord.aggregated_output
          : typeof payloadRecord.stdout === "string"
            ? payloadRecord.stdout
            : typeof payloadRecord.stderr === "string"
              ? payloadRecord.stderr
              : undefined)) ??
      (typeof payload === "string" ? payload : undefined);
    const trimmed = output?.trim();
    if (trimmed) {
      return trimmed.length > 400 ? `${trimmed.slice(0, 397)}...` : trimmed;
    }
    if (typeof payloadRecord?.exit_code === "number") {
      return payloadRecord.exit_code === 0 ? "Command succeeded" : `Exit code ${payloadRecord.exit_code}`;
    }
    return undefined;
  }
  if (kind === "task") {
    const prompt =
      (payloadRecord && typeof payloadRecord.prompt === "string" ? payloadRecord.prompt : undefined) ||
      (inputRecord && typeof inputRecord.prompt === "string" ? inputRecord.prompt : undefined);
    return prompt ? summarizeUnknownForToolDetail(prompt, 220) : undefined;
  }
  return summarizeUnknownForToolDetail(payload);
}

function emitCliToolEvent(
  callbacks: CliPromptCallbacks,
  payload: CliToolEmitPayload
): void {
  const inputRecord = tryParseToolArgumentsRecord(payload.input);
  const resultRecord = tryParseToolArgumentsRecord(payload.result);
  const path =
    (inputRecord ? firstPathFromToolArgs(inputRecord) : undefined) ??
    (resultRecord ? firstPathFromToolArgs(resultRecord) : undefined);
  let editPreview =
    payload.editPreview ?? extractToolEditPreview(payload.input, payload.result, path);
  if (!editPreview && payload.toolKind === "edit") {
    const rawRecord = tryParseToolArgumentsRecord(payload.raw);
    if (rawRecord?.type === "file_change") {
      const filePath = firstPathFromCodexChanges(rawRecord.changes) ?? path;
      const current = filePath ? readCodexPreviewFileContent(filePath) : undefined;
      const previous = filePath ? getCodexKnownFileContentMap(callbacks).get(filePath) : undefined;
      const kinds = codexChangeKinds(rawRecord.changes);
      if (filePath) {
        if (current != null) {
          getCodexKnownFileContentMap(callbacks).set(filePath, current);
        }
        const syntheticResult: Record<string, unknown> = {
          path: filePath,
          changes: rawRecord.changes,
          status: rawRecord.status,
        };
        if (previous != null && current != null && previous !== current) {
          syntheticResult.beforeFullFileContent = previous;
          syntheticResult.afterFullFileContent = current;
        } else if (current != null && kinds.every((kind) => kind === "add" || kind === "create")) {
          syntheticResult.beforeFullFileContent = "";
          syntheticResult.afterFullFileContent = current;
        } else if (previous != null && current == null && kinds.every((kind) => kind === "delete" || kind === "remove")) {
          syntheticResult.beforeFullFileContent = previous;
          syntheticResult.afterFullFileContent = "";
        }
        editPreview = extractToolEditPreview(payload.input, syntheticResult, filePath);
      }
    }
  }
  const locations =
    payload.locations ??
    ((editPreview?.path ?? path)
      ? [
          {
            path: editPreview?.path ?? path!,
          },
        ]
      : undefined);
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
      locations,
      editPreview,
      raw: payload.raw,
    });
    return;
  }
  void callbacks.appendToolCall({
    ...payload,
    locations,
    editPreview,
  });
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
        rawName: String(rawName),
        input,
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
        rawName: String(rawName),
        input: record.input ?? record.arguments ?? record.args,
        result: out,
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
      rawName: String(rawName),
      input,
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
  const model = currentValueFor(input.configOptions, "model") || "gpt-5.4-mini";
  const effort =
    currentValueFor(input.configOptions, "model_reasoning_effort") ||
    currentValueFor(input.configOptions, "effort") ||
    "low";
  const permission = currentValueFor(input.configOptions, "permission") || "workspace-write";
  const webSearch = currentValueFor(input.configOptions, "web_search") || "cached";
  const args = [
    ...input.runtime.args,
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-C",
    input.workspaceRoot,
  ];
  if (model && model !== "__default__") {
    args.push("--model", model);
  }
  if (effort) {
    args.push("-c", `model_reasoning_effort="${effort}"`);
  }
  if (webSearch) {
    args.push("-c", `web_search="${webSearch}"`);
  }
  if (permission === "bypassPermissions") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (permission === "workspace-write") {
    args.push("--full-auto");
  } else {
    args.push("--sandbox", "read-only");
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

function normalizeCodexItemToolShape(item: Record<string, unknown>): {
  rawName: string;
  input: unknown;
  result: unknown;
} {
  const itemType = typeof item.type === "string" ? item.type : "tool";
  if (itemType === "command_execution") {
    return {
      rawName: "bash",
      input: { command: typeof item.command === "string" ? item.command : undefined },
      result: {
        aggregated_output:
          typeof item.aggregated_output === "string" ? item.aggregated_output : undefined,
        exit_code: typeof item.exit_code === "number" ? item.exit_code : undefined,
        status: typeof item.status === "string" ? item.status : undefined,
      },
    };
  }
  if (itemType === "web_search") {
    const action = item.action && typeof item.action === "object"
      ? (item.action as Record<string, unknown>)
      : undefined;
    const query =
      (typeof item.query === "string" && item.query.trim()) ||
      (typeof action?.query === "string" && action.query.trim()) ||
      (Array.isArray(action?.queries)
        ? action.queries.find((value) => typeof value === "string" && value.trim())
        : undefined);
    return {
      rawName: "web_search",
      input: { query },
      result: { query, action },
    };
  }
  if (itemType === "file_change") {
    const path = firstPathFromCodexChanges(item.changes);
    return {
      rawName: inferCodexFileChangeRawName(item.changes),
      input: { path, changes: item.changes },
      result: { path, changes: item.changes, status: item.status },
    };
  }
  if (itemType === "collab_tool_call") {
    return {
      rawName: "task",
      input: {
        prompt: typeof item.prompt === "string" ? item.prompt : undefined,
        receiver_thread_ids: item.receiver_thread_ids,
        agents_states: item.agents_states,
        tool: typeof item.tool === "string" ? item.tool : undefined,
      },
      result: {
        prompt: typeof item.prompt === "string" ? item.prompt : undefined,
        receiver_thread_ids: item.receiver_thread_ids,
        agents_states: item.agents_states,
        tool: typeof item.tool === "string" ? item.tool : undefined,
        status: item.status,
      },
    };
  }
  return {
    rawName: itemType,
    input: item.arguments ?? item.input ?? item.command,
    result: item.output ?? item.result ?? item.command,
  };
}

export function parseCodexStdoutLine(line: string, callbacks: CliPromptCallbacks): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (type === "item.started") {
    const item = parsed.item && typeof parsed.item === "object"
      ? (parsed.item as Record<string, unknown>)
      : null;
    const itemType = typeof item?.type === "string" ? item.type : "";
    const text = typeof item?.text === "string" ? item.text : "";
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
      if (itemType === "file_change") {
        trackCodexFileStateBeforeChange(callbacks, ir);
      }
      const normalized = normalizeCodexItemToolShape(ir);
      const startedDetail =
        text.trim() ||
        summarizeCliToolResultDetail(String(normalized.rawName), normalized.input, normalized.result);
      emitCliToolEvent(callbacks, {
        toolCallId:
          extractToolCallIdFromNestedItem(ir) ||
          (typeof ir.item_id === "string" && ir.item_id) ||
          stableCliToolCallId(String(normalized.rawName), normalized.input),
        title: buildCliToolDisplayTitle(String(normalized.rawName), normalized.input, normalized.result),
        toolKind: inferCliToolKind(String(normalized.rawName), normalized.input, normalized.result),
        status: normalizeCliToolEventStatus(ir, "pending"),
        detail: startedDetail,
        rawName: String(normalized.rawName),
        input: normalized.input,
        result: normalized.result,
        raw: ir,
      });
    }
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
    if (itemType && SKIP_CLI_ITEM_TRACE_TYPES.has(itemType)) {
      return;
    }
    if (item && itemType && itemType !== "agent_message") {
      const ir = item;
      const emitCompletedItem = async () => {
        let normalized =
          itemType === "file_change"
            ? enrichCodexFileChangeResult(callbacks, ir, normalizeCodexItemToolShape(ir))
            : normalizeCodexItemToolShape(ir);
        if (itemType === "file_change" && normalizeCliToolEventStatus(ir, "completed") === "completed") {
          const path = firstPathFromCodexChanges(ir.changes);
          for (let attempt = 0; attempt < 40; attempt += 1) {
            const preview = extractToolEditPreview(normalized.input, normalized.result, path);
            if (preview) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
            normalized = enrichCodexFileChangeResult(callbacks, ir, normalizeCodexItemToolShape(ir));
          }
        }
        const normalizedKind = inferCliToolKind(String(normalized.rawName), normalized.input, normalized.result);
        const completedDetail =
          text.trim() ||
          summarizeCliToolResultDetail(String(normalized.rawName), normalized.input, normalized.result) ||
          (normalizedKind === "task" || normalizedKind === "search_web"
            ? undefined
            : summarizeUnknownForToolDetail(normalized.result));
        emitCliToolEvent(callbacks, {
          toolCallId:
            extractToolCallIdFromNestedItem(ir) ||
            (typeof ir.item_id === "string" && ir.item_id) ||
            stableIdForCompletedToolItem(ir),
          title: buildCliToolDisplayTitle(String(normalized.rawName), normalized.input, normalized.result),
          toolKind: normalizedKind,
          status: normalizeCliToolEventStatus(ir, "completed"),
          detail: completedDetail,
          rawName: String(normalized.rawName),
          input: normalized.input,
          result: normalized.result,
          raw: ir,
        });
      };
      if (itemType === "file_change") {
        void emitCompletedItem();
        return;
      }
      void emitCompletedItem();
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
          rawName: entry.rawName,
          input: entry.input,
          result: entry.result,
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
      rawName: String(rawName),
      input,
      result: parsed.result ?? parsed.output ?? parsed.content,
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
      rawName: String(rawName),
      input: parsed.input ?? parsed.arguments ?? parsed.args,
      result: out,
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
  const model = currentValueFor(input.configOptions, "model") || "glm-5.1";
  const effort = currentValueFor(input.configOptions, "effort") || "medium";
  const permission = currentValueFor(input.configOptions, "permission") || "plan";
  return {
    command: input.runtime.command,
    args: [
      ...input.runtime.args,
      "-p",
      "--verbose",
      "--bare",
      "--output-format",
      "stream-json",
      "--permission-mode",
      permission,
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

type ClaudeToolState = {
  rawName: string;
  input: unknown;
};

const claudeToolStateByCallbacks = new WeakMap<
  CliPromptCallbacks,
  Map<string, ClaudeToolState>
>();

function getClaudeToolStateMap(callbacks: CliPromptCallbacks): Map<string, ClaudeToolState> {
  const existing = claudeToolStateByCallbacks.get(callbacks);
  if (existing) {
    return existing;
  }
  const created = new Map<string, ClaudeToolState>();
  claudeToolStateByCallbacks.set(callbacks, created);
  return created;
}

function extractClaudeContentBlocks(message: Record<string, unknown>): Record<string, unknown>[] {
  const content = message.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(
    (entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object")
  );
}

function summarizeClaudeToolResultContent(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => {
        if (typeof entry === "string") {
          return entry.trim();
        }
        if (
          entry &&
          typeof entry === "object" &&
          typeof (entry as Record<string, unknown>).text === "string"
        ) {
          return ((entry as Record<string, unknown>).text as string).trim();
        }
        return "";
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }
  return undefined;
}

function buildClaudeToolRaw(input: {
  parsed: Record<string, unknown>;
  toolCallId: string;
  rawName: string;
  toolInput: unknown;
  toolResult?: unknown;
  isError?: boolean;
}): Record<string, unknown> {
  const message =
    input.parsed.message && typeof input.parsed.message === "object"
      ? (input.parsed.message as Record<string, unknown>)
      : undefined;
  return {
    type: input.parsed.type,
    subtype: input.parsed.subtype,
    session_id:
      typeof input.parsed.session_id === "string" ? input.parsed.session_id : undefined,
    parent_tool_use_id:
      typeof input.parsed.parent_tool_use_id === "string"
        ? input.parsed.parent_tool_use_id
        : undefined,
    messageId: typeof message?.id === "string" ? message.id : undefined,
    toolCallId: input.toolCallId,
    name: input.rawName,
    input: input.toolInput,
    result: input.toolResult,
    is_error: input.isError,
    tool_use_result:
      typeof input.parsed.tool_use_result === "string"
        ? input.parsed.tool_use_result
        : undefined,
  };
}

export function parseClaudeStdoutLine(line: string, callbacks: CliPromptCallbacks): void {
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
  const toolState = getClaudeToolStateMap(callbacks);

  if (type === "assistant" && message && role === "assistant") {
    for (const block of extractClaudeContentBlocks(message)) {
      const blockType = typeof block.type === "string" ? block.type : "";
      if (blockType === "text" && typeof block.text === "string" && block.text.trim()) {
        void callbacks.appendAssistantText(block.text);
        continue;
      }
      if (
        (blockType === "thinking" || blockType === "reasoning" || blockType === "redacted_thinking") &&
        typeof block.text === "string" &&
        block.text.trim()
      ) {
        void callbacks.appendReasoningText(block.text, block);
        continue;
      }
      if (blockType !== "tool_use") {
        continue;
      }
      const rawName = typeof block.name === "string" && block.name.trim() ? block.name.trim() : "tool";
      const toolInput = block.input;
      const toolCallId =
        (typeof block.id === "string" && block.id.trim()) ||
        resolveCliToolCallId(rawName, toolInput, block, message, parsed);
      toolState.set(toolCallId, { rawName, input: toolInput });
      emitCliToolEvent(callbacks, {
        toolCallId,
        title: buildCliToolDisplayTitle(rawName, toolInput),
        toolKind: inferCliToolKind(rawName, toolInput),
        status: normalizeCliToolEventStatus(block, "pending"),
        detail: summarizeUnknownForToolDetail(toolInput),
        rawName,
        input: toolInput,
        raw: buildClaudeToolRaw({
          parsed,
          toolCallId,
          rawName,
          toolInput,
        }),
      });
    }
    return;
  }

  if (type === "user" && message && role === "user") {
    for (const block of extractClaudeContentBlocks(message)) {
      if (block.type !== "tool_result") {
        continue;
      }
      const toolCallId =
        (typeof block.tool_use_id === "string" && block.tool_use_id.trim()) ||
        (typeof parsed.parent_tool_use_id === "string" && parsed.parent_tool_use_id.trim()) ||
        resolveCliToolCallId("tool_result", block.content, block, parsed);
      const state = toolState.get(toolCallId);
      const rawName = state?.rawName ?? "tool_result";
      const toolInput = state?.input;
      const toolResult = parsed.tool_use_result ?? block.content;
      const isError = block.is_error === true;
      emitCliToolEvent(callbacks, {
        toolCallId,
        title: buildCliToolDisplayTitle(rawName, toolInput, toolResult),
        toolKind: inferCliToolKind(rawName, toolInput, toolResult),
        status: isError ? "failed" : normalizeCliToolEventStatus(block, "completed"),
        detail:
          (isError ? summarizeClaudeToolResultContent(toolResult) : undefined) ??
          summarizeCliToolResultDetail(rawName, toolInput, toolResult) ??
          summarizeClaudeToolResultContent(toolResult),
        rawName,
        input: toolInput,
        result: toolResult,
        raw: buildClaudeToolRaw({
          parsed,
          toolCallId,
          rawName,
          toolInput,
          toolResult,
          isError,
        }),
      });
      toolState.delete(toolCallId);
    }
    return;
  }

  if (type === "system") {
    const subtype = typeof parsed.subtype === "string" ? parsed.subtype : "";
    const toolCallId = typeof parsed.tool_use_id === "string" ? parsed.tool_use_id : "";
    if (
      toolCallId &&
      (subtype === "task_started" || subtype === "task_progress")
    ) {
      const state = toolState.get(toolCallId);
      if (state) {
        void callbacks.appendToolCallUpdate({
          toolCallId,
          title: buildCliToolDisplayTitle(state.rawName, state.input),
          toolKind: inferCliToolKind(state.rawName, state.input),
          status: "in_progress",
          detail:
            (typeof parsed.description === "string" && parsed.description.trim()) ||
            (typeof parsed.last_tool_name === "string" && parsed.last_tool_name.trim()) ||
            undefined,
          raw: buildClaudeToolRaw({
            parsed,
            toolCallId,
            rawName: state.rawName,
            toolInput: state.input,
          }),
        });
      }
      return;
    }
  }

  if (type === "result") {
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
