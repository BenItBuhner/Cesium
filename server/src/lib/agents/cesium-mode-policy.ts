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
  "workflow_control",
]);

export function normalizeCesiumMode(mode: string | undefined | null): string {
  const normalized = String(mode ?? "agent").trim().toLowerCase();
  if (!normalized) return "agent";
  return normalized === "burn" ? "goal" : normalized;
}

export function isOrchestrationToolName(name: string): boolean {
  return name.startsWith("orchestration_");
}

export function isPlanFileToolName(name: string): boolean {
  return PLAN_FILE_TOOLS.has(name);
}

export function isGoalToolName(name: string): boolean {
  const normalized =
    name.startsWith("burn_goal_") ? `goal_${name.slice("burn_goal_".length)}` : name;
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
  const name =
    input.toolName.startsWith("burn_goal_")
      ? `goal_${input.toolName.slice("burn_goal_".length)}`
      : input.toolName;

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
    if (name === "edit_file") {
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
      name === "todo" ||
      name === "wait" ||
      name === "subagent" ||
      name === "read_subagent_transcript" ||
      name === "call_mcp_tool" ||
      name === "refresh_mcp_servers"
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
    if (isWorkflowToolName(name)) {
      return policyBlock(name, "Goal mode executes its own durable goal loop and does not run Workflow scripts.");
    }
    if (name === "goal_complete" || name === "goal_block") {
      return { allowed: true };
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
    return policyBlock(name, "Goal control tools are only available in Goal mode.");
  }
  if (isWorkflowToolName(name)) {
    return policyBlock(name, "Workflow tools are only available in Workflow mode.");
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
        blocked: ["direct edit_file", "direct terminal implementation", "Goal execution controls", "Workflow execution controls"],
      };
    case "goal":
      return {
        allowed: [
          "read_file",
          "grep",
          "edit_file",
          "terminal",
          "todo",
          "wait",
          "switch_mode",
          "subagents",
          "plan-file tools",
          "Goal tools",
          "MCP tools",
        ],
        restricted: ["goal_complete requires a final audit; goal_block requires repeated same-blocker evidence"],
        blocked: ["orchestration kanban mutations", "Workflow execution controls"],
      };
    case "workflow":
      return {
        allowed: [
          "workflow_run",
          "workflow_status",
          "workflow_await",
          "workflow_control",
          "read_file",
          "grep",
          "edit_file",
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
          "terminal",
          "todo",
          "wait",
          "ask_question",
          "switch_mode",
          "subagents",
          "history tools",
          "MCP tools",
        ],
        restricted: ["plan-file tools only for explicit plan creation or handoff"],
        blocked: ["orchestration_* tools", "Goal execution controls", "Workflow execution controls"],
      };
  }
}
