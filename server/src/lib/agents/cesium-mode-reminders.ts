import type { McpServerSummary } from "@cesium/core/mcp";
import type { OrchestrationBoardSnapshot } from "../orchestration/types.js";
import { summarizeCesiumModeToolPolicy } from "./cesium-mode-policy.js";

export type CesiumModeReminderInput = {
  mode: string;
  modelName?: string | null;
  workspaceRoot: string;
  dateLabel: string;
  gitSummary: string;
  agentsMarkdown?: string | null;
  skillsList?: string | null;
  mcpSummaries: McpServerSummary[];
  mcpChangeNotice?: string | null;
  orchestrationBoard?: OrchestrationBoardSnapshot | null;
  activePlanPath?: string | null;
  goalSummary?: string | null;
  workflowRunSummary?: string | null;
  handoffPlanPath?: string | null;
};

function modeTitle(mode: string): string {
  const normalized = mode.trim().toLowerCase() === "burn" ? "goal" : mode.trim().toLowerCase();
  if (normalized === "ask") return "Ask";
  if (normalized === "plan") return "Plan";
  if (normalized === "goal") return "Goal";
  if (normalized === "workflow") return "Workflow";
  if (normalized === "orchestration") return "Orchestration";
  return "Agent";
}

function modeFlow(mode: string): string {
  const normalized = mode.trim().toLowerCase() === "burn" ? "goal" : mode.trim().toLowerCase();
  if (normalized === "ask") {
    return [
      "The general flow when working on tasks is 1) context collection, be it grep, read, or anything else 2) answering any/all questions asked by the user.",
      "",
      "Do note, since you are in ask mode, you are unable to run commands, perform edits, or execute any actions that could cause changes in the codebase, for better or worse. If the user enforces you to edit or work, you must warn that you're in ask mode and must be switched over to agent or any equivalent mode to progress further.",
    ].join("\n");
  }
  if (normalized === "plan") {
    return [
      "The general flow when working on tasks is 1) context collection, be it grep, read, or anything else 2) asking questions and running commands to best understand the codebase and what the user wants changed, as very key and crucial decisions shall be made in this phase 3) iterate and refine on the intent until you can draft a final and complete plan for usage thereafter.",
      "",
      "You should create and edit plan files under .cesium/plans/ when drafting implementation plans. Do not perform direct implementation work in plan mode.",
    ].join("\n");
  }
  if (normalized === "goal") {
    return [
      "The general flow when working in Goal mode is 1) keep the user's objective as durable Goal task context with goal_set 2) execute sequentially while refreshing compact goal state with goal_set as needed 3) record meaningful progress snapshots with goal_summarize 4) pause or block only when appropriate 5) audit every requirement before calling goal_complete.",
      "",
      "Goal mode is persistent across turns. You must not shrink the goal to what fits in one turn. Use goal_summarize periodically after meaningful progress, after resolving a blocker, before pausing, before completing, and whenever the latest summary is missing or materially stale. Do not call it every turn, and do not stop after a progress snapshot if there is still concrete work to do.",
      "",
      "In Cesium Goal mode, the Goal control tools are goal_set, goal_pause, goal_block, goal_summarize, and goal_complete. Use goal_complete only after verification passes, and use goal_block only when a genuine external blocker prevents progress.",
    ].join("\n");
  }
  if (normalized === "workflow") {
    return [
      "The general flow when working in Workflow mode is 1) understand the fan-out / verification shape of the task 2) write a JavaScript orchestration script beginning with `export const meta = { name, description, phases }` 3) execute it with workflow_run (wait=true unless you intentionally background it) 4) inspect with workflow_status / workflow_await 5) return only the final synthesized result to the user.",
      "",
      "Workflow scripts may use agent(), parallel(), pipeline(), phase(), log(), budget, and args. Prefer pipeline() for multi-stage item processing. Use parallel() only when a later stage needs every prior result at once. Keep intermediate agent results in script variables — do not dump every subagent transcript into the parent reply.",
      "",
      "Date.now(), Math.random(), and argless new Date() are unavailable inside scripts because resume journals agent(prompt, opts) calls deterministically. Pass timestamps through args and vary prompts/labels by index.",
    ].join("\n");
  }
  if (normalized === "orchestration") {
    return "Manage the kanban board, delegate work to child agents, supervise progress, and verify completion through orchestration tools.";
  }
  return [
    "The general flow when working on tasks is 1) context collection, be it grep, read, or anything else 2) editing files to implement the necessary changes and running various commands to build things, run servers, perform tests, etc. 3) iterate and refine until the task(s) provided by the user are achieved with reasonable verification unless instructed otherwise.",
    "",
    "This lifecycle is intended for you to keep working until the derived goal is accomplished and verifiably working to the extent at which you can test and verify it functions to the user's specifications or verbatim.",
  ].join("\n");
}

