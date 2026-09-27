import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { collectProjectMessageCalls, type AgentConversationSnapshot } from "@cesium/core";
import {
  PROJECT_EVENT_DISPLAY_PREFIX,
  PROJECT_NOTICE_DISPLAY_PREFIX,
  type ProjectChildSummary,
  type ProjectPullRequestListing,
  type ProjectSnapshot,
  type ProjectSubscriptionSummary,
} from "@cesium/core/projects";

/**
 * Live probe for Projects: drives a running engine over HTTP the way a user
 * would and records what the Project does.
 *
 * It creates a Project on the given repository (optionally with a repository
 * bound on a peer engine), sends the coordinator one request, then polls the
 * Project until it goes quiet or times out, writing one JSON line per change:
 * agents (status, branch, PR), the coordinator's status and its messages to
 * the user, agent updates and events it received, subscriptions, pull
 * requests (state, CI, review) and Context files. `--then` sends one follow-up (for example
 * "merge them once CI is green") the first time the Project goes quiet.
 * At the end it writes summary.json, including `git worktree list` for each
 * repository on this machine.
 *
 *   bun ./scripts/projects-live-probe.ts --repo ~/sandbox \
 *     --prompt "The storefront needs a currency picker. Make it happen." \
 *     --model techlit/kimi-k3 --then "Merge them once CI is green."
 *
 * Options: --engine (default http://127.0.0.1:9100), --repo (repeatable),
 * --peer-repo <engineId>:<path> (repeatable), --name, --prompt, --model,
 * --merge-policy ask|when_green, --then, --quiet-min (default 3),
 * --timeout-min (default 45), --out (default tmp/projects-live-probe),
 * --username/--password (or CESIUM_ENGINE_USERNAME/_PASSWORD) for an engine
 * with a login.
 */

type Args = {
  engine: string;
  repos: string[];
  peerRepos: Array<{ engineId: string; root: string }>;
  name: string;
  prompt: string;
  model: string | null;
  mergePolicy: "ask" | "when_green" | null;
  then: string | null;
  quietMs: number;
  timeoutMs: number;
  out: string;
  username: string | null;
  password: string | null;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const COORDINATOR_BUSY = new Set(["running", "pause_requested", "pausing"]);

function parseArgs(argv: string[]): Args {
  const args: Args = {
    engine: "http://127.0.0.1:9100",
    repos: [],
    peerRepos: [],
    name: "Live probe",
    prompt: "",
    model: null,
    mergePolicy: null,
    then: null,
    quietMs: 3 * 60_000,
    timeoutMs: 45 * 60_000,
    out: path.resolve(here, "..", "tmp", "projects-live-probe"),
    username: process.env.CESIUM_ENGINE_USERNAME ?? null,
    password: process.env.CESIUM_ENGINE_PASSWORD ?? null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next == null) {
        throw new Error(`${flag} needs a value.`);
      }
      index += 1;
      return next;
    };
    switch (flag) {
      case "--engine":
        args.engine = value().replace(/\/+$/, "");
        break;
      case "--repo":
        args.repos.push(path.resolve(value()));
        break;
      case "--peer-repo": {
        const raw = value();
        const colon = raw.indexOf(":");
        if (colon <= 0) {
          throw new Error("--peer-repo takes <engineId>:<path on that engine>.");
        }
        args.peerRepos.push({ engineId: raw.slice(0, colon), root: raw.slice(colon + 1) });
        break;
      }
      case "--name":
        args.name = value();
        break;
      case "--prompt":
        args.prompt = value();
        break;
      case "--model":
        args.model = value();
        break;
      case "--merge-policy": {
        const policy = value();
        if (policy !== "ask" && policy !== "when_green") {
          throw new Error("--merge-policy is ask or when_green.");
        }
        args.mergePolicy = policy;
        break;
      }
      case "--then":
        args.then = value();
        break;
      case "--quiet-min":
        args.quietMs = Number(value()) * 60_000;
        break;
      case "--timeout-min":
        args.timeoutMs = Number(value()) * 60_000;
        break;
      case "--out":
        args.out = path.resolve(value());
        break;
      case "--username":
        args.username = value();
        break;
      case "--password":
        args.password = value();
        break;
      default:
        throw new Error(`Unknown option ${flag}.`);
    }
  }
  if (!args.prompt.trim()) {
    throw new Error("--prompt is required.");
  }
  if (args.repos.length === 0 && args.peerRepos.length === 0) {
    throw new Error("Pass at least one --repo or --peer-repo.");
  }
  return args;
}

type Engine = {
  json<T>(method: string, pathname: string, body?: unknown, workspaceId?: string): Promise<T>;
};

