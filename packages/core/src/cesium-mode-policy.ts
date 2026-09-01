/**
 * Cesium mode → tool policy shared by every engine hosting the Cesium
 * harness (Bun server and the in-browser machine). Pure and dependency-free
 * so engines enforce identical read-only/plan/orchestration semantics.
 */

export type CesiumToolPolicyDecision = {
  allowed: boolean;
  reason?: string;
};

export type CesiumModeToolPolicySummary = {
  allowed: string[];
  restricted: string[];
  blocked: string[];
};

const READ_ONLY_TOOLS = new Set([
  "read_file",
  "grep",
  "search_history",
  "read_history_page",
  "list_conversations",
  "read_conversation",
  "search_conversations",
  "ask_question",
  "subagent",
  "read_subagent_transcript",
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
  "wait",
  // Curated agent memory mutates agent state, not the workspace, so it stays
  // available in read-only postures.
  "memory",
]);

const PLAN_FILE_TOOLS = new Set([
  "create_plan",
  "update_plan",
  "read_plan",
  "finalize_plan",
]);

const GOAL_TOOLS = new Set([
  "goal_set",
  "goal_pause",
  "goal_summarize",
  "goal_get",
  "goal_update_plan",
  "goal_update_progress",
  "goal_summarize_state",
  "goal_complete",
  "goal_block",
  "goal_resume",
]);

const WORKFLOW_TOOLS = new Set([
  "workflow_run",
  "workflow_status",
  "workflow_await",
]);

/** Legacy persisted mode id accepted only at normalization boundaries. */
export const LEGACY_GOAL_MODE_ID = "burn";

export function normalizeCesiumMode(mode: string | undefined | null): string {
  const normalized = String(mode ?? "agent").trim().toLowerCase();
  if (!normalized) return "agent";
  return normalized === LEGACY_GOAL_MODE_ID ? "goal" : normalized;
}

export function isOrchestrationToolName(name: string): boolean {
  return name.startsWith("orchestration_");
}

export function isPlanFileToolName(name: string): boolean {
  return PLAN_FILE_TOOLS.has(name);
}

/** Canonicalize pre-Goal tool names from persisted transcripts and older clients. */
export function normalizeCesiumToolName(name: string): string {
  return name.startsWith("burn_goal_")
    ? `goal_${name.slice("burn_goal_".length)}`
    : name;
}

export function isGoalToolName(name: string): boolean {
  const normalized = normalizeCesiumToolName(name);
  return GOAL_TOOLS.has(normalized) || normalized === "goal_resume";
}

export function isWorkflowToolName(name: string): boolean {
  return WORKFLOW_TOOLS.has(name) || name.startsWith("workflow_");
}

function policyBlock(name: string, reason: string): CesiumToolPolicyDecision {
  return {
    allowed: false,
    reason: `Tool ${name} is blocked in the active mode. ${reason}`,
  };
}

export function resolveCesiumModeToolPolicy(input: {
  mode: string | undefined | null;
  toolName: string;
}): CesiumToolPolicyDecision {
  const mode = normalizeCesiumMode(input.mode);
  const name = normalizeCesiumToolName(input.toolName);

  // Mode switching is available from every mode so the agent can request a change.
  if (name === "switch_mode") {
    return { allowed: true };
  }

  if (mode === "ask") {
    if (READ_ONLY_TOOLS.has(name)) {
      return { allowed: true };
    }
    return policyBlock(
      name,
      "Ask mode is read-only; inspect and explain instead of changing files, running commands, or mutating external state."
    );
  }

  if (mode === "plan") {
    if (READ_ONLY_TOOLS.has(name) || isPlanFileToolName(name)) {
      return { allowed: true };
    }
    if (name === "terminal") {
      return { allowed: true };
    }
    if (name === "edit_file" || name === "write_file") {
      return policyBlock(
        name,
        "Plan mode should write through plan-file tools under .cesium/plans/ and must not implement code changes directly."
      );
    }
    if (isOrchestrationToolName(name) || isGoalToolName(name) || isWorkflowToolName(name)) {
      return policyBlock(
        name,
        "Plan mode prepares work but does not run Orchestration, Goal, or Workflow execution controls."
      );
    }
    if (name === "call_mcp_tool" || name === "refresh_mcp_servers") {
      return { allowed: true };
    }
    return { allowed: true };
  }

  if (mode === "orchestration") {
    if (
      isOrchestrationToolName(name) ||
      name === "ask_question" ||
      name === "search_history" ||
      name === "read_history_page" ||
      name === "list_conversations" ||
      name === "read_conversation" ||
      name === "search_conversations" ||
      name === "todo" ||
      name === "wait" ||
      name === "subagent" ||
      name === "read_subagent_transcript" ||
      name === "call_mcp_tool" ||
      name === "refresh_mcp_servers" ||
      name === "memory" ||
      // Coordinators may document skills and manage the trigger plane.
      name === "skill" ||
      name === "schedule"
    ) {
      return { allowed: true };
    }
    return policyBlock(
      name,
      "Orchestration mode manages work through the kanban and child-agent tools instead of performing direct implementation."
    );
  }

  if (mode === "goal") {
    if (isOrchestrationToolName(name)) {
      return policyBlock(name, "Goal mode executes its own plan and does not mutate the orchestration kanban directly.");
    }
    return { allowed: true };
  }

  if (mode === "workflow") {
    if (isOrchestrationToolName(name)) {
      return policyBlock(
        name,
        "Workflow mode orchestrates through JavaScript scripts and workflow_* tools, not the orchestration kanban."
      );
    }
    if (isGoalToolName(name)) {
      return policyBlock(name, "Workflow mode uses workflow_* tools instead of Goal controls.");
    }
    return { allowed: true };
  }

  if (isOrchestrationToolName(name)) {
    return policyBlock(name, "Orchestration tools are only available in Orchestration mode.");
  }
  if (isGoalToolName(name)) {
    return policyBlock(
      name,
      "Goal controls require Goal mode because that mode activates durable continuation and completion enforcement. Use switch_mode with target_mode goal first."
    );
  }
  return { allowed: true };
}