function bullets(values: string[]): string {
  return values.length ? values.map((value) => `- ${value}`).join("\n") : "- None";
}

function mcpSummaryText(summaries: McpServerSummary[]): string {
  if (summaries.length === 0) {
    return "No MCP servers are currently mirrored for this workspace.";
  }
  return summaries
    .map((summary) => `- ${summary.label}${summary.summary ? `: ${summary.summary}` : ""}`)
    .join("\n");
}

export function buildCesiumModeReminder(input: CesiumModeReminderInput): string {
  const mode = input.mode.trim().toLowerCase() || "agent";
  const title = modeTitle(mode);
  const policy = summarizeCesiumModeToolPolicy(mode);
  const board = input.orchestrationBoard;
  const boardLines =
    mode === "orchestration"
      ? [
          board?.board.id ? `- Board id: ${board.board.id}` : "- Board id: not created yet",
          `- Maximum concurrent issues: ${board?.board.settings.maxConcurrentIssues ?? "uncapped"}`,
          `- Maximum concurrent agents: ${board?.board.settings.maxConcurrentAgents ?? "uncapped"}`,
        ].join("\n")
      : "";
  const planLines = [
    input.activePlanPath ? `- Active plan: ${input.activePlanPath}` : null,
    input.handoffPlanPath ? `- Implement plan: ${input.handoffPlanPath}` : null,
    input.goalSummary ? input.goalSummary : null,
    input.workflowRunSummary ? input.workflowRunSummary : null,
  ].filter(Boolean).join("\n");
  const agentsMarkdown =
    input.agentsMarkdown?.trim() ||
    "(No AGENTS.md or CLAUDE.md file is present in this workspace.)";
  const skillsList = input.skillsList?.trim() || "(No skills are currently exposed in this workspace.)";

  const opening = input.handoffPlanPath
    ? `You are now in **${title} mode**, and you shall implement the ${input.handoffPlanPath} plan that we created end-to-end, ensuring it hits all requirements as given by the user and the plan subsequently.`
    : `You have been switched over to and are now in **${title} mode**, and shall ${
        mode === "ask"
          ? "work to the best of your ability to read, grep, and find things within the codebase to answer all asked questions from the user"
          : mode === "plan"
            ? "plan in an agentic manner to prepare for any assortment of tasks given to you by the user"
            : mode === "orchestration"
              ? "coordinate work, manage orchestration state, delegate where useful, and supervise progress"
              : mode === "workflow"
                ? "write and execute JavaScript workflow scripts that fan work across subagents while keeping intermediate results out of the parent context"
                : "work in an agentic manner to complete any assortment of tasks given to you by the user"
      }.`;

  return `<system-reminder>
${opening}

This switch has been done via the user, and you should abide by all instructions attached below along with the user context, disregarding prior behavior from other modes you were or might have been in.

## Current Environment

- Workspace root: ${input.workspaceRoot}
- Date: ${input.dateLabel}
- Repository: ${input.gitSummary}
- Model: ${input.modelName?.trim() || "configured model"}

Do note, the following tools have been changed:

Allowed:
${bullets(policy.allowed)}

Restricted:
${bullets(policy.restricted)}

Blocked:
${bullets(policy.blocked)}

---

## Typical Task Flow

${modeFlow(mode)}

## Working Etiquette

It is best to keep it all short and concise, but is preferable to also use warm and friendly communication, along with bold proposals and ideas to evade blockers and innovate where stagnant. Best practice also assumes you are to create your to-do list before researching or implementing and executing within the codebase, and keeping on-track with said to-do list to keep working and updating the list as you go, be it adjusting the list, checking off completed tasks, or anything else.

${planLines ? `## Active Plan, Goal, And Workflow\n\n${planLines}\n\n` : ""}${boardLines ? `## Orchestration Board\n\n${boardLines}\n\n` : ""}## MCP Servers

${mcpSummaryText(input.mcpSummaries)}

${input.mcpChangeNotice?.trim() ? `### MCP Changes Since Last Turn\n\n${input.mcpChangeNotice.trim()}\n\n` : ""}
When using MCP tools, read the mirrored server metadata and exact tool schema before calling a tool.

## Project Instruction Files

\`\`\`markdown
${agentsMarkdown}
\`\`\`

## Skills

${skillsList}

When using skills, read \`agent-skills/_index.md\` and the relevant \`agent-skills/<skill-id>/SKILL.md\` before following them — the same discover-then-read pattern as \`mcp-servers/\`.
</system-reminder>`;
}
