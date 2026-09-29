export const HELPER_BRIEF_TAG = "project_helper_brief";

/**
 * What the home knows about a helper before it is placed; the engine that
 * runs it fills in where it landed (see `renderHelperBrief`).
 */
export type HelperBriefInput =
  | { kind: "explore"; projectName: string; helperName: string; repoName: string; question: string }
  | {
      kind: "browser";
      projectName: string;
      helperName: string;
      what: string;
      url: string | null;
      /** The agent whose working tree it runs, or null for a URL. */
      agent: { name: string; branch: string | null } | null;
      /**
       * `media/<helper>/` in the Project context on the engine that runs it, or
       * null when that engine has no copy. A peer sets it from its own mirror.
       */
      mediaDir: string | null;
      /** Set by the home when it synced the Project context to the peer that runs the helper. */
      contextSync?: boolean;
    };

export function buildExploreBrief(input: {
  projectName: string;
  helperName: string;
  repoName: string;
  root: string;
  baseRef: string | null;
  sha: string | null;
  question: string;
}): string {
  return [
    `<${HELPER_BRIEF_TAG}>`,
    `You are "${input.helperName}", a helper agent in the Cesium Project "${input.projectName}": a read-only code explorer. The coordinator asked you the question below about the "${input.repoName}" repository.`,
    `- The code is at ${input.root}${input.sha ? `, a clean checkout of ${input.baseRef} (${input.sha.slice(0, 12)})` : ""}. Search and read it; change nothing.`,
    "- Answer concisely: the facts, the relevant files as path:line, and anything you are unsure of. Your reply goes to the coordinator as is.",
    `</${HELPER_BRIEF_TAG}>`,
    "",
    `Question: ${input.question}`,
  ].join("\n");
}

export function buildBrowserCheckBrief(input: {
  projectName: string;
  helperName: string;
  what: string;
  where: string | null;
  url: string | null;
  mediaDir: string | null;
}): string {
  return [
    `<${HELPER_BRIEF_TAG}>`,
    `You are "${input.helperName}", a helper agent in the Cesium Project "${input.projectName}": a QA tester with a real browser. Check the behavior below in the running app and capture evidence.`,
    ...(input.where
      ? [
          `- The code is ${input.where}. Don't change it. Start the app from there if it isn't running (the README or package.json says how) and stop whatever you started when you finish.`,
        ]
      : []),
    ...(input.url ? [`- Open ${input.url}.`] : []),
    '- Drive the browser with call_mcp_tool on server "browser": browser_tabs (open a tab), browser_navigate, browser_snapshot, browser_click, browser_type, browser_screenshot, and browser_record (action "start" right before the interaction, "stop" right after). Tool details are under mcp-servers/browser/.',
    input.mediaDir
      ? `- The tools save screenshots and recordings under artifacts/browser/ in your workspace; copy every one you make into ${input.mediaDir} and list the paths.`
      : "- The tools save screenshots and recordings under artifacts/browser/ in your workspace. This machine has no copy of the Project context, so list every one you make with its full path.",
    "- End with a short report: what you checked, what worked, what failed, and the evidence paths. It reaches the coordinator automatically.",
    `</${HELPER_BRIEF_TAG}>`,
    "",
    `Check: ${input.what}`,
  ].join("\n");
}

/** A helper's first turn, once the engine that runs it knows where it landed. */
export function renderHelperBrief(
  brief: HelperBriefInput,
  facts: { root: string; baseRef: string | null; baseSha: string | null }
): string {
  if (brief.kind === "explore") {
    return buildExploreBrief({
      projectName: brief.projectName,
      helperName: brief.helperName,
      repoName: brief.repoName,
      root: facts.root,
      baseRef: facts.baseRef,
      sha: facts.baseSha,
      question: brief.question,
    });
  }
  return buildBrowserCheckBrief({
    projectName: brief.projectName,
    helperName: brief.helperName,
    what: brief.what,
    where: brief.agent
      ? `agent ${brief.agent.name}'s working tree at ${facts.root}${brief.agent.branch ? ` (branch \`${brief.agent.branch}\`)` : ""}`
      : null,
    url: brief.url,
    mediaDir: brief.mediaDir,
  });
}
