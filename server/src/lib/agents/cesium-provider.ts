import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import {
  buildCesiumOrchestrationSystemPrompt,
  buildCesiumSystemPrompt,
  formatGitSummaryForPrompt,
  type BuildCesiumSystemPromptInput,
  type McpServerSummary,
} from "@cesium/core/mcp";
import { getGitWorkspaceStatus } from "../git-worktrees.js";
import {
  createCesiumAgentConfigOptions,
  getCesiumAgentSettings,
  resolveCesiumAuth,
  type CesiumProviderKind,
} from "../cesium-agent-settings.js";
import {
  getGlobalSettings,
  saveRememberedAgentPermissionRule,
} from "../global-settings-store.js";
import {
  callMcpTool,
  refreshWorkspaceMcpMirror,
} from "../mcp/connection-manager.js";
import { getMcpSummariesForPrompt } from "../mcp/server-store.js";
import { BROWSER_MCP_SERVER_ID } from "../mcp/builtin-browser-tools.js";
import { extractToolEditPreview } from "./tool-edit-preview.js";
import {
  addOrchestrationComment,
  createOrchestrationIssue,
  deleteOrchestrationIssue,
  findOrchestrationAssignmentForConversation,
  readOrchestrationBoardSnapshot,
  resolveOrCreateOrchestrationBoardForHeadConversation,
  upsertOrchestrationAssignment,
  upsertOrchestrationIssue,
} from "../orchestration/store.js";
import type {
  OrchestrationAssignmentRecord,
  OrchestrationAssignmentPermissionPolicy,
  OrchestrationAssignmentStatus,
  OrchestrationBoardSnapshot,
  OrchestrationColumnId,
  OrchestrationIssuePriority,
  OrchestrationPermissionDecision,
} from "../orchestration/types.js";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConfigOption,
  AgentConversationStatus,
  AgentEventInput,
  AgentPermissionOption,
  AgentProvider,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
  AgentStoredEvent,
  AgentToolCallStatus,
} from "./types.js";

type CesiumRole = "system" | "user" | "assistant" | "tool";

type CesiumHistoryToolCall = {
  id: string;
  name: string;
  arguments: string;
};

type CesiumHistoryMessage = {
  role: CesiumRole;
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: CesiumHistoryToolCall[];
};

type PendingHistoryToolCall = CesiumHistoryToolCall & {
  result?: string;
};

type CesiumToolRequest = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

type CesiumAdapterResult = {
  text: string;
  reasoning?: string;
  toolRequests: CesiumToolRequest[];
  raw?: unknown;
};

type ActivePermission = {
  resolve: (value: "allow" | "reject") => void;
  reject: (error: Error) => void;
  toolKey: string;
  toolLabel: string;
};

type ActiveQuestion = {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  prompt: string;
  options: Array<{ id: string; label: string }>;
  questions: CesiumQuestionStep[];
  allowMultiple: boolean;
  raw: Record<string, unknown>;
};

type CesiumQuestionStep = {
  id: string;
  prompt: string;
  options: Array<{ id: string; label: string }>;
  allowMultiple?: boolean;
};

type TerminalRun = {
  id: string;
  process: ChildProcessWithoutNullStreams;
  output: string;
  startedAt: number;
  completedAt?: number;
  exitCode?: number | null;
};

const CESIUM_SYSTEM_PROMPT = buildCesiumSystemPrompt();

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
/** Slow third-party hosts (Cerebras, Nvidia NIM, etc.) can take a long time on large tool prompts. */
const CESIUM_RESPONSE_WARNING_MS = 10 * 60 * 1000;
const HISTORY_TURN_LIMIT = 250;
const HISTORY_EVENT_LIMIT = 20_000;
const LARGE_FILE_LINE_LIMIT = 3500;
const MAX_READ_LINES = 2000;
const MAX_GREP_RESULTS = 5000;
const DEFAULT_GREP_RESULTS = 100;
const TERMINAL_OUTPUT_CAP = 80_000;
const ORCHESTRATION_WAIT_HEARTBEAT_MS = 15_000;
const ORCHESTRATION_WAIT_DEFAULT_MS = 30_000;
const ORCHESTRATION_ASSIGNMENT_TERMINAL_STATUSES: OrchestrationAssignmentStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

const PERMISSION_OPTIONS: AgentPermissionOption[] = [
  { optionId: "allow_once", name: "Allow", kind: "allow_once" },
  { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
  { optionId: "reject_always", name: "Always reject", kind: "reject_always" },
];

const CESIUM_TOOLS = [
  {
    name: "read_file",
    description: "Read all or part of a workspace file. Use offset and limit for large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "grep",
    description: "Search workspace files by JavaScript regular expression.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        context: { type: "number" },
        maxResults: { type: "number" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description: "Replace one exact string in a file. Returns a precise error if the match is missing or duplicated.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
      },
      required: ["path", "oldString", "newString"],
      additionalProperties: false,
    },
  },
  {
    name: "terminal",
    description: "Run a workspace command. waitUntil can be complete, background, or pattern.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        waitUntil: { type: "string", enum: ["complete", "background", "pattern"] },
        pattern: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "todo",
    description: "Replace or patch the current todo list.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "replace", "patch"] },
        items: { type: "array" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "ask_question",
    description: "Ask the user a structured question with selectable options.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        options: { type: "array" },
        allowMultiple: { type: "boolean" },
        allow_multiple: { type: "boolean" },
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              prompt: { type: "string" },
              title: { type: "string" },
              options: { type: "array" },
              allowMultiple: { type: "boolean" },
              allow_multiple: { type: "boolean" },
            },
            required: ["options"],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "subagent",
    description: "Start a child Cesium subagent. The first pass runs it as a bounded child task and stores a transcript card.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        instructions: { type: "string" },
        modelId: { type: "string" },
        wait: { type: "boolean" },
        allowedTools: { type: "array" },
      },
      required: ["instructions"],
      additionalProperties: false,
    },
  },
  {
    name: "read_subagent_transcript",
    description: "Read transcript content from a subagent card by id.",
    parameters: {
      type: "object",
      properties: {
        subagentId: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["subagentId"],
      additionalProperties: false,
    },
  },
  {
    name: "search_history",
    description: "Search older or compressed conversation history.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_history_page",
    description: "Read a bounded page of recent normalized history.",
    parameters: {
      type: "object",
      properties: {
        beforeSeq: { type: "number" },
        limitTurns: { type: "number" },
      },
      required: ["beforeSeq"],
      additionalProperties: false,
    },
  },
  {
    name: "call_mcp_tool",
    description:
      "Invoke a tool on a connected MCP server. Read mcp-servers/<serverId>/tools/ first.",
    parameters: {
      type: "object",
      properties: {
        serverId: { type: "string" },
        toolName: { type: "string" },
        arguments: { type: "object" },
      },
      required: ["serverId", "toolName"],
      additionalProperties: false,
    },
  },
  {
    name: "refresh_mcp_servers",
    description: "Reconnect MCP servers and regenerate the mcp-servers/ mirror.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "orchestration_board_snapshot",
    description: "Read the current Orchestration Mode board snapshot.",
    parameters: {
      type: "object",
      properties: {
        boardId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "orchestration_create_issue",
    description: "Create a kanban issue with optional description and acceptance criteria.",
    parameters: {
      type: "object",
      properties: {
        boardId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        columnId: {
          type: "string",
          enum: ["backlog", "ready", "in_progress", "review", "blocked", "done"],
        },
        priority: {
          type: "string",
          enum: ["none", "low", "medium", "high", "urgent"],
        },
        acceptanceCriteria: { type: "array", items: { type: "string" } },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "orchestration_update_issue",
    description: "Update or move an existing kanban issue.",
    parameters: {
      type: "object",
      properties: {
        boardId: { type: "string" },
        issueId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        columnId: {
          type: "string",
          enum: ["backlog", "ready", "in_progress", "review", "blocked", "done"],
        },
        priority: {
          type: "string",
          enum: ["none", "low", "medium", "high", "urgent"],
        },
        acceptanceCriteria: { type: "array", items: { type: "string" } },
        blockedReason: { type: "string" },
      },
      required: ["issueId"],
      additionalProperties: false,
    },
  },
  {
    name: "orchestration_comment_issue",
    description: "Add a board comment or nudge to an issue.",
    parameters: {
      type: "object",
      properties: {
        boardId: { type: "string" },
        issueId: { type: "string" },
        message: { type: "string" },
      },
      required: ["issueId", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "orchestration_delete_issue",
    description: "Delete a kanban issue and cancel any child agents assigned to it.",
    parameters: {
      type: "object",
      properties: {
        boardId: { type: "string" },
        issueId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["issueId"],
      additionalProperties: false,
    },
  },
  {
    name: "orchestration_assign_agent",
    description: "Start a durable child agent conversation for an issue and assign it on the board.",
    parameters: {
      type: "object",
      properties: {
        boardId: { type: "string" },
        issueId: { type: "string" },
        instructions: { type: "string" },
        title: { type: "string" },
        backendId: { type: "string" },
        modelId: { type: "string" },
        role: { type: "string" },
        permissions: {
          type: "object",
          properties: {
            editFile: { type: "string", enum: ["allow", "ask", "deny"] },
            terminal: { type: "string", enum: ["allow", "ask", "deny"] },
            mcpCall: { type: "string", enum: ["allow", "ask", "deny"] },
          },
          additionalProperties: false,
        },
      },
      required: ["issueId", "instructions"],
      additionalProperties: false,
    },
  },
  {
    name: "orchestration_update_agent_permissions",
    description:
      "Update granular permission policy for an existing child agent assignment.",
    parameters: {
      type: "object",
      properties: {
        boardId: { type: "string" },
        assignmentId: { type: "string" },
        conversationId: { type: "string" },
        permissions: {
          type: "object",
          properties: {
            editFile: { type: "string", enum: ["allow", "ask", "deny"] },
            terminal: { type: "string", enum: ["allow", "ask", "deny"] },
            mcpCall: { type: "string", enum: ["allow", "ask", "deny"] },
          },
          additionalProperties: false,
        },
      },
      required: ["permissions"],
      additionalProperties: false,
    },
  },
  {
    name: "orchestration_control_agent",
    description:
      "Pause, resume, stop, or steer an existing child agent assignment from the board.",
    parameters: {
      type: "object",
      properties: {
        boardId: { type: "string" },
        assignmentId: { type: "string" },
        conversationId: { type: "string" },
        action: {
          type: "string",
          enum: ["pause", "resume", "stop", "steer"],
        },
        instructions: { type: "string" },
        reason: { type: "string" },
        resumeAfterSteer: { type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "orchestration_wait",
    description: "Wait for a specific board, issue, or child-agent condition instead of spinning.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string" },
        timeoutMs: { type: "number" },
        pollMs: { type: "number" },
        waitFor: {
          type: "string",
          enum: [
            "board_update",
            "issue_update",
            "issue_comment",
            "issue_done",
            "assignment_update",
            "assignment_status",
            "assignment_finished",
            "any_assignment_finished",
            "all_issue_assignments_finished",
          ],
        },
        issueId: { type: "string" },
        assignmentId: { type: "string" },
        conversationId: { type: "string" },
        statuses: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "assigned",
              "running",
              "waiting",
              "blocked",
              "reviewing",
              "completed",
              "failed",
              "cancelled",
            ],
          },
        },
      },
      additionalProperties: false,
    },
  },
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function asOrchestrationColumnId(value: unknown): OrchestrationColumnId | undefined {
  return value === "backlog" ||
    value === "ready" ||
    value === "in_progress" ||
    value === "review" ||
    value === "blocked" ||
    value === "done"
    ? value
    : undefined;
}

function asOrchestrationPriority(
  value: unknown
): OrchestrationIssuePriority | undefined {
  return value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "urgent"
    ? value
    : undefined;
}

function asOrchestrationPermissionDecision(
  value: unknown
): OrchestrationPermissionDecision | undefined {
  return value === "allow" || value === "ask" || value === "deny" ? value : undefined;
}

function asOrchestrationPermissionPolicy(
  value: unknown
): OrchestrationAssignmentPermissionPolicy {
  const record = asRecord(value);
  return {
    editFile: asOrchestrationPermissionDecision(record?.editFile) ?? "allow",
    terminal: asOrchestrationPermissionDecision(record?.terminal) ?? "allow",
    mcpCall: asOrchestrationPermissionDecision(record?.mcpCall) ?? "allow",
  };
}

type OrchestrationWaitFor =
  | "board_update"
  | "issue_update"
  | "issue_comment"
  | "issue_done"
  | "assignment_update"
  | "assignment_status"
  | "assignment_finished"
  | "any_assignment_finished"
  | "all_issue_assignments_finished";

function asOrchestrationAssignmentStatus(
  value: unknown
): OrchestrationAssignmentStatus | undefined {
  return value === "assigned" ||
    value === "running" ||
    value === "waiting" ||
    value === "blocked" ||
    value === "reviewing" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
    ? value
    : undefined;
}

function asOrchestrationAssignmentStatuses(
  value: unknown
): OrchestrationAssignmentStatus[] {
  const statuses = asStringArray(value)
    .map(asOrchestrationAssignmentStatus)
    .filter((status): status is OrchestrationAssignmentStatus => Boolean(status));
  return [...new Set(statuses)];
}

function asOrchestrationWaitFor(value: unknown): OrchestrationWaitFor {
  return value === "issue_update" ||
    value === "issue_comment" ||
    value === "issue_done" ||
    value === "assignment_update" ||
    value === "assignment_status" ||
    value === "assignment_finished" ||
    value === "any_assignment_finished" ||
    value === "all_issue_assignments_finished"
    ? value
    : "board_update";
}

type OrchestrationControlAction = "pause" | "resume" | "stop" | "steer";

function asOrchestrationControlAction(
  value: unknown
): OrchestrationControlAction | undefined {
  return value === "pause" || value === "resume" || value === "stop" || value === "steer"
    ? value
    : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, max = 40_000): string {
  return value.length > max ? `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]` : value;
}

function modelPart(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

function providerPart(modelId: string): string {
  return modelId.includes("/") ? modelId.split("/", 1)[0]! : "openai";
}

function optionValue(options: AgentConfigOption[], id: string, fallback: string): string {
  return options.find((option) => option.id === id)?.currentValue || fallback;
}

function resolvedModelId(
  conversationModelId: string | undefined,
  configOptions: AgentConfigOption[]
): string {
  const fromConversation = conversationModelId?.trim();
  if (fromConversation) {
    return fromConversation;
  }
  return optionValue(configOptions, "model", "openai/gpt-5.1");
}

function updateConfigOption(options: AgentConfigOption[], id: string, value: string): AgentConfigOption[] {
  return options.map((option) => option.id === id ? { ...option, currentValue: value } : option);
}

function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  const resolved = path.resolve(workspaceRoot, inputPath);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }
  return resolved;
}

function toolKind(name: string): string {
  switch (name) {
    case "read_file":
      return "read";
    case "edit_file":
      return "edit";
    case "terminal":
      return "terminal";
    case "grep":
      return "grep";
    case "todo":
      return "todo";
    case "ask_question":
      return "question";
    case "subagent":
      return "subagent";
    case "search_history":
    case "read_history_page":
      return "search";
    case "call_mcp_tool":
    case "refresh_mcp_servers":
      return "mcp";
    case "orchestration_board_snapshot":
    case "orchestration_create_issue":
    case "orchestration_update_issue":
    case "orchestration_comment_issue":
    case "orchestration_delete_issue":
    case "orchestration_assign_agent":
    case "orchestration_update_agent_permissions":
    case "orchestration_control_agent":
    case "orchestration_wait":
      return "orchestration";
    default:
      return "tool";
  }
}

function permissionDecisionFromOption(optionId: string | undefined): "allow" | "reject" {
  return optionId === "allow_once" || optionId === "allow_always" ? "allow" : "reject";
}

export function cesiumPermissionToolKey(
  permission: "editFile" | "terminal" | "mcpCall",
  args: Record<string, unknown>
): string {
  switch (permission) {
    case "editFile":
      return `cesium:edit_file:${asString(args.path) ?? ""}`;
    case "terminal":
      return `cesium:terminal:${asString(args.command) ?? ""}`;
    case "mcpCall":
      return `cesium:mcp:${asString(args.serverId) ?? ""}:${asString(args.toolName) ?? ""}`;
  }
}

function toolTitle(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "read_file":
      return `Read ${asString(args.path) ?? "file"}`;
    case "edit_file":
      return `Edit ${asString(args.path) ?? "file"}`;
    case "terminal":
      return `Run ${asString(args.command) ?? "command"}`;
    case "grep":
      return `Grep ${asString(args.pattern) ?? "workspace"}`;
    case "todo":
      return "Update todos";
    case "ask_question":
      return "Ask question";
    case "subagent":
      return `Subagent ${asString(args.title) ?? ""}`.trim();
    case "read_subagent_transcript":
      return "Read subagent transcript";
    case "search_history":
      return "Search history";
    case "read_history_page":
      return "Read history";
    case "call_mcp_tool":
      if (asString(args.serverId) === BROWSER_MCP_SERVER_ID) {
        return `Browser ${asString(args.toolName) ?? "tool"}`;
      }
      return `MCP ${asString(args.serverId) ?? "server"} - ${asString(args.toolName) ?? "tool"}`;
    case "refresh_mcp_servers":
      return "Refresh MCP servers";
    case "orchestration_board_snapshot":
      return "Read orchestration board";
    case "orchestration_create_issue":
      return `Create issue ${asString(args.title) ?? ""}`.trim();
    case "orchestration_update_issue":
      return `Update issue ${asString(args.issueId) ?? ""}`.trim();
    case "orchestration_comment_issue":
      return `Comment on issue ${asString(args.issueId) ?? ""}`.trim();
    case "orchestration_delete_issue":
      return `Delete issue ${asString(args.issueId) ?? ""}`.trim();
    case "orchestration_assign_agent":
      return `Assign agent to ${asString(args.issueId) ?? "issue"}`;
    case "orchestration_update_agent_permissions":
      return `Update agent permissions ${asString(args.assignmentId) ?? asString(args.conversationId) ?? ""}`.trim();
    case "orchestration_control_agent":
      return `${asString(args.action) ?? "Control"} agent ${asString(args.assignmentId) ?? asString(args.conversationId) ?? ""}`.trim();
    case "orchestration_wait":
      return "Wait for orchestration changes";
    default:
      return name;
  }
}

function isOrchestrationToolName(name: string): boolean {
  return name.startsWith("orchestration_");
}

function isAllowedInOrchestrationMode(name: string): boolean {
  return (
    isOrchestrationToolName(name) ||
    name === "ask_question" ||
    name === "search_history" ||
    name === "read_history_page" ||
    name === "todo" ||
    name === "call_mcp_tool" ||
    name === "refresh_mcp_servers"
  );
}

function statusFromError(error: unknown): { status: AgentToolCallStatus; detail: string } {
  return {
    status: "failed",
    detail: error instanceof Error ? error.message : String(error),
  };
}

function toolCallFromStoredEvent(event: Extract<AgentStoredEvent, { kind: "tool_call" }>): CesiumHistoryToolCall {
  const raw = asRecord(event.raw);
  const request = asRecord(raw);
  const name = asString(request?.name) ?? event.title.split(" ")[0] ?? "tool";
  const args = request?.arguments;
  const argumentsJson =
    typeof args === "string"
      ? args
      : JSON.stringify(asRecord(args) ?? parseJsonArgs(event.detail));
  return {
    id: event.toolCallId,
    name,
    arguments: argumentsJson,
  };
}

const MISSING_TOOL_RESULT_MESSAGE =
  "Tool call did not complete or was interrupted before returning a result.";

function flushPendingToolCalls(
  messages: CesiumHistoryMessage[],
  pending: PendingHistoryToolCall[]
): void {
  if (pending.length === 0) {
    return;
  }
  const resolved = pending.map((call) => ({
    ...call,
    result: call.result?.trim() ? call.result : MISSING_TOOL_RESULT_MESSAGE,
  }));
  messages.push({
    role: "assistant",
    content: "",
    toolCalls: resolved.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })),
  });
  for (const call of resolved) {
    messages.push({
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      content: call.result!,
    });
  }
  pending.length = 0;
}

