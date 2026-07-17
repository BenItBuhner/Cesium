import { BROWSER_MCP_SERVER_ID } from "../../mcp/builtin-browser-tools.js";
import {
  defaultHarnessSettings,
  resolveCesiumHarness,
  type CesiumHarnessSettings,
  type CesiumToolDefinition,
  type ResolvedCesiumHarness,
} from "./features/index.js";
import { asRecord, asString, parseJsonArgs, pickFirstString } from "./cesium-coerce.js";
import { WAIT_MAX_SECONDS } from "./cesium-prompt.js";
import type { CesiumToolRequest } from "./cesium-types.js";

export type { CesiumToolDefinition, ResolvedCesiumHarness };

export type ParsedWaitToolArgs = {
  seconds: number;
  durationMs: number;
  reason: string;
  capped: boolean;
};

/** Normalize and validate timed `wait` tool arguments. */
export function parseWaitToolArgs(
  args: Record<string, unknown>,
  maxSeconds: number = WAIT_MAX_SECONDS
): ParsedWaitToolArgs {
  const raw =
    typeof args.seconds === "number"
      ? args.seconds
      : typeof args.seconds === "string"
        ? Number(args.seconds)
        : Number.NaN;
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error("wait.seconds must be a positive number.");
  }
  const cap =
    Number.isFinite(maxSeconds) && maxSeconds > 0
      ? Math.min(WAIT_MAX_SECONDS, Math.floor(maxSeconds))
      : WAIT_MAX_SECONDS;
  const capped = raw > cap;
  const seconds = capped ? cap : raw;
  return {
    seconds,
    durationMs: Math.max(1, Math.round(seconds * 1000)),
    reason: asString(args.reason)?.trim() || "Timed wait.",
    capped,
  };
}

export function formatWaitDurationLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0s";
  }
  if (seconds < 60) {
    const rounded = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1).replace(/\.0$/, "");
    return `${rounded}s`;
  }
  const totalSeconds = Math.round(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) {
    if (minutes === 0 && secs === 0) return `${hours}h`;
    if (secs === 0) return `${hours}h ${minutes}m`;
    return `${hours}h ${minutes}m ${secs}s`;
  }
  if (secs === 0) return `${minutes}m`;
  return `${minutes}m ${secs}s`;
}

