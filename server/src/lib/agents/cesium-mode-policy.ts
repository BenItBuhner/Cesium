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
  "wait",
]);

const PLAN_FILE_TOOLS = new Set([
  "create_plan",
  "update_plan",
  "read_plan",
  "finalize_plan",
]);

const BURN_TOOLS = new Set([
  "burn_goal_set",
  "burn_goal_pause",
  "burn_goal_summarize",
  "burn_goal_get",
  "burn_goal_update_plan",
  "burn_goal_update_progress",
  "burn_goal_summarize_state",
  "burn_goal_complete",
  "burn_goal_block",
]);

const WORKFLOW_TOOLS = new Set([
  "workflow_run",
  "workflow_status",
  "workflow_await",
]);

export function normalizeCesiumMode(mode: string | undefined | null): string {
  const normalized = String(mode ?? "agent").trim().toLowerCase();
  return normalized || "agent";
}

export function isOrchestrationToolName(name: string): boolean {
  return name.startsWith("orchestration_");
}

export function isPlanFileToolName(name: string): boolean {
  return PLAN_FILE_TOOLS.has(name);
}

export function isBurnToolName(name: string): boolean {
  return BURN_TOOLS.has(name);
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
  const name = input.toolName;

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
    if (isOrchestrationToolName(name) || isBurnToolName(name) || isWorkflowToolName(name)) {
      return policyBlock(
        name,
        "Plan mode prepares work but does not run Orchestration, Burn, or Workflow execution controls."
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

  if (mode === "burn") {
    if (isOrchestrationToolName(name)) {
      return policyBlock(name, "Burn mode executes its own plan and does not mutate the orchestration kanban directly.");
    }
    if (isWorkflowToolName(name)) {
      return policyBlock(name, "Burn mode executes its own durable goal loop and does not run Workflow scripts.");
    }
    if (name === "burn_goal_complete" || name === "burn_goal_block") {
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
    if (isBurnToolName(name)) {
      return policyBlock(name, "Workflow mode uses workflow_* tools instead of Burn goal controls.");
    }
    return { allowed: true };
  }

  if (isOrchestrationToolName(name)) {
    return policyBlock(name, "Orchestration tools are only available in Orchestration mode.");
  }
  if (isBurnToolName(name)) {
    return policyBlock(name, "Burn control tools are only available in Burn mode.");
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
        allowed: ["read_file", "grep", "search_history", "read_history_page", "ask_question", "wait", "read-only subagents"],
        restricted: ["call_mcp_tool only after an explicit read-only server/tool check"],
        blocked: [
          "edit_file",
          "terminal",
          "plan writes",
          "orchestration mutations",
          "Burn execution controls",
          "Workflow execution controls",
        ],
      };
    case "plan":
      return {
        allowed: ["read_file", "grep", "search_history", "read_history_page", "ask_question", "wait", "research subagents", "plan-file tools"],
        restricted: ["terminal for investigation only", "MCP calls for research only"],
        blocked: [
          "direct implementation edits outside .cesium/plans/",
          "orchestration mutations",
          "Burn execution controls",
          "Workflow execution controls",
        ],
      };
    case "orchestration":
      return {
        allowed: ["orchestration_* tools", "todo", "wait", "ask_question", "history tools", "subagents", "MCP refresh/calls"],
        restricted: ["child-agent permissions are controlled by orchestration assignment policy"],
        blocked: ["direct edit_file", "direct terminal implementation", "Burn execution controls", "Workflow execution controls"],
      };
    case "burn":
      return {
        allowed: ["read_file", "grep", "edit_file", "terminal", "todo", "wait", "subagents", "plan-file tools", "Burn goal tools", "MCP tools"],
        restricted: ["burn_goal_complete requires a final audit; burn_goal_block requires repeated same-blocker evidence"],
        blocked: ["orchestration kanban mutations", "Workflow execution controls"],
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
          "terminal",
          "todo",
          "wait",
          "subagents",
          "MCP tools",
        ],
        restricted: [
          "Prefer encoding fan-out/verify loops in workflow scripts instead of long parent-turn tool chains",
          "agent() results stay in script variables; only return the final synthesized value to the user",
        ],
        blocked: ["orchestration kanban mutations", "Burn execution controls"],
      };
    default:
      return {
        allowed: ["read_file", "grep", "edit_file", "terminal", "todo", "wait", "ask_question", "subagents", "history tools", "MCP tools"],
        restricted: ["plan-file tools only for explicit plan creation or handoff"],
        blocked: ["orchestration_* tools", "Burn execution controls", "Workflow execution controls"],
      };
  }
}