function satisfyOpenAiToolProtocol(messages: CesiumHistoryMessage[]): CesiumHistoryMessage[] {
  const out: CesiumHistoryMessage[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      out.push(message);
      index += 1;
      continue;
    }
    out.push(message);
    const missing = new Map(message.toolCalls.map((call) => [call.id, call]));
    index += 1;
    while (index < messages.length && messages[index]!.role === "tool") {
      const tool = messages[index]!;
      out.push(tool);
      if (tool.toolCallId) {
        missing.delete(tool.toolCallId);
      }
      index += 1;
    }
    for (const call of missing.values()) {
      out.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: MISSING_TOOL_RESULT_MESSAGE,
      });
    }
  }
  return out;
}

export function normalizeEventsToHistory(events: AgentStoredEvent[]): CesiumHistoryMessage[] {
  const messages: CesiumHistoryMessage[] = [{ role: "system", content: CESIUM_SYSTEM_PROMPT }];
  const assistantTextById = new Map<string, string>();
  const pendingToolCalls: PendingHistoryToolCall[] = [];
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (const event of sorted) {
    switch (event.kind) {
      case "user_message":
        flushPendingToolCalls(messages, pendingToolCalls);
        messages.push({ role: "user", content: event.content });
        break;
      case "assistant_message_chunk":
        assistantTextById.set(event.messageId, `${assistantTextById.get(event.messageId) ?? ""}${event.text}`);
        break;
      case "assistant_message_end": {
        flushPendingToolCalls(messages, pendingToolCalls);
        const text = assistantTextById.get(event.messageId)?.trim();
        if (text) {
          messages.push({ role: "assistant", content: text });
        }
        assistantTextById.delete(event.messageId);
        break;
      }
      case "reasoning":
        flushPendingToolCalls(messages, pendingToolCalls);
        if (event.text.trim()) {
          messages.push({ role: "assistant", content: `[Reasoning]\n${event.text.trim()}` });
        }
        break;
      case "tool_call":
        pendingToolCalls.push(toolCallFromStoredEvent(event));
        break;
      case "tool_call_update":
        if (event.status === "completed" || event.status === "failed") {
          const detail =
            event.detail?.trim() ??
            (event.status === "failed" ? "Tool call failed." : "Tool call completed with no output.");
          const pending = pendingToolCalls.find((call) => call.id === event.toolCallId);
          if (pending) {
            pending.result = detail;
          } else {
            pendingToolCalls.push({
              id: event.toolCallId,
              name: (event.title ?? "tool").split(" ")[0] ?? "tool",
              arguments: "{}",
              result: detail,
            });
          }
        }
        break;
      case "plan":
        flushPendingToolCalls(messages, pendingToolCalls);
        messages.push({
          role: "assistant",
          content: event.entries.map((entry) => `- [${entry.status}] ${entry.content}`).join("\n"),
        });
        break;
      case "compression_summary":
        flushPendingToolCalls(messages, pendingToolCalls);
        messages.push({
          role: "user",
          content: `[Compressed earlier conversation]\n${event.summary}`,
        });
        break;
      case "agent_handoff":
        flushPendingToolCalls(messages, pendingToolCalls);
        messages.push({
          role: "assistant",
          content: `[Handoff from ${event.fromAgent} to ${event.toAgent}]`,
        });
        break;
      case "chat_fork":
        flushPendingToolCalls(messages, pendingToolCalls);
        messages.push({
          role: "user",
          content: `[Forked chat]\n${event.transcript}`,
        });
        break;
      default:
        break;
    }
  }
  flushPendingToolCalls(messages, pendingToolCalls);
  for (const text of assistantTextById.values()) {
    if (text.trim()) {
      messages.push({ role: "assistant", content: text.trim() });
    }
  }
  return satisfyOpenAiToolProtocol(repairOpenAiMessageSequence(messages)).slice(
    -HISTORY_EVENT_LIMIT
  );
}

function repairOpenAiMessageSequence(messages: CesiumHistoryMessage[]): CesiumHistoryMessage[] {
  const repaired: CesiumHistoryMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      const previous = repaired[repaired.length - 1];
      const hasMatchingCall =
        previous?.role === "assistant" &&
        previous.toolCalls?.some((call) => call.id === message.toolCallId);
      if (!hasMatchingCall && message.toolCallId) {
        repaired.push({
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: message.toolCallId,
              name: message.name ?? "tool",
              arguments: "{}",
            },
          ],
        });
      }
    }
    repaired.push(message);
  }
  return repaired;
}