async function connect(args: Args): Promise<Engine> {
  let session: string | null = null;
  if (args.password) {
    const login = await fetch(`${args.engine}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: args.username ?? "admin", password: args.password }),
    });
    if (!login.ok) {
      throw new Error(`Engine login failed: HTTP ${login.status}`);
    }
    session = ((await login.json()) as { token: string }).token;
  }
  return {
    async json<T>(method: string, pathname: string, body?: unknown, workspaceId?: string): Promise<T> {
      const response = await fetch(`${args.engine}${pathname}`, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(session ? { "x-opencursor-session-token": session } : {}),
          ...(workspaceId ? { "x-opencursor-workspace-id": workspaceId } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`${method} ${pathname}: HTTP ${response.status} ${text.slice(0, 400)}`);
      }
      return (text ? JSON.parse(text) : null) as T;
    },
  };
}

function childKey(child: ProjectChildSummary): string {
  return JSON.stringify([child.status, child.bucket, child.branch, child.pr?.number, child.pr?.state, child.archivedAt, child.deletedAt]);
}

function prKey(pr: ProjectPullRequestListing): string {
  return JSON.stringify([pr.state, pr.draft, pr.ci, pr.review, pr.mergeable, pr.headSha]);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(args.out, { recursive: true });
  const logPath = path.join(args.out, "events.jsonl");
  await fs.writeFile(logPath, "");
  const startedAt = Date.now();
  const log = async (kind: string, data: Record<string, unknown>) => {
    const line = { t: new Date().toISOString(), s: Math.round((Date.now() - startedAt) / 1000), kind, ...data };
    await fs.appendFile(logPath, `${JSON.stringify(line)}\n`);
    console.log(`[${line.s}s] ${kind} ${JSON.stringify(data).slice(0, 300)}`);
  };
  const engine = await connect(args);

  let project = await engine.json<ProjectSnapshot>("POST", "/api/projects", {
    name: args.name,
    ...(args.model ? { modelId: args.model } : {}),
    repos: args.repos.map((root) => ({ root })),
  });
  for (const repo of args.peerRepos) {
    project = await engine.json<ProjectSnapshot>("POST", `/api/projects/${project.id}/repos`, repo);
  }
  if (args.mergePolicy) {
    project = await engine.json<ProjectSnapshot>("PATCH", `/api/projects/${project.id}`, {
      settings: { mergePolicy: args.mergePolicy },
    });
  }
  await log("project", { id: project.id, name: project.name, repos: project.repos, contextRoot: project.contextRoot });
  const coordinator = project.orchestrator;
  const prompt = async (text: string) => {
    await engine.json(
      "POST",
      `/api/agents/conversations/${coordinator.conversationId}/prompt`,
      { text },
      coordinator.workspaceId
    );
    await log("user", { text });
  };
  await prompt(args.prompt);

  const seenChildren = new Map<string, string>();
  const seenPrs = new Map<string, string>();
  const seenSubscriptions = new Map<string, string>();
  const seenFiles = new Set<string>();
  const loggedMessages = new Set<string>();
  let coordinatorStatus = "";
  let lastSeq = 0;
  let lastChangeAt = Date.now();
  let sentThen = false;
  let unreachable: string | null = null;
  const deadline = startedAt + args.timeoutMs;

  /** One look at the Project; "quiet" once it has settled for --quiet-min. */
  const poll = async (): Promise<"quiet" | null> => {
    let changed = false;
    const snapshot = await engine.json<ProjectSnapshot>("GET", `/api/projects/${project.id}`);
    if (unreachable) {
      unreachable = null;
      changed = true;
      await log("engine", { reachable: true });
    }
    for (const child of snapshot.children) {
      const key = childKey(child);
      if (seenChildren.get(child.id) !== key) {
        seenChildren.set(child.id, key);
        changed = true;
        await log("agent", {
          name: child.name,
          kind: child.kind,
          engine: child.engineLabel,
          status: child.status,
          bucket: child.bucket,
          branch: child.branch,
          worktree: child.worktreePath,
          pr: child.pr ? `${child.pr.repo}#${child.pr.number} ${child.pr.state} ci=${child.pr.ci ?? "none"}` : null,
          archived: child.archivedAt != null,
          deleted: child.deletedAt != null,
          lastReply: child.lastReplyPreview?.slice(0, 200) ?? null,
        });
      }
    }
    for (const subscription of snapshot.subscriptions as ProjectSubscriptionSummary[]) {
      const key = JSON.stringify([subscription.lastEventAt, subscription.closedAt]);
      if (seenSubscriptions.get(subscription.id) !== key) {
        seenSubscriptions.set(subscription.id, key);
        changed = true;
        await log("subscription", {
          label: subscription.label,
          kind: subscription.kind,
          agent: subscription.agent,
          createdBy: subscription.createdBy,
          lastEventAt: subscription.lastEventAt,
        });
      }
    }
    const prs = await engine.json<{ prs: ProjectPullRequestListing[] }>("GET", `/api/projects/${project.id}/prs`).catch(() => ({ prs: [] }));
    for (const pr of prs.prs) {
      const id = `${pr.repo}#${pr.number}`;
      if (seenPrs.get(id) !== prKey(pr)) {
        seenPrs.set(id, prKey(pr));
        changed = true;
        await log("pr", { pr: id, url: pr.url, title: pr.title, agent: pr.agent, state: pr.state, ci: pr.ci, review: pr.review, failedChecks: pr.failedChecks });
      }
    }
    const context = await engine.json<{ files: Array<{ path: string; size: number }> }>("GET", `/api/projects/${project.id}/context`);
    const newFiles = context.files.filter((file) => !seenFiles.has(file.path));
    if (newFiles.length > 0) {
      newFiles.forEach((file) => seenFiles.add(file.path));
      changed = true;
      await log("context", { added: newFiles.map((file) => `${file.path} (${file.size} B)`) });
    }
    const { snapshot: conversation } = await engine.json<{ snapshot: AgentConversationSnapshot }>(
      "GET",
      `/api/agents/conversations/${coordinator.conversationId}?full=1`,
      undefined,
      coordinator.workspaceId
    );
    for (const call of collectProjectMessageCalls(conversation.events).values()) {
      if (!loggedMessages.has(call.toolCallId)) {
        loggedMessages.add(call.toolCallId);
        changed = true;
        await log("message", { text: call.message, ...(call.failed ? { failed: true } : {}) });
      }
    }
    for (const event of conversation.events.filter((entry) => entry.seq > lastSeq).sort((a, b) => a.seq - b.seq)) {
      lastSeq = Math.max(lastSeq, event.seq);
      const display = event.kind === "user_message" ? event.displayContent : undefined;
      if (
        event.kind === "user_message" &&
        display &&
        (display.startsWith(PROJECT_NOTICE_DISPLAY_PREFIX) || display.startsWith(PROJECT_EVENT_DISPLAY_PREFIX))
      ) {
        changed = true;
        await log("update", { display, text: event.content.slice(0, 2_000) });
      }
    }
    if (conversation.conversation.status !== coordinatorStatus) {
      coordinatorStatus = conversation.conversation.status;
      changed = true;
      await log("coordinator", { status: coordinatorStatus, queued: conversation.conversation.queuedPrompts.length });
    }
    if (changed) {
      lastChangeAt = Date.now();
    }
    // Waiting on the user (an agent's permission prompt, a question) is as settled as done.
    const working = snapshot.children.some((child) => child.deletedAt == null && child.bucket === "working");
    const quiet =
      !working &&
      !COORDINATOR_BUSY.has(coordinatorStatus) &&
      conversation.conversation.queuedPrompts.length === 0 &&
      Date.now() - lastChangeAt >= Math.min(args.quietMs, 60_000);
    if (quiet && args.then && !sentThen) {
      sentThen = true;
      lastChangeAt = Date.now();
      await prompt(args.then);
      return null;
    }
    if (quiet && Date.now() - lastChangeAt >= args.quietMs) {
      await log("quiet", {
        minutes: args.quietMs / 60_000,
        coordinator: coordinatorStatus,
        needsYou: snapshot.children
          .filter((child) => child.deletedAt == null && child.bucket === "needs_attention")
          .map((child) => child.name),
      });
      return "quiet";
    }
    return null;
  };

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    try {
      if ((await poll()) === "quiet") {
        break;
      }
    } catch (error) {
      // The engine restarting mid-run: keep polling until it answers again.
      const message = error instanceof Error ? error.message : String(error);
      if (unreachable !== message) {
        unreachable = message;
        await log("engine", { reachable: false, error: message.slice(0, 300) });
      }
    }
  }
  if (Date.now() >= deadline) {
    await log("timeout", { minutes: args.timeoutMs / 60_000 });
  }

  const final = await engine.json<ProjectSnapshot>("GET", `/api/projects/${project.id}`);
  const finalPrs = await engine.json<{ prs: ProjectPullRequestListing[] }>("GET", `/api/projects/${project.id}/prs`).catch(() => ({ prs: [] }));
  const worktrees: Record<string, string> = {};
  for (const root of args.repos) {
    worktrees[root] = await execFileAsync("git", ["-C", root, "worktree", "list"]).then(
      (result) => result.stdout.trim(),
      (error: unknown) => `git worktree list failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const summary = {
    project: { id: final.id, name: final.name, contextRoot: final.contextRoot },
    elapsedMinutes: Math.round((Date.now() - startedAt) / 6_000) / 10,
    agents: final.children.map((child) => ({
      name: child.name,
      kind: child.kind,
      engine: child.engineLabel,
      status: child.status,
      branch: child.branch,
      worktree: child.worktreePath,
      pr: child.pr?.url ?? null,
      deleted: child.deletedAt != null,
      archived: child.archivedAt != null,
    })),
    pullRequests: finalPrs.prs.map((pr) => ({ pr: `${pr.repo}#${pr.number}`, url: pr.url, state: pr.state, ci: pr.ci, review: pr.review })),
    subscriptions: final.subscriptions.map((subscription) => subscription.label),
    contextFiles: [...seenFiles].sort(),
    worktrees,
  };
  await fs.writeFile(path.join(args.out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nWrote ${logPath} and ${path.join(args.out, "summary.json")}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
