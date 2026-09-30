import {
  CESIUM_SHARED_TOOL_DEFINITIONS,
  normalizeCesiumToolRequestArguments,
} from "@cesium/core/cesium-tools";
import { formatMcpToolDisplayName } from "@cesium/core/mcp";
import { BROWSER_MCP_SERVER_ID } from "../../mcp/builtin-browser-tools.js";
import { ARTIFACTS_MCP_SERVER_ID } from "../../mcp/builtin-artifact-tools.js";
import type { AgentPermissionCategory } from "../types.js";
import { permissionDecisionFromOption as sharedPermissionDecisionFromOption } from "../permission-options.js";
import {
  defaultHarnessSettings,
  resolveCesiumHarness,
  type CesiumHarnessSettings,
  type CesiumToolDefinition,
  type ResolvedCesiumHarness,
} from "./features/index.js";
import { asString } from "./cesium-coerce.js";
import { GLOB_DEFAULT_RESULTS, GLOB_MAX_RESULTS } from "./cesium-glob.js";
import { WAIT_MAX_SECONDS } from "./cesium-prompt.js";
import type { CesiumToolRequest } from "./cesium-types.js";

export {
  inferCesiumToolNameFromTitle,
  normalizeCallMcpToolArgs,
  normalizeCesiumToolRequestArguments,
  serializeToolCallArguments,
  type NormalizedCallMcpToolArgs,
} from "@cesium/core/cesium-tools";

export type { CesiumToolDefinition, ResolvedCesiumHarness };