/** Core tools always present; versioned feature modules (subagents v1/v2) are layered on top. */
const CESIUM_BASE_TOOLS: CesiumToolDefinition[] = [
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
    name: "wait",
    description:
      "Pause this agent for a fixed number of seconds before continuing. Use for timed delays (seconds, minutes, or hours) when you do not need to poll terminals, spawn subagents, or wait on orchestration board conditions. Prefer this over shell sleep. Cancel stops the wait early.",
    parameters: {
      type: "object",
      properties: {
        seconds: {
          type: "number",
          description:
            "How long to wait. Fractional values are allowed (e.g. 0.5). Large values are fine for multi-minute or multi-hour delays (capped at 24 hours).",
        },
        reason: {
          type: "string",
          description: "Optional short reason shown in status heartbeats while waiting.",
        },
      },
      required: ["seconds"],
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
        items: {
          type: "array",
          description:
            "Todo items. Each item may use content, title, text, or description plus status pending/in_progress/blocked/completed. Use blocked only when progress cannot continue without removing a material blocker.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "create_plan",
    description:
      "Create a reviewable Plan-mode markdown file under .cesium/plans/. Use markdown checkboxes for implementation tasks.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        path: { type: "string" },
      },
      required: ["title", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "update_plan",
    description:
      "Overwrite an existing .cesium/plans/*.plan.md file and refresh its structured checklist projection.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "read_plan",
    description: "Read a .cesium/plans/*.plan.md file and return its markdown plus parsed checklist entries.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "finalize_plan",
    description:
      "Mark a plan file ready for user review. Emits a plan_file card and structured checklist without changing code.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "burn_goal_set",
    description:
      "Set or refresh the active Burn goal state. Use this to record the objective, current plan summary, compact milestones/todos, and verification evidence before or during execution.",
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string" },
        planSummary: { type: "string" },
        milestones: { type: "array" },
        todos: { type: "array" },
        verificationEvidence: { type: "array" },
        progressPercent: { type: "integer", minimum: 0, maximum: 100 },
        headline: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "burn_goal_pause",
    description:
      "Pause the active Burn goal without marking it blocked or complete. Use when the user asks to pause or when the turn should stop cleanly with remaining work.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "burn_goal_block",
    description:
      "Record a blocker. The goal is marked blocked only after the same blocker recurs across at least three Burn turns unless a hard external impossibility is proven.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string" },
        evidence: { type: "string" },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    name: "burn_goal_summarize",
    description:
      "Persist a structured Burn progress snapshot after meaningful progress, blocker resolution, before pausing, before completing, or when the latest summary is missing/stale. Do not call this every turn; after summarizing, continue working if the Burn goal is not complete. The summary must use ## Progress, ## Current State, ## Blockers, and ## Next Steps sections with bullet items.",
    parameters: {
      type: "object",
      properties: {
        progressPercent: { type: "integer", minimum: 0, maximum: 100 },
        summary: { type: "string" },
        headline: { type: "string" },
      },
      required: ["progressPercent", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "burn_goal_complete",
    description:
      "Mark the Burn goal complete only after every requirement has been audited and current evidence proves the objective is satisfied.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "workflow_run",
    description:
      "Compile and execute a Workflow mode JavaScript orchestration script. The script MUST begin with `export const meta = { name, description, phases }` (pure literal) and may use agent()/parallel()/pipeline()/phase()/log()/budget/args. Prefer wait=true so the tool returns the final script value. Intermediate agent results stay in script variables, not the parent transcript.",
    parameters: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description:
            "Self-contained workflow script beginning with export const meta = { name, description, phases }.",
        },
        scriptPath: {
          type: "string",
          description:
            "Path to a previously persisted workflow script. Takes precedence over script when provided.",
        },
        name: {
          type: "string",
          description: "Optional display name override (meta.name still required in the script).",
        },
        args: {
          description:
            "Optional input exposed to the script as the global args. Pass real JSON values, not stringified JSON.",
        },
        tokenBudget: {
          type: "integer",
          minimum: 0,
          description: "Optional hard token ceiling for this run. budget.remaining() is Infinity when omitted.",
        },
        maxAgents: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Optional agent() call cap for this run (default 50).",
        },
        maxConcurrent: {
          type: "integer",
          minimum: 1,
          maximum: 16,
          description: "Optional concurrent agent() cap (default 8, also bounded by CPU count).",
        },
        resumeFromRunId: {
          type: "string",
          description:
            "Prior run id whose completed agent() calls are reused when prompt+opts are unchanged.",
        },
        wait: {
          type: "boolean",
          description: "When true (default), wait for the workflow to finish and return the result.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "workflow_status",
    description:
      "Read the status of a Workflow mode run (phase, agents used, logs, return value). Defaults to the latest run for this conversation when runId is omitted.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "workflow_await",
    description:
      "Wait for a Workflow mode run to reach a terminal state and return its result summary.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
      },
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
    name: "orchestration_read_agent_transcript",
    description:
      "Read the transcript of a kanban child agent assigned via orchestration_assign_agent. Use assignmentId or conversationId from orchestration_board_snapshot.",
    parameters: {
      type: "object",
      properties: {
        boardId: { type: "string" },
        assignmentId: { type: "string" },
        conversationId: { type: "string" },
        beforeSeq: { type: "number" },
        limitEvents: { type: "number" },
        limitTurns: { type: "number" },
      },
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

export function resolveCesiumTools(
  harness?: CesiumHarnessSettings | unknown
): ResolvedCesiumHarness {
  return resolveCesiumHarness(CESIUM_BASE_TOOLS, harness ?? defaultHarnessSettings());
}

/** @deprecated Prefer resolveCesiumTools(harness).tools — kept for tests expecting a flat default list. */
function defaultCesiumTools(): CesiumToolDefinition[] {
  return resolveCesiumTools().tools;
}

export function buildOpenAiToolDefinitions(tools?: CesiumToolDefinition[]) {
  const list = tools ?? defaultCesiumTools();
  return list.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: sanitizeOpenAiCompatibleJsonSchema(tool.parameters),
    },
  }));
}

export function openAiTools(tools?: CesiumToolDefinition[]) {
  return buildOpenAiToolDefinitions(tools);
}

export function responseTools(tools?: CesiumToolDefinition[]) {
  const list = tools ?? defaultCesiumTools();
  return list.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export function anthropicTools(tools?: CesiumToolDefinition[]) {
  const list = tools ?? defaultCesiumTools();
  return list.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

export function googleTools(tools?: CesiumToolDefinition[]) {
  const list = tools ?? defaultCesiumTools();
  return [
    {
      functionDeclarations: list.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.parameters,
      })),
    },
  ];
}