function summarizeForCompression(events: AgentStoredEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    switch (event.kind) {
      case "user_message":
        lines.push(`User: ${truncate(event.content, 1000)}`);
        break;
      case "assistant_message_chunk":
        if (event.text.trim()) {
          lines.push(`Assistant: ${truncate(event.text.trim(), 1000)}`);
        }
        break;
      case "tool_call":
        lines.push(`Tool: ${event.title}${event.detail ? ` - ${truncate(event.detail, 400)}` : ""}`);
        break;
      case "tool_call_update":
        if (event.status === "failed") {
          lines.push(`Tool failed: ${event.title ?? event.toolCallId}${event.detail ? ` - ${truncate(event.detail, 400)}` : ""}`);
        }
        break;
      case "plan":
        lines.push(`Plan: ${event.entries.map((entry) => `${entry.status}: ${entry.content}`).join("; ")}`);
        break;
      default:
        break;
    }
  }
  return truncate(lines.join("\n"), 16_000);
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 1000)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** OpenAI-compatible hosts (Nvidia NIM, etc.) reject JSON Schema union `type` arrays. */
export function sanitizeOpenAiCompatibleJsonSchema<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeOpenAiCompatibleJsonSchema(entry)) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === "type" && Array.isArray(entry)) {
      const preferred =
        entry.find((item) => typeof item === "string" && item !== "null") ??
        entry.find((item) => typeof item === "string");
      next.type = typeof preferred === "string" ? preferred : "string";
      continue;
    }
    next[key] = sanitizeOpenAiCompatibleJsonSchema(entry);
  }
  return next as T;
}

export function buildOpenAiToolDefinitions() {
  return CESIUM_TOOLS.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: sanitizeOpenAiCompatibleJsonSchema(tool.parameters),
    },
  }));
}

function openAiTools() {
  return buildOpenAiToolDefinitions();
}

function responseTools() {
  return CESIUM_TOOLS.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function anthropicTools() {
  return CESIUM_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

function googleTools() {
  return [
    {
      functionDeclarations: CESIUM_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.parameters,
      })),
    },
  ];
}

export function openAiMessages(messages: CesiumHistoryMessage[]) {
  return satisfyOpenAiToolProtocol(repairOpenAiMessageSequence(messages)).map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId ?? message.name ?? randomUUID(),
        content: message.content,
      };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: call.arguments,
          },
        })),
      };
    }
    return {
      role: message.role,
      content: message.content,
    };
  });
}

function parseJsonArgs(value: unknown): Record<string, unknown> {
  if (asRecord(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") {
    return {};
  }
  try {
    return asRecord(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

function resolveOpenAiCompatibleBaseUrl(baseUrl: string | undefined, providerId: string): string {
  const trimmed = baseUrl?.trim();
  if (trimmed) {
    return trimmed.replace(/\/+$/, "");
  }
  if (providerPart(providerId) === "openai") {
    return "https://api.openai.com/v1";
  }
  throw new Error(
    `No API base URL for provider ${providerId}. Save a ${providerId} key in Cesium settings and refresh models.dev.`
  );
}

async function runOpenAiChat(input: {
  apiKey: string;
  baseUrl?: string;
  providerId: string;
  model: string;
  messages: CesiumHistoryMessage[];
}): Promise<CesiumAdapterResult> {
  const baseUrl = resolveOpenAiCompatibleBaseUrl(input.baseUrl, input.providerId);
  const payload = await fetchJson(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      messages: openAiMessages(input.messages),
      tools: openAiTools(),
      tool_choice: "auto",
      max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
    }),
  });
  const root = asRecord(payload);
  const choices = Array.isArray(root?.choices) ? root.choices : [];
  const choice = asRecord(choices[0]);
  const message = asRecord(choice?.message);
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return {
    text: asString(message?.content) ?? "",
    reasoning: asString(message?.reasoning),
    toolRequests: toolCalls.flatMap((toolCall): CesiumToolRequest[] => {
      const record = asRecord(toolCall);
      const fn = asRecord(record?.function);
      const name = asString(fn?.name);
      if (!record || !name) {
        return [];
      }
      return [{
        id: asString(record.id) ?? randomUUID(),
        name,
        arguments: parseJsonArgs(fn?.arguments),
      }];
    }),
    raw: payload,
  };
}

async function runOpenAiResponses(input: {
  apiKey: string;
  baseUrl?: string;
  providerId: string;
  model: string;
  messages: CesiumHistoryMessage[];
}): Promise<CesiumAdapterResult> {
  const baseUrl = resolveOpenAiCompatibleBaseUrl(input.baseUrl, input.providerId);
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      input: input.messages.map((message) => ({
        role: message.role === "system" ? "developer" : message.role,
        content: message.content,
      })),
      tools: responseTools(),
      max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
      stream: true,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 1000)}`);
  }
  if (response.body) {
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    const textParts: string[] = [];
    const toolRequests: CesiumToolRequest[] = [];
    const rawEvents: unknown[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\n\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const dataLines = frame
          .split(/\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trim());
        for (const dataLine of dataLines) {
          if (!dataLine || dataLine === "[DONE]") {
            continue;
          }
          const event = parseJsonArgs(dataLine);
          rawEvents.push(event);
          if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
            textParts.push(event.delta);
          }
          const item = asRecord(event.item);
          if (item?.type === "function_call") {
            const name = asString(item.name);
            if (name) {
              toolRequests.push({
                id: asString(item.call_id) ?? asString(item.id) ?? randomUUID(),
                name,
                arguments: parseJsonArgs(item.arguments),
              });
            }
          }
        }
      }
    }
    return {
      text: textParts.join(""),
      toolRequests,
      raw: rawEvents,
    };
  }
  const payload = await response.json();
  const record = asRecord(payload);
  const output = Array.isArray(record?.output) ? record.output : [];
  const toolRequests: CesiumToolRequest[] = [];
  const textParts: string[] = [];
  for (const item of output) {
    const out = asRecord(item);
    if (!out) continue;
    if (out.type === "function_call") {
      const name = asString(out.name);
      if (name) {
        toolRequests.push({
          id: asString(out.call_id) ?? asString(out.id) ?? randomUUID(),
          name,
          arguments: parseJsonArgs(out.arguments),
        });
      }
    }
    if (Array.isArray(out.content)) {
      for (const content of out.content) {
        const c = asRecord(content);
        const text = asString(c?.text);
        if (text) textParts.push(text);
      }
    }
  }
  return {
    text: asString(record?.output_text) ?? textParts.join(""),
    reasoning: asString(record?.reasoning),
    toolRequests,
    raw: payload,
  };
}

async function runOpenAiRealtime(input: {
  apiKey: string;
  model: string;
  messages: CesiumHistoryMessage[];
}): Promise<CesiumAdapterResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(input.model)}`, {
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "openai-beta": "realtime=v1",
      },
    });
    const text: string[] = [];
    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["text"],
          instructions: CESIUM_SYSTEM_PROMPT,
          tools: responseTools(),
        },
      }));
      ws.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: input.messages.map((m) => `${m.role}: ${m.content}`).join("\n\n") }],
        },
      }));
      ws.send(JSON.stringify({ type: "response.create" }));
    });
    ws.on("message", (data) => {
      const event = parseJsonArgs(data.toString());
      if (event.type === "response.text.delta" && typeof event.delta === "string") {
        text.push(event.delta);
      }
      if (event.type === "response.done") {
        ws.close();
        resolve({ text: text.join(""), toolRequests: [], raw: event });
      }
    });
    ws.on("error", (error) => {
      reject(error);
    });
  });
}

function anthropicMessages(messages: CesiumHistoryMessage[]) {
  return repairOpenAiMessageSequence(messages)
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role === "tool") {
        return {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.toolCallId ?? message.name ?? randomUUID(),
              content: message.content,
            },
          ],
        };
      }
      if (message.role === "assistant" && message.toolCalls?.length) {
        const blocks: Array<Record<string, unknown>> = [];
        if (message.content.trim()) {
          blocks.push({ type: "text", text: message.content });
        }
        for (const call of message.toolCalls) {
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: parseJsonArgs(call.arguments),
          });
        }
        return { role: "assistant", content: blocks };
      }
      return {
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      };
    });
}

async function runAnthropic(input: {
  apiKey: string;
  model: string;
  messages: CesiumHistoryMessage[];
}): Promise<CesiumAdapterResult> {
  const payload = await fetchJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      system: CESIUM_SYSTEM_PROMPT,
      max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
      messages: anthropicMessages(input.messages),
      tools: anthropicTools(),
    }),
  });
  const root = asRecord(payload);
  const content = Array.isArray(root?.content) ? root.content : [];
  const toolRequests: CesiumToolRequest[] = [];
  const text: string[] = [];
  for (const block of content) {
    const item = asRecord(block);
    if (!item) continue;
    if (item.type === "text" && typeof item.text === "string") {
      text.push(item.text);
    } else if (item.type === "tool_use") {
      const name = asString(item.name);
      if (name) {
        toolRequests.push({
          id: asString(item.id) ?? randomUUID(),
          name,
          arguments: asRecord(item.input) ?? {},
        });
      }
    }
  }
  return { text: text.join(""), toolRequests, raw: payload };
}

function googleContents(messages: CesiumHistoryMessage[]) {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));
}