/** Canonicalize pre-Goal tool names from persisted transcripts and older clients. */
export function normalizeCesiumToolName(name: string): string {
  return name.startsWith("burn_goal_")
    ? `goal_${name.slice("burn_goal_".length)}`
    : name;
}

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
  CESIUM_SHARED_TOOL_DEFINITIONS.read_file,
  CESIUM_SHARED_TOOL_DEFINITIONS.grep,
  {
    name: "glob",
    description:
      "Find workspace files and directories by glob pattern, or list a directory. Returns workspace-relative paths (directories end with \"/\"), sorted, skipping .git, node_modules, .next, and .docker. Examples: pattern \"*\" lists one directory; \"src/**/*.ts\" finds files recursively; \"**/*.{test,spec}.ts\" matches alternatives. Read-only; use grep to search file contents.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Glob relative to path. Supports *, **, ?, {a,b}, and [...]. Use \"*\" to list the directory's immediate children.",
        },
        path: {
          type: "string",
          description: "Directory to search under, relative to the workspace root. Defaults to the root.",
        },
        maxResults: {
          type: "number",
          description: `Maximum entries to return (default ${GLOB_DEFAULT_RESULTS}, max ${GLOB_MAX_RESULTS}).`,
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  CESIUM_SHARED_TOOL_DEFINITIONS.write_file,
  CESIUM_SHARED_TOOL_DEFINITIONS.edit_file,
  CESIUM_SHARED_TOOL_DEFINITIONS.terminal,
  {
    name: "terminal_read",
    description:
      "Read the output and status (running, exit code) of a command started with terminal, by its id. Works after the terminal call returned, after the command finished, and across server restarts. Pass since from the previous read to get only newer output. Read-only.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Run id returned by terminal." },
        since: {
          type: "number",
          description: "Byte offset to read from, as reported by the previous terminal_read. Omit to read from the start.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "terminal_kill",
    description:
      "Stop a command started with terminal, by its id: SIGTERM to its whole process group (so servers it spawned stop too), then SIGKILL after a short grace period.",
    requiresPermission: "terminal",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Run id returned by terminal." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  CESIUM_SHARED_TOOL_DEFINITIONS.wait,
  CESIUM_SHARED_TOOL_DEFINITIONS.todo,
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
    name: "goal_set",
    description:
      "Set or refresh canonical state for this conversation's Goal, creating it when none exists. Use this to record the objective, current plan summary, compact milestones/todos, and verification evidence before or during execution.",
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
        tokenBudget: {
          type: "integer",
          minimum: 0,
          description:
            "Optional token ceiling for the whole Goal (input plus output, as the provider reports it). The Goal stops as budget_limited when it is used up; 0 removes the ceiling.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "goal_pause",
    description:
      "Pause the active Goal without marking it blocked or complete. Use when the user asks to pause or when the turn should stop cleanly with remaining work.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "goal_resume",
    description:
      "Resume a paused Goal so work on it continues. Use when the user asks to resume, or when the reason for the pause no longer applies.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "goal_block",
    description:
      "Record a blocker. The goal is marked blocked only after the same blocker recurs across at least three Goal turns unless a hard external impossibility is proven.",
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
    name: "goal_summarize",
    description:
      "Persist a structured Goal progress snapshot after meaningful progress, blocker resolution, before pausing, before completing, or when the latest summary is missing/stale. Do not call this every turn; after summarizing, continue working if the Goal is not complete. The summary must use ## Progress, ## Current State, ## Blockers, and ## Next Steps sections with bullet items.",
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
    name: "goal_complete",
    description:
      "Mark the Goal complete only after every requirement has been audited and current evidence proves the objective is satisfied.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "workflow_run",
    description:
      "Compile and execute a JavaScript orchestration workflow. Use it dynamically for meaningful fan-out, repeated item processing, or staged verification. The script MUST begin with `export const meta = { name, description, phases }` (pure literal). After that declaration, write top-level workflow statements and `return` the final value directly; NEVER export a default function or import modules. The body may use agent()/parallel()/pipeline()/phase()/log()/budget/args. Prefer wait=true so the tool returns the final script value. Intermediate agent results stay in script variables, not the parent transcript.",
    parameters: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description:
            "Self-contained workflow script beginning with export const meta = { name, description, phases }, followed by top-level statements and a direct return (no export default function or imports).",
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
      "Read the status of a workflow run (phase, agents used, logs, return value). Defaults to the latest run for this conversation when runId is omitted.",
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
      "Wait for a workflow run to reach a terminal state and return its result summary.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
      },
      additionalProperties: false,
    },
  },
  CESIUM_SHARED_TOOL_DEFINITIONS.ask_question,
  {
    name: "list_conversations",
    description:
      "List saved Cesium conversations across every workspace (id, title, workspace, last update). Use to resolve <conversation-reference> tags from the user or to find related prior chats worth mining for context.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional title/workspace substring filter." },
        workspaceId: { type: "string", description: "Optional workspace scope." },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_conversation",
    description:
      "Read another conversation's transcript by id (most recent turns first, bounded). Read tagged <conversation-reference> chats before relying on their details.",
    parameters: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        limitTurns: { type: "number", description: "Recent user turns to include (default 40)." },
        maxChars: { type: "number", description: "Transcript character cap (default 24000)." },
      },
      required: ["conversationId"],
      additionalProperties: false,
    },
  },
  {
    name: "search_conversations",
    description:
      "Search text across saved conversation transcripts (all workspaces, or one conversation via conversationId). Returns snippets with conversation ids for read_conversation follow-up.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        conversationId: { type: "string", description: "Optional single-conversation scope." },
        maxResults: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "conversation_title",
    description:
      "Read or rename this conversation's display title. action=read returns the current name; action=rename sets title. Optional follow=true keeps a tiny reminder to refresh the name when the topic changes (only if the user asked to keep it updated); follow=false turns that off. Use only when the user wants the title changed — do not rename unprompted.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "rename"],
          description: "read inspects the current title; rename writes a new one.",
        },
        title: {
          type: "string",
          description: "New display name (required for rename). Keep it short.",
        },
        follow: {
          type: "boolean",
          description:
            "When true, keep updating the title as work evolves if the user asked for that. When false, only rename when asked again.",
        },
      },
      additionalProperties: false,
    },
  },
  CESIUM_SHARED_TOOL_DEFINITIONS.switch_branch,
  {
    name: "create_worktree",
    description:
      "Create an isolated git worktree (own directory, own branch) for parallel or risky work without disturbing this checkout. Best etiquette: one worktree branch per concurrent workstream (especially delegated/subagent work); run commands there via terminal with the returned path, then merge finished branches back with git and remove the worktree.",
    parameters: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Branch to check out in the worktree (created when missing)." },
        baseBranch: { type: "string", description: "Optional base ref when creating the branch." },
      },
      required: ["branch"],
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
    name: "memory",
    description:
      "Curated persistent memory across conversations. save durable user preferences, facts, constraints, and decisions; search or list before re-asking the user; forget stale or wrong entries. Scope user is cross-workspace, workspace is project-local. Saving the same fact again (same key, or same or nearly the same text) updates the existing entry; when a scope is full the least recently updated entries are evicted and listed in the result. Keep entries short and never save secrets.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["save", "search", "list", "forget"] },
        content: {
          type: "string",
          description: "Memory text to save (required for save). Keep it one short factual sentence.",
        },
        category: {
          type: "string",
          enum: ["preference", "fact", "constraint", "decision"],
          description: "Kind of entry when saving. Defaults to fact.",
        },
        scope: {
          type: "string",
          enum: ["user", "workspace"],
          description: "Where the entry lives. Defaults to workspace for save; both scopes for search/list.",
        },
        id: {
          type: "string",
          description: "Entry id: update an existing entry on save, or the entry to forget.",
        },
        key: {
          type: "string",
          description:
            "Optional stable slug for a fact that changes over time (e.g. \"package-manager\"). Saving with a key already in the scope updates that entry.",
        },
        query: { type: "string", description: "Search terms (required for search)." },
        limit: { type: "number", description: "Max results for search/list (default 10, max 50)." },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "skill",
    description:
      "Author and manage Agent Skills (agentskills.io SKILL.md standard). create documents a reusable procedure under .agents/skills/<id>/SKILL.md; update/delete manage agent-authored skills; list catalogs every discovered skill; read returns a skill's full SKILL.md. Authored skills appear in the agent-skills/ mirror immediately. Write a skill when you finish a non-obvious multi-step procedure worth repeating.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "update", "list", "read", "delete"] },
        id: {
          type: "string",
          description: "Skill id/slug (required for update, read, delete; optional for create - defaults to a slug of name).",
        },
        name: { type: "string", description: "Human skill name (required for create)." },
        description: {
          type: "string",
          description: "One-to-two sentence trigger description: when should this skill be used? (required for create, max 500 chars).",
        },
        instructions: {
          type: "string",
          description: "Markdown body of the skill: steps, commands, caveats (required for create, max 24000 chars).",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "schedule",
    description:
      "Manage scheduled triggers that wake the agent proactively: each fire creates a fresh conversation with the stored prompt under a chosen mode. create needs name, prompt, and exactly one of cron (5-field expression), everyMinutes, or atMs; list/pause/resume/delete/run manage existing triggers (run fires one immediately). The scheduler ticks every 30 seconds while the Cesium server runs.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "update", "pause", "resume", "delete", "run"],
        },
        id: { type: "string", description: "Trigger id (required for update/pause/resume/delete/run)." },
        name: { type: "string", description: "Short trigger name (required for create, max 80 chars)." },
        prompt: {
          type: "string",
          description: "User-message text injected when the trigger fires (required for create, max 4000 chars).",
        },
        cron: {
          type: "string",
          description: '5-field cron expression in server-local time, e.g. "0 9 * * mon-fri".',
        },
        everyMinutes: {
          type: "number",
          description: "Interval schedule in minutes (min 1).",
        },
        atMs: {
          type: "number",
          description: "One-shot schedule: epoch milliseconds of the single fire time.",
        },
        mode: {
          type: "string",
          description: "Conversation mode for spawned conversations (default agent).",
        },
        maxRuns: { type: "number", description: "Optional run cap; the trigger disables itself after this many fires." },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "call_mcp_tool",
    description:
      "Invoke a tool on a connected MCP server. Read mcp-servers/<serverId>/tools/ first.",
    requiresPermission: "mcpCall",
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
    description: "Read the current orchestration board snapshot.",
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
    description:
      "Create a kanban issue with optional description and acceptance criteria. A blockerExplanation is required when columnId is blocked.",
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
        blockerExplanation: {
          type: "string",
          description: "Why progress is blocked and what is needed to resume.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "orchestration_update_issue",
    description:
      "Update or move an existing kanban issue. Provide blockerExplanation when moving it to blocked.",
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
        blockerExplanation: {
          type: "string",
          description: "Why progress is blocked and what is needed to resume.",
        },
        blockedReason: {
          type: "string",
          description: "Deprecated alias for blockerExplanation.",
        },
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

/** @deprecated Prefer resolveCesiumTools(harness).tools - kept for tests expecting a flat default list. */
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

export function toolKind(
  name: string,
  definition?: CesiumToolDefinition
): string {
  if (definition?.kind?.trim()) {
    return definition.kind.trim();
  }
  switch (name) {
    case "read_file":
      return "read";
    case "edit_file":
      return "edit";
    case "write_file":
      return "edit";
    case "terminal":
    case "terminal_read":
    case "terminal_kill":
      return "terminal";
    case "switch_mode":
      return "mode";
    case "wait":
      return "wait";
    case "grep":
      return "grep";
    case "glob":
      return "search";
    case "todo":
    case "create_plan":
    case "update_plan":
    case "read_plan":
    case "finalize_plan":
      return "todo";
    case "goal_set":
    case "goal_pause":
    case "goal_summarize":
    case "goal_get":
    case "goal_update_plan":
    case "goal_update_progress":
    case "goal_summarize_state":
    case "goal_complete":
    case "goal_block":
    case "goal_resume":
      return "goal";
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
    case "list_conversations":
    case "read_conversation":
    case "search_conversations":
    case "conversation_title":
      return "search";
    case "memory":
      return "memory";
    case "skill":
    case "schedule":
      return "other";
    case "switch_branch":
    case "create_worktree":
      return "terminal";
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
  return sharedPermissionDecisionFromOption(optionId);
}

export function resolveCesiumToolPermissionCategory(
  tools: CesiumToolDefinition[],
  toolName: string
): AgentPermissionCategory | undefined {
  return tools.find((tool) => tool.name === toolName)?.requiresPermission;
}

export function cesiumPermissionToolKey(
  permission: AgentPermissionCategory,
  args: Record<string, unknown>
): string {
  switch (permission) {
    case "editFile":
      return `cesium:edit_file:${asString(args.path) ?? ""}`;
    case "terminal":
      return asString(args.killRunId)
        ? `cesium:terminal_kill:${asString(args.command) ?? ""}`
        : `cesium:terminal:${asString(args.command) ?? ""}`;
    case "mcpCall":
      return `cesium:mcp:${asString(args.serverId) ?? ""}:${asString(args.toolName) ?? ""}`;
    default:
      return `cesium:${permission}`;
  }
}
export function toolTitle(
  name: string,
  args: Record<string, unknown>,
  definition?: CesiumToolDefinition
): string {
  if (typeof definition?.title === "function") {
    return definition.title(args);
  }
  if (typeof definition?.title === "string" && definition.title.trim()) {
    return definition.title.trim();
  }
  switch (name) {
    case "read_file":
      return `Read ${asString(args.path) ?? "file"}`;
    case "edit_file":
      return `Edit ${asString(args.path) ?? "file"}`;
    case "write_file":
      return `Write ${asString(args.path) ?? "file"}`;
    case "terminal":
      return `Run ${asString(args.command) ?? "command"}`;
    case "terminal_read":
      return `Read terminal ${asString(args.id)?.slice(0, 8) ?? "run"}`;
    case "terminal_kill":
      return `Kill terminal ${asString(args.id)?.slice(0, 8) ?? "run"}`;
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
    case "glob": {
      const pattern = asString(args.pattern) ?? "*";
      const searchPath = asString(args.path);
      return searchPath ? `Glob ${pattern} in ${searchPath}` : `Glob ${pattern}`;
    }
    case "memory": {
      const action = asString(args.action) ?? "use";
      if (action === "save") {
        return `Memory save ${asString(args.category) ?? "fact"}`;
      }
      if (action === "search") {
        return `Memory search ${asString(args.query) ?? ""}`.trim();
      }
      if (action === "forget") {
        return `Memory forget ${asString(args.id) ?? "entry"}`;
      }
      return "Memory list";
    }
    case "skill": {
      const action = asString(args.action) ?? "use";
      if (action === "list") {
        return "List skills";
      }
      const target = asString(args.id) ?? asString(args.name) ?? "skill";
      return `Skill ${action} ${target}`.trim();
    }
    case "schedule": {
      const action = asString(args.action) ?? "manage";
      if (action === "list") {
        return "List triggers";
      }
      const target = asString(args.name) ?? asString(args.id) ?? "trigger";
      return `Schedule ${action} ${target}`.trim();
    }
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
    case "goal_set":
      return "Set Goal";
    case "goal_pause":
      return "Pause Goal";
    case "goal_summarize":
      return "Summarize Goal";
    case "goal_get":
      return "Read Goal";
    case "goal_update_plan":
      return "Record Goal plan";
    case "goal_update_progress":
      return "Update Goal progress";
    case "goal_summarize_state":
      return "Summarize Goal state";
    case "goal_complete":
      return "Complete Goal";
    case "goal_block":
      return "Record Goal blocker";
    case "goal_resume":
      return "Resume Goal";
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
    case "list_conversations":
      return "List conversations";
    case "read_conversation":
      return `Read conversation ${asString(args.conversationId) ?? ""}`.trim();
    case "search_conversations":
      return `Search conversations for ${asString(args.query) ?? ""}`.trim();
    case "conversation_title": {
      const action = asString(args.action)?.trim().toLowerCase();
      const title = asString(args.title);
      if (action === "rename" || title) {
        return title ? `Rename conversation to ${title}` : "Rename conversation";
      }
      return "Read conversation title";
    }
    case "switch_branch":
      return `Switch to branch ${asString(args.branch) ?? ""}`.trim();
    case "create_worktree":
      return `Create worktree for ${asString(args.branch) ?? "branch"}`;
    case "call_mcp_tool":
      if (asString(args.serverId) === BROWSER_MCP_SERVER_ID) {
        const browserTool = asString(args.toolName);
        return browserTool
          ? `Browser · ${formatMcpToolDisplayName(browserTool, BROWSER_MCP_SERVER_ID)}`
          : "Browser tool";
      }
      if (asString(args.serverId) === ARTIFACTS_MCP_SERVER_ID) {
        const artifactTool = asString(args.toolName);
        return artifactTool
          ? `Artifacts · ${formatMcpToolDisplayName(artifactTool, ARTIFACTS_MCP_SERVER_ID)}`
          : "Artifact tool";
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
    default: {
      const humanized = name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
      return humanized
        ? humanized.charAt(0).toUpperCase() + humanized.slice(1)
        : name;
    }
  }
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