export function toolKind(name: string): string {
  switch (name) {
    case "read_file":
      return "read";
    case "edit_file":
      return "edit";
    case "terminal":
      return "terminal";
    case "wait":
      return "wait";
    case "grep":
      return "grep";
    case "todo":
    case "create_plan":
    case "update_plan":
    case "read_plan":
    case "finalize_plan":
      return "todo";
    case "burn_goal_set":
    case "burn_goal_pause":
    case "burn_goal_summarize":
    case "burn_goal_get":
    case "burn_goal_update_plan":
    case "burn_goal_update_progress":
    case "burn_goal_summarize_state":
    case "burn_goal_complete":
    case "burn_goal_block":
    case "burn_goal_resume":
      return "burn";
    case "workflow_run":
    case "workflow_status":
    case "workflow_await":
      return "workflow";
    case "ask_question":
      return "question";
    case "subagent":
    case "spawn_agent":
    case "send_message":
    case "followup_task":
    case "wait_agent":
    case "interrupt_agent":
    case "list_agents":
    case "read_subagent_transcript":
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

export function permissionDecisionFromOption(optionId: string | undefined): "allow" | "reject" {
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

export function toolTitle(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "read_file":
      return `Read ${asString(args.path) ?? "file"}`;
    case "edit_file":
      return `Edit ${asString(args.path) ?? "file"}`;
    case "terminal":
      return `Run ${asString(args.command) ?? "command"}`;
    case "wait": {
      const seconds = typeof args.seconds === "number" ? args.seconds : Number(args.seconds);
      const reason = asString(args.reason);
      if (Number.isFinite(seconds) && seconds > 0) {
        const label = formatWaitDurationLabel(seconds);
        return reason ? `Wait ${label}: ${reason}` : `Wait ${label}`;
      }
      return reason ? `Wait: ${reason}` : "Wait";
    }
    case "grep":
      return `Grep ${asString(args.pattern) ?? "workspace"}`;
    case "todo":
      return "Update todos";
    case "create_plan":
      return `Create plan ${asString(args.title) ?? ""}`.trim();
    case "update_plan":
      return `Update plan ${asString(args.path) ?? ""}`.trim();
    case "read_plan":
      return `Read plan ${asString(args.path) ?? ""}`.trim();
    case "finalize_plan":
      return `Finalize plan ${asString(args.path) ?? ""}`.trim();
    case "burn_goal_set":
      return "Set Burn goal";
    case "burn_goal_pause":
      return "Pause Burn goal";
    case "burn_goal_summarize":
      return "Summarize Burn goal";
    case "burn_goal_get":
      return "Read Burn goal";
    case "burn_goal_update_plan":
      return "Record Burn plan";
    case "burn_goal_update_progress":
      return "Update Burn progress";
    case "burn_goal_summarize_state":
      return "Summarize Burn state";
    case "burn_goal_complete":
      return "Complete Burn goal";
    case "burn_goal_block":
      return "Record Burn blocker";
    case "burn_goal_resume":
      return "Resume Burn goal";
    case "workflow_run":
      return `Run workflow ${asString(args.name) ?? ""}`.trim();
    case "workflow_status":
      return `Workflow status ${asString(args.runId) ?? ""}`.trim();
    case "workflow_await":
      return `Await workflow ${asString(args.runId) ?? ""}`.trim();
    case "ask_question":
      return "Ask question";
    case "subagent":
      return `Subagent ${asString(args.title) ?? ""}`.trim();
    case "spawn_agent":
      return `Spawn agent ${asString(args.task_name) ?? asString(args.taskName) ?? ""}`.trim();
    case "send_message":
      return `Message agent ${asString(args.target) ?? ""}`.trim();
    case "followup_task":
      return `Follow up ${asString(args.target) ?? ""}`.trim();
    case "wait_agent":
      return "Wait for agents";
    case "interrupt_agent":
      return `Interrupt ${asString(args.target) ?? ""}`.trim();
    case "list_agents":
      return "List agents";
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
    case "orchestration_read_agent_transcript":
      return `Read agent transcript ${asString(args.assignmentId) ?? asString(args.conversationId) ?? ""}`.trim();
    case "orchestration_wait":
      return "Wait for orchestration changes";
    default:
      return name;
  }
}

const CALL_MCP_SERVER_ID_KEYS = [
  "serverId",
  "server_id",
  "server",
  "mcpServerId",
  "mcp_server_id",
] as const;

const CALL_MCP_TOOL_NAME_KEYS = [
  "toolName",
  "tool_name",
  "tool",
  "mcpTool",
  "mcp_tool",
] as const;

function omitCallMcpRoutingFields(record: Record<string, unknown>): Record<string, unknown> {
  const next = { ...record };
  for (const key of [
    ...CALL_MCP_SERVER_ID_KEYS,
    ...CALL_MCP_TOOL_NAME_KEYS,
    "arguments",
  ]) {
    delete next[key];
  }
  return next;
}

export type NormalizedCallMcpToolArgs = {
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
};

/** Accept common LLM/provider shapes for call_mcp_tool routing and MCP tool args. */
export function normalizeCallMcpToolArgs(raw: Record<string, unknown>): NormalizedCallMcpToolArgs {
  const nested = asRecord(raw.arguments);
  const rawServerId =
    pickFirstString(raw, CALL_MCP_SERVER_ID_KEYS) ??
    pickFirstString(nested, CALL_MCP_SERVER_ID_KEYS) ??
    "";
  const serverId = rawServerId.toLowerCase() === BROWSER_MCP_SERVER_ID ? BROWSER_MCP_SERVER_ID : rawServerId;
  const toolName =
    pickFirstString(raw, CALL_MCP_TOOL_NAME_KEYS) ??
    pickFirstString(nested, CALL_MCP_TOOL_NAME_KEYS) ??
    "";

  let toolArgs: Record<string, unknown> = {};
  if (nested) {
    const nestedServerId = pickFirstString(nested, CALL_MCP_SERVER_ID_KEYS);
    const nestedToolName = pickFirstString(nested, CALL_MCP_TOOL_NAME_KEYS);
    if (nestedServerId || nestedToolName) {
      toolArgs = omitCallMcpRoutingFields(nested);
    } else if (Object.keys(nested).length > 0) {
      toolArgs = nested;
    }
  }
  if (Object.keys(toolArgs).length === 0) {
    toolArgs = omitCallMcpRoutingFields(raw);
  }

  return { serverId, toolName, arguments: toolArgs };
}

function callMcpToolArgsToRecord(normalized: NormalizedCallMcpToolArgs): Record<string, unknown> {
  return {
    serverId: normalized.serverId,
    toolName: normalized.toolName,
    arguments: normalized.arguments,
  };
}

export function normalizeCesiumToolRequestArguments(
  name: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (name !== "call_mcp_tool") {
    return args;
  }
  return callMcpToolArgsToRecord(normalizeCallMcpToolArgs(args));
}

export function createCesiumToolRequest(
  id: string,
  name: string,
  args: Record<string, unknown>
): CesiumToolRequest {
  return {
    id,
    name,
    arguments: normalizeCesiumToolRequestArguments(name, args),
  };
}

export function inferCesiumToolNameFromTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^refresh mcp servers$/i.test(trimmed)) {
    return "refresh_mcp_servers";
  }
  if (/^(MCP|Browser)\s+/i.test(trimmed)) {
    return "call_mcp_tool";
  }
  return undefined;
}

export function serializeToolCallArguments(
  name: string,
  args: unknown,
  detail?: string | null
): string {
  const parsed =
    typeof args === "string"
      ? parseJsonArgs(args)
      : asRecord(args) ?? {};
  const normalizedArgs =
    name === "call_mcp_tool"
      ? callMcpToolArgsToRecord(normalizeCallMcpToolArgs(parsed))
      : parsed;
  if (Object.keys(normalizedArgs).length > 0) {
    return JSON.stringify(normalizedArgs);
  }
  if (name === "call_mcp_tool" && detail?.trim()) {
    const fromDetail = normalizeCallMcpToolArgs(parseJsonArgs(detail));
    if (fromDetail.serverId && fromDetail.toolName) {
      return JSON.stringify(callMcpToolArgsToRecord(fromDetail));
    }
  }
  if (detail?.trim()) {
    const fromDetail = asRecord(parseJsonArgs(detail)) ?? {};
    if (Object.keys(fromDetail).length > 0) {
      return JSON.stringify(fromDetail);
    }
  }
  return "{}";
}
