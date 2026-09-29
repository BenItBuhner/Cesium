import type { CesiumToolDefinition } from "../agents/cesium/features/types.js";

const KIND = "orchestration";

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

const AGENT_REF = {
  type: "string",
  description: "Agent name (as listed by project_list_agents) or agent id.",
};

const PR_REF = {
  type: "string",
  description: "PR number, owner/repo#N, its URL, or the owning agent's name.",
};

/**
 * The Project orchestrator's entire tool surface besides `ask_question`. It
 * manages agents and Project context; it never touches repositories itself.
 */
export const PROJECT_ORCHESTRATOR_TOOLS: CesiumToolDefinition[] = [
  {
    name: "project_message_user",
    kind: KIND,
    title: "Message",
    description:
      "Send the user a message (markdown). This is how you talk to the user: send one whenever there is something for them to read, several per turn if useful. Your final reply in a turn is only a short status line for the log. Embed evidence from the Project context: ![what it shows](context:media/cart/after.png) for images, [demo video](context:media/cart/demo.mp4) for recordings.",
    parameters: {
      type: "object",
      required: ["message"],
      properties: { message: { type: "string", description: "Markdown shown to the user." } },
      additionalProperties: false,
    },
  },
  {
    name: "project_explore",
    kind: KIND,
    title: (args) => `Explore ${str(args, "repo")}`.trim(),
    description:
      "Ask read-only code explorers about one of the Project's repositories, on whichever engine holds it, and wait for their answers. Each question gets its own explorer on a clean checkout of the base branch and they all work at once, so put separate questions in one call. Use it to plan from a vague request before creating agents. Answers are saved under internal/explore/; an explorer that takes more than a few minutes reports back as an agent update instead.",
    parameters: {
      type: "object",
      required: ["repo", "questions"],
      properties: {
        repo: { type: "string", description: "Repository name from the Project state." },
        questions: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 4,
          description: "One to four separate questions, e.g. where the cart total is computed and which tests cover it.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "project_browser_check",
    kind: KIND,
    title: (args) => `Browser check ${str(args, "agent") || str(args, "url")}`.trim(),
    description:
      "Start a QA helper that runs an agent's branch on that agent's engine (or opens a URL) in a real browser, checks the behavior you describe, and saves screenshots and a recording under media/<helper>/ in the Project context. It reports back as an agent update; embed its evidence when you tell the user.",
    parameters: {
      type: "object",
      required: ["what"],
      properties: {
        what: { type: "string", description: "The behavior to check, step by step if it matters." },
        agent: { type: "string", description: "Agent whose working tree to run." },
        url: { type: "string", description: "A URL to open instead of running an agent's branch." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "project_preferences",
    kind: KIND,
    title: (args) => `Preferences: ${str(args, "action") || "read"}`,
    description:
      "Read or change the user's lasting preferences, which apply to every Project and every agent. Add one when the user states how they always want things done ('always…', 'never…', 'from now on…'); remove lines that no longer hold.",
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["read", "add", "remove"] },
        text: { type: "string", description: "add: the preference, one sentence. remove: words from the line to drop." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "project_list_engines",
    kind: KIND,
    title: "List engines",
    description:
      "List the engines (machines) this Project can place agents on, with the repositories bound on each and the agent harnesses available there. Call before creating agents on another engine or harness.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "project_create_agent",
    kind: KIND,
    title: (args) => `Create agent ${str(args, "name")}`.trim(),
    description:
      "Create a worker agent and start it on its first task immediately. With `repo`, it gets its own git worktree on a fresh branch from the repo's base branch, so workers never collide; it is told to test, push, open a pull request and report. Instructions must be self-contained: goal, constraints, what done means, and what to report. Omit engine/harness/model to use the Project defaults; without `repo` the agent gets an empty scratch folder.",
    parameters: {
      type: "object",
      required: ["name", "instructions"],
      properties: {
        name: {
          type: "string",
          description: "Short handle, e.g. api-tests. Lowercase letters, digits and dashes.",
        },
        instructions: { type: "string", description: "The agent's first task, in full." },
        repo: { type: "string", description: "Repository name from project_list_engines." },
        isolation: {
          type: "string",
          enum: ["worktree", "checkout", "scratch"],
          description:
            "worktree (default with a repo): its own worktree and branch. checkout: work directly in the repository checkout, only when the user asks for work on their machine as it is. scratch: an empty folder.",
        },
        base: {
          type: "string",
          description: "Branch the worktree starts from. Default: the repository's base branch (the remote default).",
        },
        engine: {
          type: "string",
          description: "Engine name from project_list_engines, for scratch work on that machine. Default: this engine.",
        },
        harness: {
          type: "string",
          description:
            "Agent harness id available on the target engine (see project_list_engines), e.g. cesium-agent or codex-app-server. A harness that is not installed or has no credentials there is refused. Default: Project default.",
        },
        model: {
          type: "string",
          description:
            "Model id for the harness. Default: the Project default on this engine, the engine's harness default elsewhere. For cesium-agent, pick from <available-models>: a model with no credentials on the target engine is replaced by the default, and the result carries a `warning` saying so.",
        },
        mode: { type: "string", description: "Harness mode, e.g. agent or plan. Default: agent." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "project_list_agents",
    kind: KIND,
    title: (args) => (str(args, "agent") ? `Check ${str(args, "agent")}` : "List agents"),
    description:
      "Snapshot of the Project's agents: status bucket, engine, harness, model, repo, queued messages, last reply preview, and anything waiting on a human. Pass `agent` for one agent. Use it to plan or to answer the user, never to wait for work to finish: agents report back on their own with a <project_agent_updates> message after your turn ends, so nothing changes while you keep checking, and an unchanged repeat check returns only a reminder to end your turn.",
    parameters: {
      type: "object",
      properties: {
        agent: AGENT_REF,
        include_archived: { type: "boolean", description: "Also list archived agents." },
        include_deleted: { type: "boolean", description: "Also list archived and deleted agents." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "project_steer_agent",
    kind: KIND,
    title: (args) => `Steer ${str(args, "agent")}`.trim(),
    description:
      "Redirect an agent. If it is working, the message is injected into its current turn when the harness supports that (otherwise it runs right after the current turn); if idle, it starts a turn now. Returns how it landed: mid_turn, queued_steer, queued, or started.",
    parameters: {
      type: "object",
      required: ["agent", "message"],
      properties: { agent: AGENT_REF, message: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "project_queue_agent",
    kind: KIND,
    title: (args) => `Queue for ${str(args, "agent")}`.trim(),
    description:
      "Give an agent its next task. Runs after its current turn and anything already queued; starts now if it is idle.",
    parameters: {
      type: "object",
      required: ["agent", "message"],
      properties: { agent: AGENT_REF, message: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "project_stop_agent",
    kind: KIND,
    title: (args) => `Stop ${str(args, "agent")}`.trim(),
    description:
      "Stop an agent's current turn and clear its queued messages. The agent stays in the Project and can be steered or queued again.",
    parameters: {
      type: "object",
      required: ["agent"],
      properties: { agent: AGENT_REF },
      additionalProperties: false,
    },
  },
  {
    name: "project_update_agent",
    kind: KIND,
    title: (args) => `Update ${str(args, "agent")}`.trim(),
    description: "Rename an agent or change its model or mode. Takes effect on its next turn.",
    parameters: {
      type: "object",
      required: ["agent"],
      properties: {
        agent: AGENT_REF,
        name: { type: "string", description: "New handle." },
        model: {
          type: "string",
          description:
            "New model id. For cesium-agent it must have credentials on the agent's engine, otherwise the update is refused.",
        },
        mode: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "project_archive_agent",
    kind: KIND,
    title: (args) =>
      `${args.unarchive === true ? "Restore" : "Archive"} ${str(args, "agent")}`.trim(),
    description:
      "Archive an agent whose work is done: stops it and hides it from the roster while keeping its conversation, worktree, branch and pull request. Pass unarchive: true to bring it back.",
    parameters: {
      type: "object",
      required: ["agent"],
      properties: {
        agent: AGENT_REF,
        unarchive: { type: "boolean", description: "Restore an archived agent." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "project_delete_agent",
    kind: KIND,
    title: (args) => `Delete ${str(args, "agent")}`.trim(),
    description:
      "Stop an agent and permanently delete its conversation and worktree (its pushed branch and pull request stay). Prefer project_archive_agent; delete abandoned scratch work. Read its transcript first if you still need anything from it.",
    parameters: {
      type: "object",
      required: ["agent"],
      properties: { agent: AGENT_REF },
      additionalProperties: false,
    },
  },
  {
    name: "project_adopt_agent",
    kind: KIND,
    title: "Adopt a conversation",
    description:
      "Bring an existing conversation on this engine into the Project as an agent (when the user asks you to take over one of their chats). It keeps its folder and reports its turns to you from then on.",
    parameters: {
      type: "object",
      required: ["conversation"],
      properties: {
        conversation: { type: "string", description: "Conversation id or its exact title." },
        name: { type: "string", description: "Agent handle; default: from its title." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "project_read_transcript",
    kind: KIND,
    title: (args) =>
      str(args, "agent") ? `Read ${str(args, "agent")} transcript` : "Read transcript",
    description:
      "Read an agent's recent conversation: its messages, replies, tool calls and failures for the last `turns` turns (default 3, max 20). Long transcripts keep the most recent part.",
    parameters: {
      type: "object",
      required: ["agent"],
      properties: {
        agent: AGENT_REF,
        turns: { type: "integer", minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "project_list_prs",
    kind: KIND,
    title: "List pull requests",
    description:
      "The pull requests this Project tracks (each agent's own, plus PRs you follow): state, draft, CI result and failed checks, review decision, mergeability, and the owning agent.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "project_merge_pr",
    kind: KIND,
    title: (args) => `Merge ${str(args, "pr")}`.trim(),
    description:
      "Squash-merge a tracked pull request as `PR title (#N)`, keeping its branch. Only when the user has explicitly told you to merge: pass their words as user_quote (it must appear in their recent messages). It needs an open, ready PR with green CI and no requested changes.",
    parameters: {
      type: "object",
      required: ["pr"],
      properties: {
        pr: PR_REF,
        user_quote: {
          type: "string",
          description: "The user's own words authorizing this merge, copied from their message.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "project_close_pr",
    kind: KIND,
    title: (args) => `Close ${str(args, "pr")}`.trim(),
    description:
      "Close a pull request without merging it and post your reason on it, e.g. when it is redundant or another one supersedes it. Close your agents' own pull requests on your own judgment. Closing anyone else's pull request in the Project's repositories (owner/repo#N) needs the user's explicit go-ahead: pass their words as user_quote. Its subscriptions close with it.",
    parameters: {
      type: "object",
      required: ["pr", "reason"],
      properties: {
        pr: PR_REF,
        reason: { type: "string", description: "Why it is being closed, posted on the pull request." },
        user_quote: {
          type: "string",
          description: "Only for a pull request no agent of this Project opened: the user's own words telling you to close it.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "project_request_review",
    kind: KIND,
    title: (args) => `Request review on ${str(args, "pr")}`.trim(),
    description:
      "Ask reviewers to look at a tracked pull request again, e.g. once its agent has pushed fixes for their comments. Without `reviewers` it asks everyone whose latest review requested changes or only commented. A note is posted on the pull request mentioning them.",
    parameters: {
      type: "object",
      required: ["pr"],
      properties: {
        pr: PR_REF,
        reviewers: { type: "array", items: { type: "string" }, description: "GitHub logins to ask." },
        note: { type: "string", description: "What changed since their review." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "project_request_rebase",
    kind: KIND,
    title: (args) => `Rebase ${str(args, "pr")}`.trim(),
    description:
      "Ask the agent that owns a conflicting pull request to rebase its branch onto the latest base branch, resolve the conflicts keeping both sides, rerun the tests and force-push. Use it whenever a pull request conflicts (a conflict event, or a merge refused for conflicts) instead of giving up on it. The request runs after the agent's current turn.",
    parameters: {
      type: "object",
      required: ["pr"],
      properties: {
        pr: PR_REF,
        note: { type: "string", description: "Context for the agent, e.g. which merged pull request it now conflicts with." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "project_subscribe",
    kind: KIND,
    title: (args) => `Listen: ${str(args, "kind") || "subscription"}`,
    description:
      "Start listening for events that wake you in a new turn. github_pr: comments, reviews, review comments, merge/close of one PR (closes itself when it merges). github_ci: one result per commit on a branch (failures always; a pass only first or after a failure). timer: runs your prompt on a cron schedule, every N minutes, or once after N minutes. Agents' own PRs and their CI are followed automatically. After subscribing, say what you are waiting for and end your turn.",
    parameters: {
      type: "object",
      required: ["kind"],
      properties: {
        kind: { type: "string", enum: ["github_pr", "github_ci", "timer"] },
        pr: { type: "string", description: "github_pr: owner/repo#N or the PR URL." },
        repo: { type: "string", description: "github_ci: owner/repo." },
        branch: { type: "string", description: "github_ci: branch to watch." },
        name: { type: "string", description: "timer: short unique name (a timer with the same name is replaced)." },
        prompt: { type: "string", description: "timer: what to do when it fires." },
        cron: { type: "string", description: 'timer: 5-field cron in the engine\'s local time, e.g. "0 8 * * *".' },
        every_minutes: { type: "number", description: "timer: repeat every N minutes (at least 1)." },
        in_minutes: { type: "number", description: "timer: fire once after N minutes." },
        keep_after_close: {
          type: "boolean",
          description: "github_pr: keep watching after it merges or closes (only if the user asked).",
        },
        expires_in_days: { type: "number", description: "Stop listening after this many days (default 90, max 180)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "project_list_subscriptions",
    kind: KIND,
    title: "List subscriptions",
    description: "What this Project is listening to (the Listening list), with ids for project_unsubscribe.",
    parameters: {
      type: "object",
      properties: { include_closed: { type: "boolean", description: "Also list recently closed ones." } },
      additionalProperties: false,
    },
  },
  {
    name: "project_unsubscribe",
    kind: KIND,
    title: (args) => `Stop listening ${str(args, "id")}`.trim(),
    description: "Stop one subscription by id.",
    parameters: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "project_context_list",
    kind: KIND,
    title: "List Project context",
    description:
      "List the files in the Project context folder (notes.md plus any specs, reports or checklists you keep there).",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "project_context_read",
    kind: KIND,
    title: (args) => `Read ${str(args, "path") || "context file"}`,
    description: "Read a text file from the Project context folder.",
    parameters: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string", description: "Relative path, e.g. notes.md." } },
      additionalProperties: false,
    },
  },
  {
    name: "project_context_write",
    kind: KIND,
    title: (args) => `Write ${str(args, "path") || "context file"}`,
    description:
      "Create, replace or append to a text file in the Project context folder. Keep notes.md current: goals, decisions, agent roster and status, open questions.",
    parameters: {
      type: "object",
      required: ["path", "content"],
      properties: {
        path: { type: "string", description: "Relative path, e.g. notes.md or specs/api.md." },
        content: { type: "string" },
        mode: { type: "string", enum: ["replace", "append"], description: "Default: replace." },
      },
      additionalProperties: false,
    },
  },
];

export const PROJECT_ORCHESTRATOR_TOOL_NAMES = new Set(
  PROJECT_ORCHESTRATOR_TOOLS.map((tool) => tool.name)
);

/** Tools the orchestrator borrows from the ordinary harness surface. */
export const PROJECT_ORCHESTRATOR_BORROWED_TOOLS = ["ask_question"] as const;

export const PROJECT_ORCHESTRATOR_SYSTEM_PROMPT = [
  "You are the coordinator of a Cesium Project: a long-running body of work the user directs by talking only to you. You never do the work yourself, and you have no tools for code, terminals or repositories. You turn every request into work for agents, keep the Project organized, and bring the results back.",
  "",
  "How you work:",
  "- Every request that needs work becomes agents right away. Split it into independent tasks and start them in parallel with project_create_agent, one agent per independent change. Then reply briefly and end your turn, so you stay free for the user.",
  "- Vague requests: plan it yourself, never ask the user for steps. If you don't know the code, ask project_explore (separate questions in one call run at once) or start a research agent that writes its findings to docs/ in the Project context (it changes no code, so it opens no pull request). Then write the plan as a checklist in notes.md, start the agents, and tell the user what is running.",
  "- Decide the details yourself and append each decision with its reason to docs/decisions.md. Ask the user (ask_question) only about choices that are genuinely theirs: money, product direction, public APIs, deleting things.",
  "- Briefs stand alone: the goal, which repository, constraints, what done means and what to report. With a repository each agent gets its own worktree and branch and is told to test, push, open a pull request and capture screenshots or a recording for visible changes.",
  "- Talk to the user with project_message_user. Your final reply in a turn is only a short status line for the log. Embed evidence from the Project context in messages: ![what it shows](context:media/<agent>/<file>.png).",
  "- Agent updates (<project_agent_updates>) and external events (<project_events>: pull request activity, CI, timers) arrive as turns of their own, never while you are working, so don't poll. Handle them: read a transcript when the preview is not enough, send review comments and CI failures to the owning agent with project_queue_agent, keep notes.md current. Message the user only when there is an outcome or a decision for them; otherwise end the turn quietly.",
  "- Check before you claim: read the agent's transcript, its pull request and CI, and look at its evidence before telling the user something is done. Use project_browser_check to verify visible changes in a real browser.",
  "- notes.md is the Project's live status board, shown to the user under the chat. Keep it a short checklist (- [ ] / - [x]) of what is being worked on and by whom, with links to pull requests and docs. Longer material goes in docs/ (for the user) and internal/ (for agents).",
  "- Steer an agent that is working now with project_steer_agent; give an idle agent its next task with project_queue_agent. Archive an agent once its work is merged or abandoned; an agent whose branch still waits on the user stays listed.",
  "- Merge pull requests only as the merge policy in the Project state allows. Under \"ask\" the user must have told you to merge, and you pass their words as user_quote.",
  "- Keep pull requests moving. When one conflicts with its base, have its agent rebase it with project_request_rebase instead of giving up on it. When an agent has pushed fixes for review comments, ask the reviewers again with project_request_review. Close a redundant or superseded pull request with project_close_pr and say why; someone else's pull request only when the user tells you to.",
  "- When the user states a lasting preference (\"always…\", \"never…\", \"from now on…\"), record it with project_preferences. Follow the recorded preferences; agents get them too.",
  "- Keep your messages short and concrete: what you started and why, what came back, what happens next.",
].join("\n");
