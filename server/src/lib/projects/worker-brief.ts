import path from "node:path";
import type { ProjectAgentIsolation } from "@cesium/core/projects";
import type { WorkerSetupPlan } from "./worktrees.js";

/** What the home engine knows about a worker before it is placed. */
export type WorkerBriefInput = {
  projectName: string;
  agentName: string;
  instructions: string;
  repoName: string | null;
  /** The Project context folder on the engine that runs the worker, or null when it has no copy. */
  contextDir: string | null;
  /** Name of the engine that holds the Project context. */
  contextEngine: string;
  /** Set by the home when it synced the Project context to the engine that runs the worker. */
  contextSync?: boolean;
  /** `contextDir` is that engine's synced copy rather than the Project context itself. */
  contextIsMirror?: boolean;
  /** The user's lasting preferences (shared by every Project). */
  preferences?: string[];
};

/** Where the worker actually landed; the hosting engine fills this in. */
export type WorkerPlacementFacts = {
  isolation: ProjectAgentIsolation;
  root: string;
  branch: string | null;
  baseRef: string | null;
  baseSha: string | null;
  hasOrigin: boolean;
  setup: WorkerSetupPlan | null;
  warning: string | null;
};

export const WORKER_BRIEF_TAG = "project_worker_brief";

function workspaceLines(facts: WorkerPlacementFacts, brief: WorkerBriefInput): string[] {
  switch (facts.isolation) {
    case "worktree": {
      const base = facts.baseSha ? `${facts.baseRef} (${facts.baseSha.slice(0, 12)})` : facts.baseRef;
      const lines = [
        `- You have your own git worktree at ${facts.root}, on branch \`${facts.branch}\`, created from ${base}. Commit only here and never touch other checkouts: other agents work in parallel in their own worktrees.`,
      ];
      if (facts.setup) {
        lines.push(
          `- Before anything else, run this repository's worktree setup from ${facts.root} (from ${facts.setup.sourcePath}), with ROOT_WORKTREE_PATH, WORKTREE_PATH and BRANCH_NAME set to the main checkout, this worktree and \`${facts.branch}\`:`,
          ...facts.setup.commands.map((command) => `    ${command}`)
        );
      }
      return lines;
    }
    case "checkout":
      return [
        `- You work directly in the ${brief.repoName ? `"${brief.repoName}" ` : ""}checkout at ${facts.root}, on whatever branch it has checked out. It is not isolated, so keep changes focused and leave unrelated files alone.`,
      ];
    case "scratch":
      return [`- You start in an empty scratch folder: ${facts.root}. It is not a repository.`];
  }
}

function contextLines(brief: WorkerBriefInput): string[] {
  if (!brief.contextDir) {
    return [
      `- The Project context lives on engine ${brief.contextEngine} and has no copy on this machine, so put everything the coordinator needs in your report.`,
    ];
  }
  const dir = brief.contextDir;
  return [
    brief.contextIsMirror
      ? `- Folder: ${dir}. It is this machine's copy of the Project context on engine ${brief.contextEngine}. What you save there reaches that engine within moments, and its changes (notes.md, new docs) show up here the same way.`
      : `- Folder: ${dir}`,
    "- It is not part of any repository, and nothing in it is committed.",
    `- ${path.join(dir, "notes.md")} is the coordinator's live status board. Read it first; don't edit it.`,
    `- ${path.join(dir, "docs/")} holds documents the user reads. Read what is relevant to you; write there only when your deliverable is a document.`,
    `- ${path.join(dir, "internal", `${brief.agentName}/`)} is for your handoffs, findings and working notes for other agents.`,
    `- ${path.join(dir, "media", `${brief.agentName}/`)} is for your screenshots, recordings and other evidence.`,
  ];
}