async function runGoogle(input: {
  apiKey: string;
  model: string;
  messages: CesiumHistoryMessage[];
}): Promise<CesiumAdapterResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent?key=${encodeURIComponent(input.apiKey)}`;
  const payload = await fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: googleContents(input.messages),
      systemInstruction: { parts: [{ text: CESIUM_SYSTEM_PROMPT }] },
      tools: googleTools(),
      generationConfig: {
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      },
    }),
  });
  const root = asRecord(payload);
  const candidates = Array.isArray(root?.candidates)
    ? root.candidates
    : [];
  const candidate = asRecord(candidates[0]);
  const content = asRecord(candidate?.content);
  const parts = Array.isArray(content?.parts)
    ? content.parts
    : [];
  const text: string[] = [];
  const toolRequests: CesiumToolRequest[] = [];
  for (const part of parts) {
    const record = asRecord(part);
    if (!record) continue;
    if (typeof record.text === "string") {
      text.push(record.text);
    }
    const call = asRecord(record.functionCall);
    const name = asString(call?.name);
    if (name) {
      toolRequests.push({
        id: randomUUID(),
        name,
        arguments: asRecord(call?.args) ?? {},
      });
    }
  }
  return { text: text.join(""), toolRequests, raw: payload };
}

type RunAdapterInput = {
  apiKind: CesiumProviderKind;
  apiKey: string;
  baseUrl?: string;
  providerId: string;
  modelId: string;
  messages: CesiumHistoryMessage[];
};

async function runAdapter(input: RunAdapterInput): Promise<CesiumAdapterResult> {
  const model = modelPart(input.modelId);
  const providerId = providerPart(input.modelId);
  switch (input.apiKind) {
    case "openai-chat-completions":
    case "openai-compatible":
      return runOpenAiChat({
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        providerId,
        model,
        messages: input.messages,
      });
    case "openai-realtime":
      return runOpenAiRealtime({ apiKey: input.apiKey, model, messages: input.messages });
    case "anthropic":
      return runAnthropic({ apiKey: input.apiKey, model, messages: input.messages });
    case "google-genai":
      return runGoogle({ apiKey: input.apiKey, model, messages: input.messages });
    case "openai-responses":
    default:
      return runOpenAiResponses({
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        providerId,
        model,
        messages: input.messages,
      });
  }
}

type CesiumPausePhase = "none" | "pause_requested" | "pausing" | "paused";

class CesiumSessionHandle implements AgentSessionHandle {
  readonly sessionId: string;
  configOptions: AgentConfigOption[];
  readonly capabilities: AgentBackendInfo["capabilities"];

  private disposed = false;
  private cancelled = false;
  private pausePhase: CesiumPausePhase = "none";
  private resumeWaiter: (() => void) | null = null;
  private resumeAck: (() => void) | null = null;
  private pendingPermissions = new Map<string, ActivePermission>();
  private pendingQuestions = new Map<string, ActiveQuestion>();
  private terminalRuns = new Map<string, TerminalRun>();
  private subagentTranscripts = new Map<string, AgentStoredEvent[]>();
  private activeSystemPrompt = CESIUM_SYSTEM_PROMPT;

  constructor(
    private readonly backend: AgentBackendInfo,
    private readonly callbacks: AgentRuntimeCallbacks,
    configOptions: AgentConfigOption[],
    sessionId?: string | null
  ) {
    this.sessionId = sessionId ?? `cesium-${callbacks.conversation.id}`;
    this.configOptions = configOptions;
    this.capabilities = backend.capabilities;
  }

  async initialize(): Promise<void> {
    const modelId = this.callbacks.conversation.config.modelId?.trim();
    if (modelId) {
      this.configOptions = updateConfigOption(this.configOptions, "model", modelId);
    }
    const mode = this.callbacks.conversation.config.mode?.trim();
    if (mode) {
      this.configOptions = updateConfigOption(this.configOptions, "mode", mode);
    }
    await this.callbacks.updateConversation((current) => ({
      ...current,
      providerSessionId: this.sessionId,
      configOptions: this.configOptions,
      capabilities: this.capabilities,
      status:
        current.status === "running" ||
        current.status === "pause_requested" ||
        current.status === "pausing" ||
        current.status === "paused" ||
        current.status === "awaiting_permission" ||
        current.status === "awaiting_question"
          ? current.status
          : "idle",
      pendingPermission: null,
      pendingQuestion: null,
      lastError: null,
    }));
  }

  private async resolveSystemPromptContext(
    mcpSummaries: McpServerSummary[]
  ): Promise<BuildCesiumSystemPromptInput> {
    const workspaceRoot = this.callbacks.workspace.root;
    let gitSummary = "not a git repository";
    try {
      const status = await getGitWorkspaceStatus(this.callbacks.workspace, []);
      gitSummary = formatGitSummaryForPrompt(status);
    } catch {
      gitSummary = "not a git repository";
    }
    let agentsMarkdown = "(No AGENTS.md file is present in this workspace.)";
    try {
      const content = await fs.readFile(path.join(workspaceRoot, "AGENTS.md"), "utf8");
      if (content.trim()) {
        agentsMarkdown = content.trim();
      }
    } catch {
      // keep default placeholder
    }
    return {
      mcpSummaries,
      modelName: this.callbacks.conversation.config.modelName ?? "configured model",
      workspaceRoot,
      dateLabel: new Date().toLocaleString("en-US", {
        dateStyle: "full",
        timeStyle: "short",
      }),
      gitSummary,
      agentsMarkdown,
    };
  }

  private isOrchestrationMode(): boolean {
    return this.callbacks.conversation.config.mode === "orchestration";
  }

  private async resolveCurrentOrchestrationBoard() {
    return resolveOrCreateOrchestrationBoardForHeadConversation({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
      title: this.callbacks.conversation.title || "Orchestration Mode",
      allowedBackendIds: ["cesium-agent"],
    });
  }

  async prompt(input: {
    text: string;
    userMessageId: string;
    attachments?: Array<{ mimeType: string; data: string; name?: string }>;
    isRetry?: boolean;
  }): Promise<void> {
    if (this.disposed) {
      throw new Error("Cesium session has been disposed.");
    }
    this.cancelled = false;
    this.pausePhase = "none";
    this.resumeWaiter = null;
    this.releaseResumeAck();
    const assistantMessageId = `cesium-assistant-${randomUUID()}`;
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "running",
        detail: "Cesium is starting…",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      lastError: null,
      providerSessionId: this.sessionId,
    }));
    try {
      const modelId = optionValue(
        this.configOptions,
        "model",
        this.callbacks.conversation.config.modelId || "openai/gpt-5.1"
      );
      const modelProviderId = providerPart(modelId);
      const auth = await resolveCesiumAuth({
        modelId,
        configuredApiKind:
          modelProviderId === "openai"
            ? (optionValue(this.configOptions, "api_kind", "openai-responses") as CesiumProviderKind)
            : undefined,
      });
      await refreshWorkspaceMcpMirror({
        workspaceId: this.callbacks.workspace.id,
        workspaceRoot: this.callbacks.workspace.root,
      }).catch(async (error) => {
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "system",
            level: "warning",
            text: `MCP server refresh failed before the model turn. ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ]);
      });
      const summaries = await getMcpSummariesForPrompt(this.callbacks.workspace.id);
      if (this.isOrchestrationMode()) {
        const orchestrationSummaries = summaries.filter(
          (summary) => summary.id !== BROWSER_MCP_SERVER_ID
        );
        const board = await this.resolveCurrentOrchestrationBoard();
        const promptContext = await this.resolveSystemPromptContext(orchestrationSummaries);
        this.activeSystemPrompt = buildCesiumOrchestrationSystemPrompt({
          ...promptContext,
          workspaceRoot: this.callbacks.workspace.root,
          boardId: board?.board.id,
          maxConcurrentIssues: board?.board.settings.maxConcurrentIssues,
          maxConcurrentAgents: board?.board.settings.maxConcurrentAgents,
        });
      } else {
        this.activeSystemPrompt = buildCesiumSystemPrompt(
          await this.resolveSystemPromptContext(summaries)
        );
      }
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "running",
          detail: `Cesium is connecting to ${modelProviderId}…`,
        },
      ]);
      let history = await this.buildHistory(input.userMessageId);
      if (!history.some((message) => message.role === "user" && message.content === input.text)) {
        history.push({ role: "user", content: input.text });
      }
      const toolResultMessages: CesiumHistoryMessage[] = [];
      for (let iteration = 0; ; iteration += 1) {
        if (this.cancelled) {
          return;
        }
        await this.waitAtPauseCheckpoint();
        if (this.cancelled) {
          return;
        }
        const result = await this.runAdapterWithWarning(
          {
            apiKind: auth.apiKind,
            apiKey: auth.apiKey,
            baseUrl: auth.baseUrl,
            providerId: auth.providerId,
            modelId,
            messages: [...history, ...toolResultMessages],
          },
          iteration
        );
        if (result.reasoning) {
          await this.callbacks.appendEvents([
            {
              eventId: randomUUID(),
              conversationId: this.callbacks.conversation.id,
              kind: "reasoning",
              messageId: `${assistantMessageId}-reasoning-${iteration}`,
              text: result.reasoning,
              raw: result.raw,
            },
          ]);
        }
        if (result.text.trim()) {
          await this.callbacks.appendEvents([
            {
              eventId: randomUUID(),
              conversationId: this.callbacks.conversation.id,
              kind: "assistant_message_chunk",
              messageId: assistantMessageId,
              text: result.text,
              raw: result.raw,
            },
          ]);
          if (result.toolRequests.length === 0) {
            history.push({ role: "assistant", content: result.text });
          }
        }
        if (result.toolRequests.length === 0) {
          await this.finishAssistant(assistantMessageId, result.raw);
          return;
        }
        toolResultMessages.push({
          role: "assistant",
          content: result.text.trim(),
          toolCalls: result.toolRequests.map((request) => ({
            id: request.id,
            name: request.name,
            arguments: JSON.stringify(request.arguments),
          })),
        });
        for (const request of result.toolRequests) {
          if (this.cancelled) {
            return;
          }
          const toolResult = await this.executeTool(request);
          toolResultMessages.push({
            role: "tool",
            toolCallId: request.id,
            name: request.name,
            content: toolResult,
          });
        }
        await this.waitAtPauseCheckpoint();
        if (this.cancelled) {
          return;
        }
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);
      console.warn("[cesium-agent] turn failed:", message);
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
        pendingQuestion: null,
      }));
    }
  }

  private async runAdapterWithWarning(
    input: RunAdapterInput,
    iteration: number
  ): Promise<CesiumAdapterResult> {
    const providerId = providerPart(input.modelId);
    const timer = setTimeout(() => {
      void this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "warning",
          text:
            `Still waiting for ${providerId} to return a response after ` +
            `${Math.round(CESIUM_RESPONSE_WARNING_MS / 60_000)} minutes. ` +
            "Cesium is not cancelling the request.",
          raw: { modelId: input.modelId, iteration },
        },
      ]).catch(() => undefined);
    }, CESIUM_RESPONSE_WARNING_MS);
    try {
      return await runAdapter(input);
    } finally {
      clearTimeout(timer);
    }
  }

  async pause(): Promise<void> {
    if (this.disposed || this.cancelled) {
      return;
    }
    if (
      this.pausePhase === "pause_requested" ||
      this.pausePhase === "pausing" ||
      this.pausePhase === "paused"
    ) {
      return;
    }
    this.pausePhase = "pause_requested";
    await this.emitConversationStatus("pause_requested", "Pause requested…");
  }

  async resume(): Promise<void> {
    if (this.pausePhase !== "paused") {
      return;
    }
    await new Promise<void>((resolve) => {
      this.resumeAck = resolve;
      this.resumeWaiter?.();
    });
  }

  private releaseResumeAck(): void {
    this.resumeAck?.();
    this.resumeAck = null;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.pausePhase = "none";
    this.resumeWaiter?.();
    this.resumeWaiter = null;
    this.releaseResumeAck();
    for (const permission of this.pendingPermissions.values()) {
      permission.reject(new Error("Cesium turn cancelled."));
    }
    this.pendingPermissions.clear();
    for (const question of this.pendingQuestions.values()) {
      question.reject(new Error("Cesium turn cancelled."));
    }
    this.pendingQuestions.clear();
    for (const run of this.terminalRuns.values()) {
      if (run.exitCode === undefined) {
        run.process.kill();
      }
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "cancelled",
        detail: "Cesium turn cancelled.",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "cancelled",
      providerSessionId: null,
      pendingPermission: null,
      pendingQuestion: null,
    }));
  }

  private async emitConversationStatus(
    status: AgentConversationStatus,
    detail: string
  ): Promise<void> {
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status,
        detail,
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status,
    }));
  }

  private async waitAtPauseCheckpoint(): Promise<void> {
    if (this.pausePhase !== "pause_requested") {
      return;
    }
    this.pausePhase = "pausing";
    await this.emitConversationStatus("pausing", "Finishing current step…");
    if (this.cancelled || this.disposed || this.pausePhase !== "pausing") {
      this.releaseResumeAck();
      return;
    }
    this.pausePhase = "paused";
    await this.emitConversationStatus("paused", "Cesium is paused.");
    if (this.cancelled || this.disposed || this.pausePhase !== "paused") {
      this.releaseResumeAck();
      return;
    }
    await new Promise<void>((resolve) => {
      this.resumeWaiter = resolve;
    });
    this.resumeWaiter = null;
    if (this.cancelled || this.disposed) {
      this.releaseResumeAck();
      return;
    }
    this.pausePhase = "none";
    await this.emitConversationStatus("running", "Cesium resumed.");
    this.releaseResumeAck();
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    this.configOptions = updateConfigOption(this.configOptions, configId, value);
    const modelOption = this.configOptions.find((option) => option.id === "model");
    const modeOption = this.configOptions.find((option) => option.id === "mode");
    await this.callbacks.updateConversation((current) => ({
      ...current,
      configOptions: this.configOptions,
      config: {
        ...current.config,
        modelId: modelOption?.currentValue ?? current.config.modelId,
        modelName:
          modelOption?.options.find((option) => option.value === modelOption.currentValue)?.name ??
          current.config.modelName,
        mode:
          configId === "mode"
            ? value
            : (modeOption?.currentValue ?? current.config.mode),
      },
    }));
  }

  async answerPermission(input: {
    requestId: string;
    optionId?: string;
    cancelled?: boolean;
  }): Promise<void> {
    const pending = this.pendingPermissions.get(input.requestId);
    if (!pending) {
      return;
    }
    this.pendingPermissions.delete(input.requestId);
    const decision = input.cancelled ? "reject" : permissionDecisionFromOption(input.optionId);
    const optionId = input.cancelled ? undefined : input.optionId;
    if (optionId === "allow_always" || optionId === "reject_always") {
      await saveRememberedAgentPermissionRule({
        workspaceId: this.callbacks.workspace.id,
        backendId: this.backend.id,
        toolKey: pending.toolKey,
        toolLabel: pending.toolLabel,
        decision,
        optionId,
        optionKind: optionId,
      }).catch(() => undefined);
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "permission_resolved",
        requestId: input.requestId,
        outcome: input.cancelled ? "cancelled" : "selected",
        optionId,
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "running",
        detail: decision === "allow" ? "Permission allowed." : "Permission rejected.",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
    }));
    pending.resolve(decision === "allow" ? "allow" : "reject");
  }

  async answerQuestion(input: { questionId: string; answer: string }): Promise<void> {
    const pending = this.pendingQuestions.get(input.questionId);
    if (!pending) {
      return;
    }
    this.pendingQuestions.delete(input.questionId);
    const answer = input.answer.trim();
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "question",
        questionId: input.questionId,
        prompt: pending.prompt,
        options: pending.options,
        questions: pending.questions,
        allowMultiple: pending.allowMultiple,
        status: "answered",
        answer,
        raw: pending.raw,
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "running",
        detail: "Question answered.",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingQuestion: null,
    }));
    pending.resolve(answer);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.pausePhase = "none";
    this.resumeWaiter?.();
    this.resumeWaiter = null;
    this.releaseResumeAck();
    for (const permission of this.pendingPermissions.values()) {
      permission.reject(new Error("Cesium session disposed."));
    }
    this.pendingPermissions.clear();
    for (const question of this.pendingQuestions.values()) {
      question.reject(new Error("Cesium session disposed."));
    }
    this.pendingQuestions.clear();
  }

  private async finishAssistant(messageId: string, raw?: unknown): Promise<void> {
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "assistant_message_end",
        messageId,
        stopReason: "end_turn",
        raw,
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "idle",
        detail: "Cesium turn complete.",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "idle",
      pendingPermission: null,
      pendingQuestion: null,
      lastError: null,
      providerSessionId: this.sessionId,
      configOptions: this.configOptions,
    }));
  }

  private async buildHistory(currentUserMessageId: string): Promise<CesiumHistoryMessage[]> {
    const snapshot = await this.callbacks.readSnapshot();
    const events = snapshot?.events ?? [];
    const userTurns = events.filter((event) => event.kind === "user_message").length;
    if (userTurns > HISTORY_TURN_LIMIT) {
      const sorted = [...events].sort((a, b) => a.seq - b.seq);
      let retainedUsers = 0;
      let splitIndex = 0;
      for (let index = sorted.length - 1; index >= 0; index -= 1) {
        if (sorted[index]!.kind === "user_message") {
          retainedUsers += 1;
          splitIndex = index;
          if (retainedUsers >= HISTORY_TURN_LIMIT) {
            break;
          }
        }
      }
      const compressed = sorted.slice(0, splitIndex);
      const retained = sorted.slice(splitIndex);
      if (!retained.some((event) => event.kind === "compression_summary")) {
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "compression_summary",
            messageId: `cesium-compression-${randomUUID()}`,
            summary: summarizeForCompression(compressed),
            retainedTurnCount: retainedUsers,
            compressedTurnCount: compressed.filter((event) => event.kind === "user_message").length,
          },
        ]);
      }
      return this.normalizeEventsToHistory(retained);
    }
    return this.normalizeEventsToHistory(
      events.filter((event) => event.kind !== "user_message" || event.messageId !== currentUserMessageId || event.seq > 0)
    );
  }

  private normalizeEventsToHistory(events: AgentStoredEvent[]): CesiumHistoryMessage[] {
    const base = normalizeEventsToHistory(events);
    return [{ role: "system", content: this.activeSystemPrompt }, ...base.slice(1)];
  }

  private async requirePermission(input: {
    toolCallId: string;
    title: string;
    detail: string;
    permission: "editFile" | "terminal" | "mcpCall";
    toolKey: string;
    toolLabel: string;
  }): Promise<void> {
    const assignment = await findOrchestrationAssignmentForConversation(
      this.callbacks.workspace.id,
      this.callbacks.conversation.id
    ).catch(() => null);
    const orchestrationPolicy = assignment
      ? assignment.config.permissionPolicy?.[input.permission] ?? "allow"
      : undefined;
    if (orchestrationPolicy === "allow") {
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "running",
          detail: `Allowed ${input.title} by orchestration assignment policy.`,
        },
      ]);
      return;
    }
    if (orchestrationPolicy === "deny") {
      throw new Error(`${input.title} blocked by orchestration assignment policy.`);
    }

    const [settings, globalSettings] = await Promise.all([
      getCesiumAgentSettings(),
      getGlobalSettings().catch(() => null),
    ]);
    let policy = settings.toolPermissions[input.permission];
    if (input.permission === "mcpCall" && globalSettings?.agents.mcpProt) {
      policy = "ask";
    }
    if (policy === "deny") {
      throw new Error(`${input.title} blocked by Cesium permission settings.`);
    }

    const remembered = globalSettings?.agents.rememberedPermissions.find(
      (rule) =>
        rule.workspaceId === this.callbacks.workspace.id &&
        rule.backendId === this.backend.id &&
        rule.toolKey === input.toolKey
    );
    if (remembered) {
      if (remembered.decision === "reject") {
        throw new Error(
          `${input.title} rejected by remembered permission for ${remembered.toolLabel}.`
        );
      }
      const requestId = randomUUID();
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "permission_resolved",
          requestId,
          outcome: "selected",
          optionId: remembered.optionId,
          raw: {
            rememberedPermission: {
              id: remembered.id,
              decision: remembered.decision,
              toolLabel: remembered.toolLabel,
            },
          },
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "running",
          detail: `Used remembered permission for ${remembered.toolLabel}.`,
        },
      ]);
      return;
    }

    if (globalSettings?.agents.autoAcceptAllAgentPermissions) {
      return;
    }

    if (policy === "allow") {
      return;
    }

    const requestId = randomUUID();
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "permission_request",
        requestId,
        toolCallId: input.toolCallId,
        title: input.title,
        detail: input.detail,
        options: PERMISSION_OPTIONS,
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "awaiting_permission",
      pendingPermission: {
        requestId,
        requestedAt: Date.now(),
        toolCallId: input.toolCallId,
        permission: input.permission,
        title: input.title,
        detail: input.detail,
        options: PERMISSION_OPTIONS,
      },
    }));
    const decision = await new Promise<"allow" | "reject">((resolve, reject) => {
      this.pendingPermissions.set(requestId, {
        resolve,
        reject,
        toolKey: input.toolKey,
        toolLabel: input.toolLabel,
      });
    });
    if (decision !== "allow") {
      throw new Error(`${input.title} rejected by user.`);
    }
  }

  private async executeTool(request: CesiumToolRequest): Promise<string> {
    const title = toolTitle(request.name, request.arguments);
    const callEvent: AgentEventInput = {
      eventId: randomUUID(),
      conversationId: this.callbacks.conversation.id,
      kind: "tool_call",
      toolCallId: request.id,
      title,
      toolKind: toolKind(request.name),
      status: "in_progress",
      detail: safeJson(request.arguments),
      raw: request,
    };
    await this.callbacks.appendEvents([callEvent]);
    try {
      let result: string;
      if (this.isOrchestrationMode() && !isAllowedInOrchestrationMode(request.name)) {
        throw new Error(
          `Tool ${request.name} is not available in Orchestration Mode. Manage work through the kanban and agent orchestration tools.`
        );
      }
      if (!this.isOrchestrationMode() && isOrchestrationToolName(request.name)) {
        throw new Error(`Tool ${request.name} is only available in Orchestration Mode.`);
      }
      if (request.name === "edit_file") {
        await this.requirePermission({
          toolCallId: request.id,
          title,
          detail: safeJson(request.arguments),
          permission: "editFile",
          toolKey: cesiumPermissionToolKey("editFile", request.arguments),
          toolLabel: title,
        });
      } else if (request.name === "terminal") {
        await this.requirePermission({
          toolCallId: request.id,
          title,
          detail: safeJson(request.arguments),
          permission: "terminal",
          toolKey: cesiumPermissionToolKey("terminal", request.arguments),
          toolLabel: title,
        });
      }
      switch (request.name) {
        case "read_file":
          result = await this.toolReadFile(request.arguments);
          break;
        case "grep":
          result = await this.toolGrep(request.arguments);
          break;
        case "edit_file":
          result = await this.toolEditFile(request.arguments, request.id, title);
          break;
        case "terminal":
          result = await this.toolTerminal(request.arguments);
          break;
        case "todo":
          result = await this.toolTodo(request.arguments);
          break;
        case "ask_question":
          result = await this.toolAskQuestion(request.arguments);
          break;
        case "subagent":
          result = await this.toolSubagent(request.arguments);
          break;
        case "read_subagent_transcript":
          result = this.toolReadSubagentTranscript(request.arguments);
          break;
        case "search_history":
          result = await this.toolSearchHistory(request.arguments);
          break;
        case "read_history_page":
          result = await this.toolReadHistoryPage(request.arguments);
          break;
        case "call_mcp_tool":
          result = await this.toolCallMcp(request.arguments, request.id, title);
          break;
        case "refresh_mcp_servers":
          result = await this.toolRefreshMcpServers();
          break;
        case "orchestration_board_snapshot":
          result = await this.toolOrchestrationBoardSnapshot(request.arguments);
          break;
        case "orchestration_create_issue":
          result = await this.toolOrchestrationCreateIssue(request.arguments);
          break;
        case "orchestration_update_issue":
          result = await this.toolOrchestrationUpdateIssue(request.arguments);
          break;
        case "orchestration_comment_issue":
          result = await this.toolOrchestrationCommentIssue(request.arguments);
          break;
        case "orchestration_delete_issue":
          result = await this.toolOrchestrationDeleteIssue(request.arguments);
          break;
        case "orchestration_assign_agent":
          result = await this.toolOrchestrationAssignAgent(request.arguments);
          break;
        case "orchestration_update_agent_permissions":
          result = await this.toolOrchestrationUpdateAgentPermissions(request.arguments);
          break;
        case "orchestration_control_agent":
          result = await this.toolOrchestrationControlAgent(request.arguments);
          break;
        case "orchestration_wait":
          result = await this.toolOrchestrationWait(request.arguments);
          break;
        default:
          throw new Error(`Unknown Cesium tool: ${request.name}`);
      }
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "tool_call_update",
          toolCallId: request.id,
          title,
          toolKind: toolKind(request.name),
          status: "completed",
          detail: result,
          raw: { request, result },
        },
      ]);
      return result;
    } catch (error) {
      const failed = statusFromError(error);
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "tool_call_update",
          toolCallId: request.id,
          title,
          toolKind: toolKind(request.name),
          status: failed.status,
          detail: failed.detail,
          raw: { request, error: failed.detail },
        },
      ]);
      return failed.detail;
    }
  }

  private async toolReadFile(args: Record<string, unknown>): Promise<string> {
    const inputPath = asString(args.path);
    if (!inputPath) throw new Error("read_file.path is required.");
    const resolved = resolveWorkspacePath(this.callbacks.workspace.root, inputPath);
    const raw = await fs.readFile(resolved, "utf8");
    const lines = raw.split(/\r?\n/);
    const offset = Math.max(1, Math.floor(asNumber(args.offset) ?? 1));
    const requestedLimit = Math.floor(asNumber(args.limit) ?? Math.min(lines.length, MAX_READ_LINES));
    const limit = Math.min(Math.max(1, requestedLimit), MAX_READ_LINES);
    if (lines.length > LARGE_FILE_LINE_LIMIT && !args.offset && !args.limit) {
      return [
        `${inputPath} has ${lines.length} lines, which exceeds ${LARGE_FILE_LINE_LIMIT}.`,
        `Start:\n${lines.slice(0, 80).map((line, index) => `${index + 1}|${line}`).join("\n")}`,
        `End:\n${lines.slice(-80).map((line, index) => `${lines.length - 79 + index}|${line}`).join("\n")}`,
        `Use offset and limit to read up to ${MAX_READ_LINES} lines.`,
      ].join("\n\n");
    }
    return lines
      .slice(offset - 1, offset - 1 + limit)
      .map((line, index) => `${offset + index}|${line}`)
      .join("\n");
  }

  private async toolGrep(args: Record<string, unknown>): Promise<string> {
    const pattern = asString(args.pattern);
    if (!pattern) throw new Error("grep.pattern is required.");
    const root = resolveWorkspacePath(this.callbacks.workspace.root, asString(args.path) ?? ".");
    const regex = new RegExp(pattern, "i");
    const context = Math.max(0, Math.min(20, Math.floor(asNumber(args.context) ?? 0)));
    const maxResults = Math.max(1, Math.min(MAX_GREP_RESULTS, Math.floor(asNumber(args.maxResults) ?? DEFAULT_GREP_RESULTS)));
    const results: string[] = [];
    const visit = async (dir: string): Promise<void> => {
      if (results.length >= maxResults) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".docker" || entry.name === ".next") {
          continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const text = await fs.readFile(full, "utf8").catch(() => null);
        if (text == null) continue;
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length && results.length < maxResults; index += 1) {
          if (!regex.test(lines[index] ?? "")) continue;
          const start = Math.max(0, index - context);
          const end = Math.min(lines.length, index + context + 1);
          const rel = path.relative(this.callbacks.workspace.root, full);
          results.push(`${rel}:${index + 1}\n${lines.slice(start, end).map((line, i) => `${start + i + 1}|${line}`).join("\n")}`);
        }
      }
    };
    await visit(root);
    return results.length ? results.join("\n\n") : "No matches.";
  }

  private async toolEditFile(
    args: Record<string, unknown>,
    toolCallId: string,
    title: string
  ): Promise<string> {
    const inputPath = asString(args.path);
    const oldString = typeof args.oldString === "string" ? args.oldString : "";
    const newString = typeof args.newString === "string" ? args.newString : "";
    if (!inputPath) throw new Error("edit_file.path is required.");
    if (!oldString) throw new Error("edit_file.oldString is required.");
    const resolved = resolveWorkspacePath(this.callbacks.workspace.root, inputPath);
    const before = await fs.readFile(resolved, "utf8");
    const first = before.indexOf(oldString);
    if (first < 0) throw new Error("oldString was not found.");
    if (before.indexOf(oldString, first + oldString.length) >= 0) {
      throw new Error("oldString matches more than once; include more context.");
    }
    const after = `${before.slice(0, first)}${newString}${before.slice(first + oldString.length)}`;
    await fs.writeFile(resolved, after, "utf8");
    const editPreview = extractToolEditPreview(
      { path: inputPath, oldString, newString },
      { beforeFullFileContent: before, afterFullFileContent: after },
      inputPath
    );
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "tool_call_update",
        toolCallId,
        title,
        toolKind: "edit",
        status: "in_progress",
        detail: "Applied edit preview.",
        locations: [{ path: inputPath }],
        editPreview,
      },
    ]);
    return `Edited ${inputPath}.`;
  }

  private async toolTerminal(args: Record<string, unknown>): Promise<string> {
    const command = asString(args.command);
    if (!command) throw new Error("terminal.command is required.");
    const waitUntil = asString(args.waitUntil) ?? "complete";
    const timeoutMs = Math.max(1000, Math.min(120_000, Math.floor(asNumber(args.timeoutMs) ?? 30_000)));
    const child = spawn(command, {
      cwd: this.callbacks.workspace.root,
      shell: true,
      windowsHide: true,
    });
    const id = randomUUID();
    const run: TerminalRun = {
      id,
      process: child,
      output: "",
      startedAt: Date.now(),
    };
    this.terminalRuns.set(id, run);
    const append = (chunk: Buffer) => {
      run.output = truncate(`${run.output}${chunk.toString("utf8")}`, TERMINAL_OUTPUT_CAP);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("exit", (code) => {
      run.exitCode = code;
      run.completedAt = Date.now();
    });
    if (waitUntil === "background") {
      return `Started background command ${id}: ${command}`;
    }
    const pattern = asString(args.pattern);
    return await new Promise<string>((resolve) => {
      const started = Date.now();
      const interval = setInterval(() => {
        if (waitUntil === "pattern" && pattern && run.output.includes(pattern)) {
          clearInterval(interval);
          resolve(`Pattern matched for ${command}.\n${run.output}`);
          return;
        }
        if (run.exitCode !== undefined) {
          clearInterval(interval);
          resolve(`Command exited ${run.exitCode ?? 0}.\n${run.output}`);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          clearInterval(interval);
          resolve(`Command still running after ${timeoutMs}ms as ${id}.\n${run.output}`);
        }
      }, 250);
    });
  }

  private async toolTodo(args: Record<string, unknown>): Promise<string> {
    const action = asString(args.action) ?? "list";
    const items = Array.isArray(args.items) ? args.items : [];
    if (this.isOrchestrationMode()) {
      const snapshot = await this.resolveCurrentOrchestrationBoard();
      if (action === "list") {
        const lines = snapshot.issues.map(
          (issue) =>
            `${issue.columnId}: ${issue.title}${
              issue.acceptanceCriteria.length
                ? ` (${issue.acceptanceCriteria.length} acceptance criteria)`
                : ""
            }`
        );
        return lines.length
          ? lines.join("\n")
          : "No orchestration issues yet. Use orchestration_create_issue or provide todo items to create board issues.";
      }

      const parsedItems = items.flatMap((item) => {
        const record = asRecord(item);
        const content = asString(record?.content) ?? asString(item);
        if (!content) return [];
        const status = record?.status;
        const columnId: OrchestrationColumnId =
          status === "completed"
            ? "done"
            : status === "in_progress"
              ? "in_progress"
              : "backlog";
        return [{ content, columnId }];
      });
      let current = snapshot;
      const touchedIssues: string[] = [];
      for (const item of parsedItems) {
        const existing = current.issues.find(
          (issue) => issue.title.trim().toLowerCase() === item.content.trim().toLowerCase()
        );
        if (existing) {
          current = await upsertOrchestrationIssue(
            current.board.id,
            { id: existing.id, columnId: item.columnId },
            { type: "head_agent", conversationId: this.callbacks.conversation.id }
          );
          touchedIssues.push(existing.id);
          continue;
        }
        current = await createOrchestrationIssue({
          boardId: current.board.id,
          title: item.content,
          columnId: item.columnId,
          actor: { type: "head_agent", conversationId: this.callbacks.conversation.id },
        });
        const created = current.issues[current.issues.length - 1];
        if (created) {
          touchedIssues.push(created.id);
        }
      }
      return safeJson({
        boardId: current.board.id,
        message:
          "Mapped todo items onto orchestration board issues. Continue managing work with orchestration_* issue tools.",
        issueIds: touchedIssues,
      });
    }
    if (action === "list") {
      const snapshot = await this.callbacks.readSnapshot();
      const latest = [...(snapshot?.events ?? [])].reverse().find((event) => event.kind === "plan");
      return latest?.kind === "plan"
        ? latest.entries.map((entry) => `${entry.status}: ${entry.content}`).join("\n")
        : "No todos yet.";
    }
    const entries = items.flatMap((item, index) => {
      const record = asRecord(item);
      const content = asString(record?.content) ?? asString(item);
      if (!content) return [];
      const status: "pending" | "in_progress" | "completed" =
        record?.status === "completed" || record?.status === "in_progress"
          ? record.status
          : "pending";
      return [{ id: asString(record?.id) ?? `todo-${index + 1}`, content, status }];
    });
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "plan",
        planId: "cesium-todos",
        entries,
        raw: args,
      },
    ]);
    return `Stored ${entries.length} todo item${entries.length === 1 ? "" : "s"}.`;
  }

  private async toolAskQuestion(args: Record<string, unknown>): Promise<string> {
    const parseOptions = (value: unknown): Array<{ id: string; label: string }> =>
      Array.isArray(value)
        ? value.flatMap((option, index) => {
            const record = asRecord(option);
            const label = asString(record?.label) ?? asString(record?.text) ?? asString(option);
            if (!label) return [];
            return [{ id: asString(record?.id) ?? `option-${index + 1}`, label }];
          })
        : [];
    const questionsFromArgs = Array.isArray(args.questions)
      ? args.questions.flatMap((question, index): CesiumQuestionStep[] => {
          const record = asRecord(question);
          if (!record) return [];
          const prompt = asString(record.prompt) ?? asString(record.title);
          const options = parseOptions(record.options);
          if (!prompt || options.length === 0) return [];
          return [
            {
              id: asString(record.id) ?? `question-${index + 1}`,
              prompt,
              options,
              allowMultiple: record.allowMultiple === true || record.allow_multiple === true,
            },
          ];
        })
      : [];
    const prompt = asString(args.prompt) ?? (questionsFromArgs.length > 1 ? "Questions" : questionsFromArgs[0]?.prompt);
    const options = parseOptions(args.options);
    const allowMultiple = args.allowMultiple === true || args.allow_multiple === true;
    const questions =
      questionsFromArgs.length > 0
        ? questionsFromArgs
        : prompt && options.length > 0
          ? [{ id: "single", prompt, options, allowMultiple }]
          : [];
    if (!prompt || questions.length === 0) {
      throw new Error("ask_question requires either prompt/options or a non-empty questions array.");
    }
    const primaryOptions = questions[0]?.options ?? options;
    const primaryAllowMultiple = questions.length === 1 ? Boolean(questions[0]?.allowMultiple) : false;
    const questionId = randomUUID();
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "question",
        questionId,
        prompt,
        options: primaryOptions,
        questions,
        allowMultiple: primaryAllowMultiple,
        status: "pending",
        raw: args,
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "awaiting_question",
        detail: prompt,
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "awaiting_question",
      pendingQuestion: {
        questionId,
        requestedAt: Date.now(),
      },
    }));
    const answer = await new Promise<string>((resolve, reject) => {
      this.pendingQuestions.set(questionId, {
        resolve,
        reject,
        prompt,
        options: primaryOptions,
        questions,
        allowMultiple: primaryAllowMultiple,
        raw: args,
      });
    });
    return `User answer:\n${answer}`;
  }

  private async toolCallMcp(
    args: Record<string, unknown>,
    toolCallId: string,
    title: string
  ): Promise<string> {
    const serverId = asString(args.serverId);
    const toolName = asString(args.toolName);
    if (!serverId || !toolName) {
      throw new Error("call_mcp_tool requires serverId and toolName.");
    }
    if (serverId === BROWSER_MCP_SERVER_ID && this.isOrchestrationMode()) {
      throw new Error("Browser MCP tools are only available to normal Cesium Agent conversations.");
    }
    const toolArgs =
      args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
        ? (args.arguments as Record<string, unknown>)
        : {};
    await this.requirePermission({
      toolCallId,
      title,
      detail: `${serverId} - ${toolName}\n${JSON.stringify(toolArgs)}`,
      permission: "mcpCall",
      toolKey: cesiumPermissionToolKey("mcpCall", { serverId, toolName }),
      toolLabel: title,
    });
    return await callMcpTool({
      workspaceId: this.callbacks.workspace.id,
      workspaceRoot: this.callbacks.workspace.root,
      serverId,
      toolName,
      arguments: toolArgs,
    });
  }

  private async toolRefreshMcpServers(): Promise<string> {
    await refreshWorkspaceMcpMirror({
      workspaceId: this.callbacks.workspace.id,
      workspaceRoot: this.callbacks.workspace.root,
    });
    const summaries = await getMcpSummariesForPrompt(this.callbacks.workspace.id);
    if (this.isOrchestrationMode()) {
      const orchestrationSummaries = summaries.filter(
        (summary) => summary.id !== BROWSER_MCP_SERVER_ID
      );
      const board = await this.resolveCurrentOrchestrationBoard();
      const promptContext = await this.resolveSystemPromptContext(orchestrationSummaries);
      this.activeSystemPrompt = buildCesiumOrchestrationSystemPrompt({
        ...promptContext,
        workspaceRoot: this.callbacks.workspace.root,
        boardId: board?.board.id,
        maxConcurrentIssues: board?.board.settings.maxConcurrentIssues,
        maxConcurrentAgents: board?.board.settings.maxConcurrentAgents,
      });
    } else {
      this.activeSystemPrompt = buildCesiumSystemPrompt(
        await this.resolveSystemPromptContext(summaries)
      );
    }
    return `Refreshed ${summaries.length} MCP server mirror(s) under mcp-servers/.`;
  }

  private async resolveOrchestrationBoardFromArgs(args: Record<string, unknown>) {
    const boardId = asString(args.boardId);
    if (boardId) {
      const snapshot = await readOrchestrationBoardSnapshot(boardId);
      if (!snapshot || snapshot.board.workspaceId !== this.callbacks.workspace.id) {
        throw new Error(`Unknown orchestration board: ${boardId}`);
      }
      return snapshot;
    }
    const snapshot = await this.resolveCurrentOrchestrationBoard();
    if (!snapshot) {
      throw new Error("No orchestration board is linked to this head conversation.");
    }
    return snapshot;
  }

  private async toolOrchestrationBoardSnapshot(
    args: Record<string, unknown>
  ): Promise<string> {
    const snapshot = await this.resolveOrchestrationBoardFromArgs(args);
    return safeJson({
      board: snapshot.board,
      issues: snapshot.issues,
      assignments: snapshot.assignments,
      recentEvents: snapshot.events.slice(-30),
    });
  }

  private async toolOrchestrationCreateIssue(
    args: Record<string, unknown>
  ): Promise<string> {
    const current = await this.resolveOrchestrationBoardFromArgs(args);
    const title = asString(args.title);
    if (!title) {
      throw new Error("orchestration_create_issue.title is required.");
    }
    const snapshot = await createOrchestrationIssue({
      boardId: current.board.id,
      title,
      description: asString(args.description),
      columnId: asOrchestrationColumnId(args.columnId),
      priority: asOrchestrationPriority(args.priority),
      acceptanceCriteria: asStringArray(args.acceptanceCriteria),
      actor: { type: "head_agent", conversationId: this.callbacks.conversation.id },
    });
    const issue = snapshot.issues[snapshot.issues.length - 1];
    return safeJson({ issue, boardId: snapshot.board.id });
  }

  private async toolOrchestrationUpdateIssue(
    args: Record<string, unknown>
  ): Promise<string> {
    const current = await this.resolveOrchestrationBoardFromArgs(args);
    const issueId = asString(args.issueId);
    if (!issueId) {
      throw new Error("orchestration_update_issue.issueId is required.");
    }
    const columnId = asOrchestrationColumnId(args.columnId);
    const priority = asOrchestrationPriority(args.priority);
    const snapshot = await upsertOrchestrationIssue(
      current.board.id,
      {
        id: issueId,
        ...(asString(args.title) ? { title: asString(args.title)! } : {}),
        ...(typeof args.description === "string"
          ? { description: args.description }
          : {}),
        ...(columnId ? { columnId } : {}),
        ...(priority ? { priority } : {}),
        ...(Array.isArray(args.acceptanceCriteria)
          ? { acceptanceCriteria: asStringArray(args.acceptanceCriteria) }
          : {}),
        ...(typeof args.blockedReason === "string" || args.blockedReason === null
          ? { blockedReason: args.blockedReason }
          : {}),
      },
      { type: "head_agent", conversationId: this.callbacks.conversation.id }
    );
    return safeJson({
      issue: snapshot.issues.find((issue) => issue.id === issueId),
      boardId: snapshot.board.id,
    });
  }

  private async toolOrchestrationCommentIssue(
    args: Record<string, unknown>
  ): Promise<string> {
    const current = await this.resolveOrchestrationBoardFromArgs(args);
    const issueId = asString(args.issueId);
    const message = asString(args.message);
    if (!issueId || !message) {
      throw new Error("orchestration_comment_issue requires issueId and message.");
    }
    const snapshot = await addOrchestrationComment({
      boardId: current.board.id,
      issueId,
      message,
      actor: { type: "head_agent", conversationId: this.callbacks.conversation.id },
    });
    return safeJson({ boardId: snapshot.board.id, issueId, message });
  }

  private async toolOrchestrationDeleteIssue(args: Record<string, unknown>): Promise<string> {
    const current = await this.resolveOrchestrationBoardFromArgs(args);
    const issueId = asString(args.issueId);
    if (!issueId) {
      throw new Error("orchestration_delete_issue.issueId is required.");
    }
    const issue = current.issues.find((candidate) => candidate.id === issueId);
    if (!issue) {
      throw new Error(`Unknown orchestration issue: ${issueId}`);
    }
    const assignments = current.assignments.filter(
      (assignment) => assignment.issueId === issueId
    );
    const reason = asString(args.reason);
    const { agentRuntimeManager } = await import("./runtime-manager.js");
    await Promise.all(
      assignments.map((assignment) =>
        agentRuntimeManager
          .cancelConversation(this.callbacks.workspace, assignment.conversationId)
          .catch(() => undefined)
      )
    );
    const snapshot = await deleteOrchestrationIssue(
      current.board.id,
      issueId,
      { type: "head_agent", conversationId: this.callbacks.conversation.id }
    );
    return safeJson({
      boardId: snapshot.board.id,
      deletedIssue: issue,
      cancelledAssignments: assignments.map((assignment) => assignment.id),
      reason: reason ?? null,
    });
  }

  private async toolOrchestrationAssignAgent(
    args: Record<string, unknown>
  ): Promise<string> {
    const current = await this.resolveOrchestrationBoardFromArgs(args);
    const issueId = asString(args.issueId);
    const instructions = asString(args.instructions);
    if (!issueId || !instructions) {
      throw new Error("orchestration_assign_agent requires issueId and instructions.");
    }
    const issue = current.issues.find((candidate) => candidate.id === issueId);
    if (!issue) {
      throw new Error(`Unknown orchestration issue: ${issueId}`);
    }
    const backendId =
      (asString(args.backendId) as AgentBackendId | undefined) ??
      current.board.settings.defaultChildBackendId ??
      "cesium-agent";
    const modelId =
      asString(args.modelId) ??
      current.board.settings.defaultModelByBackend[backendId] ??
      (backendId === this.callbacks.conversation.config.backendId
        ? this.callbacks.conversation.config.modelId
        : undefined);
    const modelName =
      modelId === this.callbacks.conversation.config.modelId
        ? this.callbacks.conversation.config.modelName
        : undefined;
    const { agentRuntimeManager } = await import("./runtime-manager.js");
    const child = await agentRuntimeManager.createConversation(this.callbacks.workspace, {
      title: asString(args.title) ?? `Issue: ${issue.title}`,
      archived: true,
      backendId,
      mode: "agent",
      ...(modelId ? { modelId } : {}),
      ...(modelName ? { modelName } : {}),
    });
    const permissionPolicy = asOrchestrationPermissionPolicy(args.permissions);
    const assignment: OrchestrationAssignmentRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      boardId: current.board.id,
      issueId,
      conversationId: child.id,
      role: asString(args.role) ?? "implementation",
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      config: { ...child.config, permissionPolicy },
      lastKnownConversationStatus: child.status,
    };
    const promptText = [
      `You are assigned to Orchestration Mode issue "${issue.title}".`,
      "",
      issue.description ? `Description:\n${issue.description}` : "",
      issue.acceptanceCriteria.length
        ? `Acceptance criteria:\n${issue.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`
        : "",
      "",
      "Manager instructions:",
      instructions,
      "",
      "Work end-to-end, verify your result, and report blockers clearly.",
    ]
      .filter(Boolean)
      .join("\n");
    await upsertOrchestrationAssignment(
      current.board.id,
      assignment,
      { type: "head_agent", conversationId: this.callbacks.conversation.id }
    );
    void agentRuntimeManager
      .promptConversation(this.callbacks.workspace, child.id, promptText)
      .catch((error) => {
        console.warn("[orchestration] child prompt failed:", error);
      });
    return safeJson({ assignment, childConversation: child });
  }

  private async toolOrchestrationUpdateAgentPermissions(
    args: Record<string, unknown>
  ): Promise<string> {
    const current = await this.resolveCurrentOrchestrationBoard();
    const assignmentId = asString(args.assignmentId);
    const conversationId = asString(args.conversationId);
    if (!assignmentId && !conversationId) {
      throw new Error(
        "orchestration_update_agent_permissions requires assignmentId or conversationId."
      );
    }
    const assignment = current.assignments.find((candidate) =>
      assignmentId
        ? candidate.id === assignmentId
        : candidate.conversationId === conversationId
    );
    if (!assignment) {
      throw new Error(
        `Unknown orchestration assignment: ${assignmentId ?? conversationId}`
      );
    }
    const requestedPermissions = asRecord(args.permissions);
    const existingPolicy = assignment.config.permissionPolicy;
    const permissionPolicy: OrchestrationAssignmentPermissionPolicy = {
      editFile:
        asOrchestrationPermissionDecision(requestedPermissions?.editFile) ??
        existingPolicy?.editFile ??
        "allow",
      terminal:
        asOrchestrationPermissionDecision(requestedPermissions?.terminal) ??
        existingPolicy?.terminal ??
        "allow",
      mcpCall:
        asOrchestrationPermissionDecision(requestedPermissions?.mcpCall) ??
        existingPolicy?.mcpCall ??
        "allow",
    };
    const nextAssignment: OrchestrationAssignmentRecord = {
      ...assignment,
      config: {
        ...assignment.config,
        permissionPolicy,
      },
    };
    const snapshot = await upsertOrchestrationAssignment(
      current.board.id,
      nextAssignment,
      { type: "head_agent", conversationId: this.callbacks.conversation.id }
    );
    return safeJson({
      assignment: snapshot.assignments.find(
        (candidate) => candidate.id === assignment.id
      ),
    });
  }

  private async toolOrchestrationControlAgent(args: Record<string, unknown>): Promise<string> {
    const current = await this.resolveCurrentOrchestrationBoard();
    const action = asOrchestrationControlAction(args.action);
    if (!action) {
      throw new Error("orchestration_control_agent requires action.");
    }
    const assignmentId = asString(args.assignmentId);
    const conversationId = asString(args.conversationId);
    if (!assignmentId && !conversationId) {
      throw new Error("orchestration_control_agent requires assignmentId or conversationId.");
    }
    const assignment = current.assignments.find((candidate) =>
      assignmentId
        ? candidate.id === assignmentId
        : candidate.conversationId === conversationId
    );
    if (!assignment) {
      throw new Error(`Unknown orchestration assignment: ${assignmentId ?? conversationId}`);
    }
    const issue = current.issues.find((candidate) => candidate.id === assignment.issueId);
    const reason = asString(args.reason);
    const instructions = asString(args.instructions);
    const resumeAfterSteer = args.resumeAfterSteer === true;
    const { agentRuntimeManager } = await import("./runtime-manager.js");

    let nextAssignmentStatus: OrchestrationAssignmentStatus = assignment.status;
    let childConversationStatus: AgentConversationStatus | null =
      assignment.lastKnownConversationStatus;
    let message: string;

    switch (action) {
      case "pause": {
        const conversation = await agentRuntimeManager.pauseConversation(
          this.callbacks.workspace,
          assignment.conversationId
        );
        nextAssignmentStatus = "waiting";
        childConversationStatus = conversation.status;
        message = `Paused child agent ${assignment.conversationId}${
          reason ? `: ${reason}` : "."
        }`;
        break;
      }
      case "resume": {
        const conversation = await agentRuntimeManager.resumeConversation(
          this.callbacks.workspace,
          assignment.conversationId
        );
        nextAssignmentStatus = "running";
        childConversationStatus = conversation.status;
        message = `Resumed child agent ${assignment.conversationId}${
          reason ? `: ${reason}` : "."
        }`;
        break;
      }
      case "stop": {
        const conversation = await agentRuntimeManager.cancelConversation(
          this.callbacks.workspace,
          assignment.conversationId
        );
        nextAssignmentStatus = "cancelled";
        childConversationStatus = conversation.status;
        message = `Stopped child agent ${assignment.conversationId}${
          reason ? `: ${reason}` : "."
        }`;
        break;
      }
      case "steer": {
        if (!instructions) {
          throw new Error("orchestration_control_agent steer requires instructions.");
        }
        const steerText = [
          issue ? `Steering update for Orchestration Mode issue "${issue.title}".` : "Steering update.",
          reason ? `Reason: ${reason}` : "",
          "",
          instructions,
        ]
          .filter(Boolean)
          .join("\n");
        const snapshot = await agentRuntimeManager.promptConversation(
          this.callbacks.workspace,
          assignment.conversationId,
          steerText,
          undefined,
          { delivery: "steer" }
        );
        if (resumeAfterSteer) {
          try {
            const conversation = await agentRuntimeManager.resumeConversation(
              this.callbacks.workspace,
              assignment.conversationId
            );
            childConversationStatus = conversation.status;
            nextAssignmentStatus = "running";
          } catch {
            childConversationStatus = snapshot.conversation.status;
            nextAssignmentStatus =
              snapshot.conversation.status === "paused" ? "waiting" : "running";
          }
        } else {
          childConversationStatus = snapshot.conversation.status;
          nextAssignmentStatus =
            snapshot.conversation.status === "paused" ? "waiting" : "running";
        }
        message = `Steered child agent ${assignment.conversationId}${
          reason ? `: ${reason}` : "."
        }`;
        break;
      }
    }

    const commented = await addOrchestrationComment({
      boardId: current.board.id,
      issueId: assignment.issueId,
      actor: { type: "head_agent", conversationId: this.callbacks.conversation.id },
      message,
    });
    const updated = await upsertOrchestrationAssignment(
      current.board.id,
      {
        ...assignment,
        status: nextAssignmentStatus,
        lastKnownConversationStatus: childConversationStatus,
      },
      { type: "head_agent", conversationId: this.callbacks.conversation.id }
    );
    return safeJson({
      action,
      message,
      assignment:
        updated.assignments.find((candidate) => candidate.id === assignment.id) ??
        commented.assignments.find((candidate) => candidate.id === assignment.id) ??
        null,
    });
  }

  private async toolOrchestrationWait(args: Record<string, unknown>): Promise<string> {
    const timeoutMs = Math.max(1000, Math.floor(asNumber(args.timeoutMs) ?? ORCHESTRATION_WAIT_DEFAULT_MS));
    const pollMs = Math.max(
      1000,
      Math.min(
        ORCHESTRATION_WAIT_HEARTBEAT_MS,
        Math.floor(asNumber(args.pollMs) ?? 5000)
      )
    );
    const waitFor = asOrchestrationWaitFor(args.waitFor);
    const reason = asString(args.reason) ?? "No reason provided.";
    const issueId = asString(args.issueId);
    const assignmentId = asString(args.assignmentId);
    const conversationId = asString(args.conversationId);
    if (
      (waitFor === "issue_update" ||
        waitFor === "issue_comment" ||
        waitFor === "issue_done" ||
        waitFor === "all_issue_assignments_finished") &&
      !issueId
    ) {
      throw new Error(`orchestration_wait ${waitFor} requires issueId.`);
    }
    if (
      (waitFor === "assignment_update" ||
        waitFor === "assignment_status" ||
        waitFor === "assignment_finished") &&
      !assignmentId &&
      !conversationId
    ) {
      throw new Error(
        `orchestration_wait ${waitFor} requires assignmentId or conversationId.`
      );
    }
    const requestedStatuses = asOrchestrationAssignmentStatuses(args.statuses);
    const targetStatuses =
      requestedStatuses.length > 0
        ? requestedStatuses
        : ORCHESTRATION_ASSIGNMENT_TERMINAL_STATUSES;
    const initialSnapshot = await this.resolveCurrentOrchestrationBoard();
    const initialEventIds = new Set(initialSnapshot.events.map((event) => event.id));
    const initialAssignmentStatusById = new Map(
      initialSnapshot.assignments.map((assignment) => [assignment.id, assignment.status])
    );
    const initialIssue = issueId
      ? initialSnapshot.issues.find((issue) => issue.id === issueId)
      : undefined;
    const initialAssignment = initialSnapshot.assignments.find((assignment) =>
      assignmentId
        ? assignment.id === assignmentId
        : conversationId
          ? assignment.conversationId === conversationId
          : false
    );

    const evaluate = (snapshot: OrchestrationBoardSnapshot) => {
      const newEvents = snapshot.events.filter((event) => !initialEventIds.has(event.id));
      const assignment = snapshot.assignments.find((candidate) =>
        assignmentId
          ? candidate.id === assignmentId
          : conversationId
            ? candidate.conversationId === conversationId
            : false
      );
      const issue = issueId
        ? snapshot.issues.find((candidate) => candidate.id === issueId)
        : assignment
          ? snapshot.issues.find((candidate) => candidate.id === assignment.issueId)
          : undefined;
      const assignmentsForIssue = issueId
        ? snapshot.assignments.filter((candidate) => candidate.issueId === issueId)
        : snapshot.assignments;
      const relatedEvents = newEvents.filter((event) => {
        if (assignment && event.assignmentId === assignment.id) {
          return true;
        }
        if (issue && event.issueId === issue.id) {
          return true;
        }
        return false;
      });

      switch (waitFor) {
        case "issue_update":
          return {
            matched:
              Boolean(issue && initialIssue && issue.updatedAt > initialIssue.updatedAt) ||
              relatedEvents.some((event) => event.issueId === issue?.id),
            matchedEvents: relatedEvents,
            issue,
            assignment,
          };
        case "issue_comment":
          return {
            matched: relatedEvents.some((event) => event.kind === "comment_added"),
            matchedEvents: relatedEvents.filter((event) => event.kind === "comment_added"),
            issue,
            assignment,
          };
        case "issue_done":
          return {
            matched: issue?.columnId === "done",
            matchedEvents: relatedEvents,
            issue,
            assignment,
          };
        case "assignment_update":
          return {
            matched:
              Boolean(
                assignment &&
                  initialAssignment &&
                  (assignment.updatedAt > initialAssignment.updatedAt ||
                    assignment.status !== initialAssignment.status)
              ) || relatedEvents.some((event) => event.assignmentId === assignment?.id),
            matchedEvents: relatedEvents,
            issue,
            assignment,
          };
        case "assignment_status":
          return {
            matched: Boolean(assignment && targetStatuses.includes(assignment.status)),
            matchedEvents: relatedEvents,
            issue,
            assignment,
          };
        case "assignment_finished":
          return {
            matched: Boolean(
              assignment &&
                ORCHESTRATION_ASSIGNMENT_TERMINAL_STATUSES.includes(assignment.status)
            ),
            matchedEvents: relatedEvents,
            issue,
            assignment,
          };
        case "any_assignment_finished": {
          const matchedAssignment = assignmentsForIssue.find((candidate) => {
            if (!ORCHESTRATION_ASSIGNMENT_TERMINAL_STATUSES.includes(candidate.status)) {
              return false;
            }
            const initialStatus = initialAssignmentStatusById.get(candidate.id);
            return (
              !initialStatus ||
              !ORCHESTRATION_ASSIGNMENT_TERMINAL_STATUSES.includes(initialStatus)
            );
          });
          return {
            matched: Boolean(matchedAssignment),
            matchedEvents: newEvents.filter(
              (event) => event.assignmentId === matchedAssignment?.id
            ),
            issue: matchedAssignment
              ? snapshot.issues.find((candidate) => candidate.id === matchedAssignment.issueId)
              : issue,
            assignment: matchedAssignment,
          };
        }
        case "all_issue_assignments_finished":
          return {
            matched:
              assignmentsForIssue.length > 0 &&
              assignmentsForIssue.every((candidate) =>
                ORCHESTRATION_ASSIGNMENT_TERMINAL_STATUSES.includes(candidate.status)
              ),
            matchedEvents: newEvents.filter((event) => event.issueId === issueId),
            issue,
            assignment,
          };
        case "board_update":
        default:
          return {
            matched:
              snapshot.board.updatedAt > initialSnapshot.board.updatedAt ||
              newEvents.length > 0,
            matchedEvents: newEvents,
            issue,
            assignment,
          };
      }
    };

    let elapsedMs = 0;
    let statusElapsedMs = 0;
    let snapshot = initialSnapshot;
    while (elapsedMs < timeoutMs) {
      if (this.cancelled || this.disposed) {
        throw new Error("Orchestration wait interrupted.");
      }
      const immediate = evaluate(snapshot);
      if (immediate.matched) {
        return safeJson({
          conditionMet: true,
          waitedMs: elapsedMs,
          waitFor,
          reason,
          issue: immediate.issue ?? null,
          assignment: immediate.assignment ?? null,
          matchedEvents: immediate.matchedEvents.slice(-10),
          boardUpdatedAt: snapshot.board.updatedAt,
        });
      }
      const chunkMs = Math.min(pollMs, timeoutMs - elapsedMs);
      await new Promise((resolve) => setTimeout(resolve, chunkMs));
      elapsedMs += chunkMs;
      statusElapsedMs += chunkMs;
      snapshot = await this.resolveCurrentOrchestrationBoard();
      if (statusElapsedMs >= ORCHESTRATION_WAIT_HEARTBEAT_MS || elapsedMs >= timeoutMs) {
        statusElapsedMs = 0;
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "status",
            status: "running",
            detail: `Waiting for ${waitFor} (${Math.round(elapsedMs / 1000)}s / ${Math.round(timeoutMs / 1000)}s): ${reason}`,
          },
        ]);
      }
    }
    const final = evaluate(snapshot);
    return safeJson({
      conditionMet: final.matched,
      waitedMs: timeoutMs,
      waitFor,
      reason,
      issue: final.issue ?? null,
      assignment: final.assignment ?? null,
      matchedEvents: final.matchedEvents.slice(-10),
      boardUpdatedAt: snapshot.board.updatedAt,
      recentEvents: snapshot.events.slice(-10),
    });
  }

  private async toolSubagent(args: Record<string, unknown>): Promise<string> {
    const instructions = asString(args.instructions);
    if (!instructions) throw new Error("subagent.instructions is required.");
    const subagentId = randomUUID();
    const title = asString(args.title) ?? "Cesium subagent";
    const modelId =
      asString(args.modelId) ||
      resolvedModelId(this.callbacks.conversation.config.modelId, this.configOptions);
    const transcript: AgentStoredEvent[] = [
      {
        seq: 0,
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        createdAt: Date.now(),
        kind: "user_message",
        messageId: randomUUID(),
        content: instructions,
      },
    ];
    let status: "completed" | "failed" = "completed";
    let resultText = "";
    try {
      const subagentProviderId = providerPart(modelId);
      const auth = await resolveCesiumAuth({
        modelId,
        configuredApiKind:
          subagentProviderId === "openai"
            ? (optionValue(this.configOptions, "api_kind", "openai-responses") as CesiumProviderKind)
            : undefined,
      });
      const result = await runAdapter({
        apiKind: auth.apiKind,
        apiKey: auth.apiKey,
        baseUrl: auth.baseUrl,
        providerId: auth.providerId,
        modelId,
        messages: [
          { role: "system", content: `${CESIUM_SYSTEM_PROMPT}\n\nYou are a child subagent. Do not spawn additional subagents.` },
          { role: "user", content: instructions },
        ],
      });
      resultText =
        result.text.trim() ||
        (result.toolRequests.length > 0
          ? `Subagent requested unsupported child tools: ${result.toolRequests.map((tool) => tool.name).join(", ")}`
          : "Subagent completed without visible text.");
    } catch (error) {
      status = "failed";
      resultText = error instanceof Error ? error.message : String(error);
    }
    transcript.push(
      {
        seq: 0,
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        createdAt: Date.now(),
        kind: "assistant_message_chunk",
        messageId: randomUUID(),
        text: resultText,
      }
    );
    this.subagentTranscripts.set(subagentId, transcript);
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "subagent",
        subagentId,
        title,
        status,
        transcript,
        recentActivity: resultText.slice(0, 240),
        raw: args,
      },
    ]);
    return `Subagent ${subagentId} ${status}: ${resultText}`;
  }

  private toolReadSubagentTranscript(args: Record<string, unknown>): string {
    const subagentId = asString(args.subagentId);
    if (!subagentId) throw new Error("read_subagent_transcript.subagentId is required.");
    const transcript = this.subagentTranscripts.get(subagentId);
    if (!transcript) return `No transcript found for ${subagentId}.`;
    const offset = Math.max(0, Math.floor(asNumber(args.offset) ?? 0));
    const limit = Math.max(1, Math.min(200, Math.floor(asNumber(args.limit) ?? 50)));
    return transcript.slice(offset, offset + limit).map((event) => `${event.kind}: ${safeJson(event)}`).join("\n");
  }

  private async toolSearchHistory(args: Record<string, unknown>): Promise<string> {
    const query = asString(args.query);
    if (!query) throw new Error("search_history.query is required.");
    const maxResults = Math.max(1, Math.min(50, Math.floor(asNumber(args.maxResults) ?? 10)));
    const snapshot = await this.callbacks.readSnapshot();
    const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const matches = (snapshot?.events ?? [])
      .filter((event) => regex.test(safeJson(event)))
      .slice(-maxResults);
    return matches.length ? matches.map((event) => `seq ${event.seq} ${event.kind}: ${safeJson(event)}`).join("\n\n") : "No history matches.";
  }

  private async toolReadHistoryPage(args: Record<string, unknown>): Promise<string> {
    const beforeSeq = Math.floor(asNumber(args.beforeSeq) ?? Number.MAX_SAFE_INTEGER);
    const limitTurns = Math.max(1, Math.min(250, Math.floor(asNumber(args.limitTurns) ?? 25)));
    const snapshot = await this.callbacks.readSnapshot();
    const events = (snapshot?.events ?? []).filter((event) => event.seq < beforeSeq);
    let users = 0;
    let start = 0;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]!.kind === "user_message") {
        users += 1;
        start = index;
        if (users >= limitTurns) break;
      }
    }
    return events.slice(start).map((event) => `seq ${event.seq} ${event.kind}: ${safeJson(event)}`).join("\n");
  }
}

export async function createCesiumAgentProvider(input: {
  backend: AgentBackendInfo;
  configOptions?: AgentConfigOption[];
}): Promise<AgentProvider> {
  const configOptions = input.configOptions?.length
    ? input.configOptions
    : await createCesiumAgentConfigOptions();
  return {
    backend: input.backend,
    async startSession(callbacks: AgentRuntimeCallbacks) {
      const handle = new CesiumSessionHandle(input.backend, callbacks, configOptions);
      await handle.initialize();
      return handle;
    },
    async loadSession(callbacks: AgentRuntimeCallbacks, providerSessionId: string) {
      const handle = new CesiumSessionHandle(input.backend, callbacks, configOptions, providerSessionId);
      await handle.initialize();
      return handle;
    },
  };
}