export function summarizeCesiumModeToolPolicy(mode: string | undefined | null): CesiumModeToolPolicySummary {
  const normalized = normalizeCesiumMode(mode);
  switch (normalized) {
    case "ask":
      return {
        allowed: [
          "read_file",
          "grep",
          "search_history",
          "read_history_page",
          "ask_question",
          "wait",
          "switch_mode",
          "read-only subagents",
        ],
        restricted: ["call_mcp_tool only after an explicit read-only server/tool check"],
        blocked: [
          "edit_file",
          "write_file",
          "terminal",
          "plan writes",
          "orchestration mutations",
          "Goal execution controls",
          "Workflow execution controls",
        ],
      };
    case "plan":
      return {
        allowed: [
          "read_file",
          "grep",
          "search_history",
          "read_history_page",
          "ask_question",
          "wait",
          "switch_mode",
          "research subagents",
          "plan-file tools",
        ],
        restricted: ["terminal for investigation only", "MCP calls for research only"],
        blocked: [
          "direct implementation edits outside .cesium/plans/",
          "orchestration mutations",
          "Goal execution controls",
          "Workflow execution controls",
        ],
      };
    case "orchestration":
      return {
        allowed: [
          "orchestration_* tools",
          "todo",
          "wait",
          "ask_question",
          "history tools",
          "subagents",
          "MCP refresh/calls",
          "switch_mode",
        ],
        restricted: ["child-agent permissions are controlled by orchestration assignment policy"],
        blocked: ["direct edit_file / write_file", "direct terminal implementation", "Goal execution controls", "Workflow execution controls"],
      };
    case "goal":
      return {
        allowed: [
          "read_file",
          "grep",
          "edit_file",
          "write_file",
          "terminal",
          "todo",
          "wait",
          "switch_mode",
          "subagents",
          "plan-file tools",
          "Goal tools",
          "Workflow tools",
          "MCP tools",
        ],
        restricted: [
          "Goal lifecycle controls are mandatory for durable state and completion",
          "goal_complete requires a final audit; goal_block requires repeated same-blocker evidence",
          "Use Workflow tools when parallel fan-out or a scripted verification pipeline materially helps the Goal",
        ],
        blocked: ["orchestration kanban mutations"],
      };
    case "workflow":
      return {
        allowed: [
          "workflow_run",
          "workflow_status",
          "workflow_await",
          "read_file",
          "grep",
          "edit_file",
          "write_file",
          "terminal",
          "todo",
          "wait",
          "switch_mode",
          "subagents",
          "MCP tools",
        ],
        restricted: [
          "Prefer encoding fan-out/verify loops in workflow scripts instead of long parent-turn tool chains",
          "agent() results stay in script variables; only return the final synthesized value to the user",
        ],
        blocked: ["orchestration kanban mutations", "Goal execution controls"],
      };
    default:
      return {
        allowed: [
          "read_file",
          "grep",
          "edit_file",
          "write_file",
          "terminal",
          "todo",
          "wait",
          "ask_question",
          "switch_mode",
          "subagents",
          "history tools",
          "MCP tools",
          "Workflow tools",
        ],
        restricted: [
          "plan-file tools only for explicit plan creation or handoff",
          "Use Workflow tools directly for meaningful fan-out or repeatable pipelines; switch to Workflow mode for sustained workflow-first execution",
          "Switch to Goal mode before using Goal controls so durable continuation is active",
        ],
        blocked: ["orchestration_* tools", "Goal execution controls"],
      };
  }
}