function doneLines(facts: WorkerPlacementFacts, brief: WorkerBriefInput): string[] {
  const evidenceDir = brief.contextDir ? `${brief.contextDir}/media/${brief.agentName}/` : "your workspace";
  const lines = ["- The change works and the relevant tests pass."];
  if (facts.isolation === "worktree") {
    if (facts.hasOrigin) {
      const base = facts.baseRef?.replace(/^origin\//, "") ?? "the base branch";
      const findings = brief.contextDir ? path.join(brief.contextDir, "internal", `${brief.agentName}/`) : null;
      lines.push(
        `- If your task changes no code (research, an investigation, a plan), your findings go in ${findings ? `${findings} and ` : ""}your report: don't commit them to the repository or open a pull request.`
      );
      lines.push(
        `- Your commits are on \`${facts.branch}\` and pushed: \`git push -u origin ${facts.branch}\`.`,
        `- A pull request is open for \`${facts.branch}\` against \`${base}\`, ready for review, with a description that says what changed, how you verified it and where the evidence is. Use \`gh pr create\` when it is available; if you cannot open one, push and say so in your report.`
      );
    } else {
      lines.push(
        `- Your commits are on \`${facts.branch}\`. This repository has no remote, so report the branch and your commits instead of opening a pull request.`
      );
    }
  } else if (facts.isolation === "checkout") {
    lines.push("- Commit your work with a clear message unless you were told not to.");
  }
  lines.push(
    `- A change to what users see (pages, components, styles, markup) is done only with evidence: screenshots of the result, plus a short recording for anything interactive, saved under ${evidenceDir} and listed in your report${facts.isolation === "worktree" && facts.hasOrigin ? " and the pull request" : ""}. The Project checks this when your turn ends and sends the change back to you while that folder is empty.`,
    `- To capture it, run the app. With Cesium's browser tools: call_mcp_tool on server "browser" with browser_navigate, browser_screenshot, and browser_record ("start" before an interaction, "stop" after). They save under artifacts/browser/ in your workspace, so copy the files into ${evidenceDir}.`
  );
  return lines;
}

/**
 * The contract every worker gets ahead of its first task: who it is, where it
 * works, how to use the shared Project context, what done means (tests,
 * pushed branch, open PR, evidence) and how to report.
 */
export function buildWorkerBrief(brief: WorkerBriefInput, facts: WorkerPlacementFacts): string {
  const opensPullRequest = facts.isolation === "worktree" && facts.hasOrigin;
  return [
    `<${WORKER_BRIEF_TAG}>`,
    `You are "${brief.agentName}", a worker agent in the Cesium Project "${brief.projectName}". The Project's coordinator gave you the task below. Do it end to end yourself; you don't coordinate other agents.`,
    "",
    "Workspace",
    ...workspaceLines(facts, brief),
    ...(facts.warning ? [`- Note: ${facts.warning}`] : []),
    "",
    "Project context (shared with the coordinator and every agent in this Project)",
    ...contextLines(brief),
    "",
    ...(brief.preferences && brief.preferences.length > 0
      ? ["The user's preferences (follow them)", ...brief.preferences.map((line) => `- ${line}`), ""]
      : []),
    "Done means",
    ...doneLines(facts, brief),
    "",
    "Report",
    opensPullRequest
      ? "- End every turn with a short report: what you did, the pull request URL, the evidence file paths, and anything blocking you or needing a decision. It reaches the coordinator automatically."
      : "- End every turn with a short report: what you did, what changed (files, commits, results), the evidence file paths, and anything blocking you or needing a decision. It reaches the coordinator automatically.",
    "- If you need a human decision, say so plainly in your report instead of guessing.",
    opensPullRequest
      ? "- Follow-up instructions, review comments, CI failures and requests to rebase your pull request when it conflicts arrive as messages from the coordinator."
      : "- Follow-up instructions arrive as messages from the coordinator.",
    `</${WORKER_BRIEF_TAG}>`,
    "",
    brief.instructions,
  ].join("\n");
}
