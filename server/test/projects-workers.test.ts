import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ProjectChildSummary, ProjectContextFile, ProjectSnapshot, ProjectSummary } from "@cesium/core/projects";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";
import { messageText, startFakeChatModel, text, waitFor } from "./helpers/fake-chat-model.js";
import { createRepoWithRemote, git, pushCommitToRemote, tryGitOutput } from "./helpers/git-fixtures.js";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-projects-workers-"));
const SHOP_REPO = path.join(TEST_DATA_DIR, "repos", "shop");
const SHOP_REMOTE = path.join(TEST_DATA_DIR, "remotes", "shop.git");
const NOTES_FOLDER = path.join(TEST_DATA_DIR, "repos", "notes");
const SCRATCH = path.join(TEST_DATA_DIR, "scratch");
await fs.mkdir(NOTES_FOLDER, { recursive: true });
await fs.mkdir(SCRATCH, { recursive: true });
await createRepoWithRemote({
  repoDir: SHOP_REPO,
  remoteDir: SHOP_REMOTE,
  files: { "README.md": "# Shop\n", "src/cart.js": "export const cart = [];\n" },
});

for (const key of [
  "REDIS_URL",
  "DATABASE_URL",
  "OPENCURSOR_STORAGE_DRIVER",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "OPENCURSOR_TRANSCRIPTION_BASE_URL",
  "OPENCURSOR_TRANSCRIPTION_API_KEY",
  "OPENCURSOR_TITLE_MODEL",
  "CESIUM_MODELS",
  "CESIUM_PROJECTS_ENABLED",
]) {
  delete process.env[key];
}
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
process.env.WORKSPACE_ALLOWED_ROOTS = TEST_DATA_DIR;
process.env.CESIUM_ENGINE_LABEL = "Home";

const model = await startFakeChatModel();
const { script } = model;
process.env.CESIUM_BASE_URL = model.baseUrl;
process.env.CESIUM_API_KEY = "sk-test-projects";
process.env.CESIUM_PROVIDER_ID = "projhost";
process.env.CESIUM_DEFAULT_MODEL = "kimi-k3";
const MODEL_ID = "projhost/kimi-k3";

const [
  { createCesiumApp },
  { agentRuntimeManager },
  { readConversationRecord, readConversationSnapshot },
  { startAgentPromptQueueDrainListener },
  { startProjectWatcher },
  { readProject },
  { getWorkspaceById },
  { buildAgentConversationsAllPayload },
] = await Promise.all([
  import("../src/app.js"),
  import("../src/lib/agents/runtime-manager.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/agents/prompt-queue-drain.js"),
  import("../src/lib/projects/project-watcher.js"),
  import("../src/lib/projects/project-store.js"),
  import("../src/lib/workspace-registry.js"),
  import("../src/lib/agents/rail-payload.js"),
]);

const app = createCesiumApp();
startAgentPromptQueueDrainListener();
const stopWatcher = startProjectWatcher();

after(async () => {
  stopWatcher();
  await model.close();
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

type Json = Record<string, unknown>;

async function api<T = Json>(
  method: string,
  pathname: string,
  body?: unknown
): Promise<{ status: number; json: T }> {
  const response = await app.request(pathname, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as T };
}

function eventsOfKind<K extends AgentStoredEvent["kind"]>(
  events: AgentStoredEvent[],
  kind: K
): Array<Extract<AgentStoredEvent, { kind: K }>> {
  return events.filter((event): event is Extract<AgentStoredEvent, { kind: K }> => event.kind === kind);
}

let project: ProjectSnapshot;
const shopRepoReal = await fs.realpath(SHOP_REPO);
const worktreesRoot = () => path.join(TEST_DATA_DIR, "projects", project.id, "worktrees");

async function childRecord(name: string) {
  const record = await readProject(project.id);
  const child = record?.children.find((entry) => entry.name === name);
  assert.ok(child, `child ${name} exists`);
  return child;
}

async function firstPrompt(name: string): Promise<string> {
  const child = await childRecord(name);
  const snapshot = await readConversationSnapshot(child.workspaceId, child.conversationId);
  assert.ok(snapshot);
  return eventsOfKind(snapshot.events, "user_message")[0]!.content;
}

async function worktreeList(): Promise<string[]> {
  const porcelain = await git(SHOP_REPO, ["worktree", "list", "--porcelain"]);
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

async function createAgent(body: Json) {
  return api<{ agent: ProjectChildSummary; warning?: string; error?: string }>(
    "POST",
    `/api/projects/${project.id}/agents`,
    body
  );
}

test("a Project binds a git repository and a plain folder", async () => {
  const created = await api<ProjectSnapshot>("POST", "/api/projects", {
    name: "Shop launch",
    modelId: MODEL_ID,
    repos: [{ root: SHOP_REPO }, { root: NOTES_FOLDER }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  project = created.json;
  assert.deepEqual(project.repos.map((repo) => repo.name), ["shop", "notes"]);
  const context = await api<{ files: ProjectContextFile[]; folders: string[] }>(
    "GET",
    `/api/projects/${project.id}/context`
  );
  assert.deepEqual(context.json.folders, ["docs", "internal", "media"]);
  assert.deepEqual(context.json.files.map((file) => [file.path, file.kind]), [["notes.md", "text"]]);
});

test("workers on one repository each get their own worktree and branch from the fetched remote base", async () => {
  // The checkout's origin/main is now stale: workers must start from the remote's newest commit.
  const remoteHead = await pushCommitToRemote({
    remoteDir: SHOP_REMOTE,
    scratchDir: SCRATCH,
    files: { "src/checkout.js": "export function checkout() {}\n" },
    message: "Add checkout",
  });
  script("cart", text(["Cart fixed. PR: none yet."]));
  script("checkout", text(["Checkout hardened."]));
  const cart = await createAgent({ name: "cart", repo: "shop", instructions: "Fix the cart." });
  const checkout = await createAgent({ name: "checkout", repo: "shop", instructions: "Harden checkout." });
  assert.equal(cart.status, 201, JSON.stringify(cart.json));
  assert.equal(checkout.status, 201, JSON.stringify(checkout.json));
  const realWorktrees = await fs.realpath(worktreesRoot());
  for (const [name, agent] of [["cart", cart.json.agent], ["checkout", checkout.json.agent]] as const) {
    assert.equal(agent.isolation, "worktree", name);
    assert.match(agent.branch ?? "", new RegExp(`^cesium/shop-launch/${name}-[0-9a-f]{4}$`), name);
    assert.equal(agent.baseRef, "origin/main", name);
    assert.equal(path.dirname(agent.worktreePath ?? ""), realWorktrees, name);
    assert.equal(await git(agent.worktreePath!, ["rev-parse", "--abbrev-ref", "HEAD"]), agent.branch);
    assert.equal(await git(agent.worktreePath!, ["rev-parse", "HEAD"]), remoteHead, `${name} starts at the fetched remote head`);
    assert.equal(
      await tryGitOutput(agent.worktreePath!, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
      null,
      "the branch does not track the base, so `git push -u origin <branch>` sets its upstream"
    );
    const workspace = await getWorkspaceById(agent.workspaceId);
    assert.equal(workspace?.kind, "project", "worker worktrees are engine-managed workspaces");
    assert.equal((await childRecord(name)).baseSha, remoteHead);
  }
  assert.notEqual(cart.json.agent.worktreePath, checkout.json.agent.worktreePath);
  assert.notEqual(cart.json.agent.branch, checkout.json.agent.branch);
  const listed = await worktreeList();
  assert.ok(listed.includes(cart.json.agent.worktreePath!));
  assert.ok(listed.includes(checkout.json.agent.worktreePath!));

  await fs.writeFile(path.join(cart.json.agent.worktreePath!, "src", "cart.js"), "export const cart = ['fixed'];\n");
  assert.equal(
    await fs.readFile(path.join(checkout.json.agent.worktreePath!, "src", "cart.js"), "utf8"),
    "export const cart = [];\n",
    "one worker's edits never reach another's worktree"
  );
  assert.equal(await git(SHOP_REPO, ["status", "--porcelain"]), "", "the user's checkout stays clean");
  assert.equal(await git(SHOP_REPO, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");

  const brief = await firstPrompt("cart");
  assert.match(brief, /^<project_worker_brief>\nYou are "cart", a worker agent in the Cesium Project "Shop launch"/);
  assert.ok(brief.includes(`own git worktree at ${cart.json.agent.worktreePath}, on branch \`${cart.json.agent.branch}\``));
  assert.ok(brief.includes(`created from origin/main (${remoteHead.slice(0, 12)})`));
  assert.ok(brief.includes(`git push -u origin ${cart.json.agent.branch}`));
  assert.match(brief, /A pull request is open for `cesium\/shop-launch\/cart-[0-9a-f]{4}` against `main`, ready for review/);
  assert.ok(brief.includes(`- Folder: ${project.contextRoot}`));
  assert.ok(brief.includes("It is not part of any repository, and nothing in it is committed."));
  assert.ok(brief.includes(`${project.contextRoot}/docs/ holds documents the user reads`), "Context paths are absolute, not the repo's docs/");
  assert.ok(brief.includes(`${project.contextRoot}/internal/cart/ is for your handoffs`));
  assert.ok(brief.includes(`${project.contextRoot}/media/cart/`));
  assert.ok(
    brief.includes(
      `If your task changes no code (research, an investigation, a plan), your findings go in ${project.contextRoot}/internal/cart/ and your report: don't commit them to the repository or open a pull request.`
    )
  );
  assert.match(brief, /the pull request URL, the evidence file paths/);
  assert.match(brief, /Fix the cart\.$/);

  await waitFor(
    "both workers report",
    async () => Promise.all([childRecord("cart"), childRecord("checkout")]),
    (children) => children.every((child) => child.turnsCompleted === 1)
  );
  assert.equal(
    await git(cart.json.agent.worktreePath!, ["status", "--porcelain"]),
    "M src/cart.js",
    "the engine's skills and MCP mirrors stay out of the worker's changes"
  );
  assert.equal(await tryGitOutput(SHOP_REPO, ["diff", "--quiet", "HEAD", "--", ".gitignore"]), "");
  const exclude = await fs.readFile(path.join(SHOP_REPO, ".git", "info", "exclude"), "utf8");
  for (const entry of ["agent-skills/", "mcp-servers/", ".cesium/"]) {
    assert.ok(exclude.split("\n").includes(entry), `${entry} is excluded for every worktree`);
  }
  const rail = await buildAgentConversationsAllPayload({ limit: 200, offset: 0 });
  const workerIds = new Set([cart.json.agent.conversationId, checkout.json.agent.conversationId]);
  assert.equal(
    rail.groups.some((group) => group.workspace.id === cart.json.agent.workspaceId),
    false,
    "worker worktrees are not rail groups"
  );
  assert.equal(
    rail.groups.some((group) => group.conversations.some((conversation) => workerIds.has(conversation.id))),
    false,
    "workers never show in the repo rail"
  );
});

test("a repository's worktree setup commands are handed to the worker first", async () => {
  await pushCommitToRemote({
    remoteDir: SHOP_REMOTE,
    scratchDir: SCRATCH,
    files: { ".cursor/worktrees.json": JSON.stringify({ "setup-worktree": ["npm ci --prefer-offline"] }) },
    message: "Add worktree setup",
  });
  script("setup", text(["Set up and done."]));
  const created = await createAgent({ name: "setup", repo: "shop", instructions: "Run the tests." });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const brief = await firstPrompt("setup");
  assert.match(brief, /Before anything else, run this repository's worktree setup/);
  assert.match(brief, /\.cursor\/worktrees\.json/);
  assert.match(brief, /\n {4}npm ci --prefer-offline\n/);
});

test("checkout isolation is opt-in, plain folders fall back, and a demanded worktree needs git", async () => {
  script("local", text(["Ran on the checkout."]));
  const local = await createAgent({ name: "local", repo: "shop", isolation: "checkout", instructions: "Run it here." });
  assert.equal(local.status, 201, JSON.stringify(local.json));
  assert.equal(local.json.agent.isolation, "checkout");
  assert.equal(local.json.agent.branch, null);
  assert.equal(local.json.agent.workspaceId, project.repos[0]!.workspaceId);
  assert.match(await firstPrompt("local"), /work directly in the "shop" checkout at /);

  script("plain", text(["Notes tidied."]));
  const plain = await createAgent({ name: "plain", repo: "notes", instructions: "Tidy the notes." });
  assert.equal(plain.status, 201, JSON.stringify(plain.json));
  assert.equal(plain.json.agent.isolation, "checkout");
  assert.match(String(plain.json.warning), /notes is not a git repository/);

  const demanded = await createAgent({ name: "strict", repo: "notes", isolation: "worktree", instructions: "x" });
  assert.equal(demanded.status, 400);
  assert.match(String(demanded.json.error), /not a git repository/);
  const noRepo = await createAgent({ name: "nowhere", isolation: "worktree", instructions: "x" });
  assert.equal(noRepo.status, 400);
  assert.match(String(noRepo.json.error), /needs a repository/);
  const badBase = await createAgent({ name: "based", repo: "shop", base: "no-such-branch", instructions: "x" });
  assert.equal(badBase.status, 400);
  assert.match(String(badBase.json.error), /Base branch "no-such-branch" does not exist/);
  const worktrees = await fs.readdir(worktreesRoot());
  assert.equal(worktrees.some((entry) => entry.startsWith("based-")), false, "a failed placement leaves nothing behind");
});

test("archiving stops and hides a worker, and unarchiving restores it", async () => {
  const archived = await api<{ agent: ProjectChildSummary }>(
    "POST",
    `/api/projects/${project.id}/agents/cart/archive`,
    { archived: true }
  );
  assert.equal(archived.status, 200, JSON.stringify(archived.json));
  assert.equal(typeof archived.json.agent.archivedAt, "number");
  const visible = await api<{ agents: ProjectChildSummary[] }>("GET", `/api/projects/${project.id}/agents`);
  assert.equal(visible.json.agents.some((agent) => agent.name === "cart"), false);
  const all = await api<{ agents: ProjectChildSummary[] }>(
    "GET",
    `/api/projects/${project.id}/agents?includeArchived=1`
  );
  assert.equal(all.json.agents.some((agent) => agent.name === "cart"), true);
  const listed = await api<{ projects: ProjectSummary[] }>("GET", "/api/projects");
  const summary = listed.json.projects.find((entry) => entry.id === project.id)!;
  assert.equal(summary.agentCount, visible.json.agents.length, "archived agents are not counted");
  await fs.access(archived.json.agent.worktreePath!);

  const restored = await api<{ agent: ProjectChildSummary }>(
    "POST",
    `/api/projects/${project.id}/agents/cart/archive`,
    { archived: false }
  );
  assert.equal(restored.json.agent.archivedAt, null);
  const again = await api<{ agents: ProjectChildSummary[] }>("GET", `/api/projects/${project.id}/agents`);
  assert.equal(again.json.agents.some((agent) => agent.name === "cart"), true);
});

test("deleting a worker removes its worktree and keeps its branch", async () => {
  const checkout = await childRecord("checkout");
  const removed = await api("DELETE", `/api/projects/${project.id}/agents/checkout`);
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  await assert.rejects(fs.access(checkout.worktreePath!), "the worktree folder is gone");
  assert.equal((await worktreeList()).includes(checkout.worktreePath!), false, "git forgot the worktree");
  assert.equal(await git(SHOP_REPO, ["branch", "--list", checkout.branch!]), checkout.branch, "the branch stays");
  assert.equal(await getWorkspaceById(checkout.workspaceId), null, "its workspace is unregistered");
});

test("adopting an existing chat makes it an agent and tells the orchestrator", async () => {
  const shopWorkspace = await getWorkspaceById(project.repos[0]!.workspaceId);
  assert.ok(shopWorkspace);
  const legacy = await agentRuntimeManager.createConversation(shopWorkspace, {
    title: "Legacy refactor",
    backendId: "cesium-agent",
  });
  script("orchestrator", text(["Noted: legacy-refactor now reports here."]));
  const adopted = await api<{ agent: ProjectChildSummary }>(
    "POST",
    `/api/projects/${project.id}/agents/adopt`,
    { conversation: "Legacy refactor" }
  );
  assert.equal(adopted.status, 201, JSON.stringify(adopted.json));
  assert.equal(adopted.json.agent.name, "legacy-refactor");
  assert.equal(adopted.json.agent.isolation, "checkout");
  assert.equal(adopted.json.agent.repoName, "shop");
  const record = await readConversationRecord(shopWorkspace.id, legacy.id);
  assert.equal(record?.origin?.kind, "project-child");
  const snapshot = await waitFor(
    "adoption notice",
    () => readConversationSnapshot(project.orchestrator.workspaceId, project.orchestrator.conversationId),
    (value) =>
      eventsOfKind(value.events, "user_message").some(
        (event) =>
          (event.displayContent ?? "").includes("legacy-refactor") &&
          /<agent name="legacy-refactor" event="adopted" status="idle">\nThe user added their conversation "Legacy refactor"/.test(
            event.content
          )
      ),
    30_000
  );
  assert.ok(snapshot);
  const twice = await api("POST", `/api/projects/${project.id}/agents/adopt`, { conversation: legacy.id });
  assert.equal(twice.status, 409);
  const missing = await api("POST", `/api/projects/${project.id}/agents/adopt`, { conversation: "../../etc" });
  assert.equal(missing.status, 404);
});

test("the Project context stores media: uploads, kinds, raw bytes with ranges, and safe paths", async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
  const upload = async (relative: string, bytes: Buffer, type = "application/octet-stream") =>
    app.request(`/api/projects/${project.id}/context/upload?path=${encodeURIComponent(relative)}`, {
      method: "POST",
      headers: { "content-type": type },
      body: bytes,
    });
  const shot = await upload("media/qa/shot.png", png, "image/png");
  assert.equal(shot.status, 201);
  assert.equal(((await shot.json()) as { written: ProjectContextFile }).written.kind, "image");
  const video = Buffer.from("0123456789abcdef");
  assert.equal((await upload("media/qa/demo.mp4", video)).status, 201);
  assert.equal((await upload("internal/qa/blob.bin", Buffer.from([1, 2, 0, 3]))).status, 201);
  assert.equal((await upload(".hidden/x.png", png)).status, 400);
  assert.equal((await upload("../escape.png", png)).status, 400);

  const listing = await api<{ files: ProjectContextFile[]; folders: string[] }>(
    "GET",
    `/api/projects/${project.id}/context`
  );
  const kinds = Object.fromEntries(listing.json.files.map((file) => [file.path, file.kind]));
  assert.equal(kinds["media/qa/shot.png"], "image");
  assert.equal(kinds["media/qa/demo.mp4"], "video");
  assert.equal(kinds["internal/qa/blob.bin"], "binary");
  assert.ok(listing.json.folders.includes("media/qa"));

  const raw = await app.request(`/api/projects/${project.id}/context/raw?path=media/qa/shot.png`);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get("content-type"), "image/png");
  assert.match(raw.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.equal(raw.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), png);

  const partial = await app.request(`/api/projects/${project.id}/context/raw?path=media/qa/demo.mp4`, {
    headers: { range: "bytes=2-5" },
  });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), `bytes 2-5/${video.length}`);
  assert.equal(partial.headers.get("content-type"), "video/mp4");
  assert.equal(Buffer.from(await partial.arrayBuffer()).toString(), "2345");
  const unsatisfiable = await app.request(`/api/projects/${project.id}/context/raw?path=media/qa/demo.mp4`, {
    headers: { range: "bytes=999-" },
  });
  assert.equal(unsatisfiable.status, 416);

  const asText = await api("GET", `/api/projects/${project.id}/context/file?path=media/qa/shot.png`);
  assert.equal(asText.status, 400);
  assert.match(String(asText.json.error), /an image, not a text file/);
  const huge = await api("PUT", `/api/projects/${project.id}/context/file`, {
    path: "docs/huge.md",
    content: "x".repeat(1024 * 1024 + 1),
  });
  assert.equal(huge.status, 400);
  assert.match(String(huge.json.error), /text files are capped/);
});

/** Agent updates the coordinator received or has queued, newest last. */
async function coordinatorUpdates(name: string): Promise<string[]> {
  const snapshot = await readConversationSnapshot(project.orchestrator.workspaceId, project.orchestrator.conversationId);
  return [
    ...eventsOfKind(snapshot?.events ?? [], "user_message").map((event) => event.content),
    ...(snapshot?.conversation.queuedPrompts ?? []).map((entry) => entry.text),
  ].filter((content) => content.includes(`name="${name}"`));
}

test("a UI change without screenshots goes back to its agent, and the evidence reaches the coordinator ready to embed", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64"
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let evidenceRequest = "";
  script(
    "banner",
    async (request, res) => {
      await gate;
      await text(["Added the free-shipping banner."])(request, res);
    },
    async (request, res) => {
      evidenceRequest = messageText(request.messages.filter((message) => message.role === "user").at(-1));
      await fs.mkdir(path.join(project.contextRoot, "media", "banner"), { recursive: true });
      await fs.writeFile(path.join(project.contextRoot, "media", "banner", "after.png"), png);
      await text(["Saved a screenshot: media/banner/after.png"])(request, res);
    }
  );
  const created = await createAgent({ name: "banner", repo: "shop", instructions: "Add a free-shipping banner to the home page." });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const worktree = created.json.agent.worktreePath!;
  await fs.writeFile(path.join(worktree, "index.html"), '<p class="banner">Free shipping over $50</p>\n');
  await git(worktree, ["add", "-A"]);
  await git(worktree, ["commit", "-m", "Add a free-shipping banner"]);
  await fs.writeFile(path.join(worktree, "src", "banner.css"), ".banner { color: green; }\n");
  release();

  const brief = await firstPrompt("banner");
  assert.ok(
    brief.includes(
      `- A change to what users see (pages, components, styles, markup) is done only with evidence: screenshots of the result, plus a short recording for anything interactive, saved under ${project.contextRoot}/media/banner/ and listed in your report and the pull request. The Project checks this when your turn ends and sends the change back to you while that folder is empty.`
    ),
    brief
  );
  assert.match(brief, /call_mcp_tool on server "browser" with browser_navigate, browser_screenshot, and browser_record/);

  const missing = await waitFor(
    "the update saying the evidence is missing",
    () => coordinatorUpdates("banner"),
    (updates) => updates.some((content) => content.includes("Evidence: missing")),
    30_000
  );
  assert.ok(
    missing.some((content) =>
      content.includes(
        "Evidence: missing. It changed UI files (index.html, src/banner.css) but saved no screenshots or recording in media/banner/, so the Project asked it to capture them. The change is not done until they arrive."
      )
    ),
    missing.join("\n---\n")
  );
  const present = await waitFor(
    "the update with the evidence",
    () => coordinatorUpdates("banner"),
    (updates) => updates.some((content) => content.includes("Evidence for its UI change")),
    30_000
  );
  assert.ok(
    present.some((content) =>
      content.includes(
        "Evidence for its UI change (index.html, src/banner.css): ![after.png](context:media/banner/after.png). Embed it when you tell the user."
      )
    ),
    present.join("\n---\n")
  );
  assert.match(evidenceRequest, /\nYour change touches what users see \(index\.html, src\/banner\.css\), but there are no screenshots or recording of it in your evidence folder \(media\/banner\/ in the Project context/);
  assert.match(evidenceRequest, /call_mcp_tool on server "browser"/);
  const child = await childRecord("banner");
  assert.deepEqual(child.evidence?.uiFiles, ["index.html", "src/banner.css"]);
  assert.deepEqual(child.evidence?.files, ["media/banner/after.png"]);
  assert.equal(child.evidence?.requestedAt, null, "the request is settled once the evidence arrived");
  assert.equal(child.turnsCompleted, 2);
  const snapshot = await api<ProjectSnapshot>("GET", `/api/projects/${project.id}`);
  assert.deepEqual(
    snapshot.json.children.find((entry) => entry.name === "banner")?.evidence?.files,
    ["media/banner/after.png"],
    "the Agents list shows it"
  );
  const cart = await childRecord("cart");
  assert.equal(cart.evidence, null, "a change to plain code needs no screenshots");
});

test("an agent that ignores the evidence request is asked once, and the coordinator is told to check it itself", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  script(
    "hero",
    async (request, res) => {
      await gate;
      await text(["Restyled the hero."])(request, res);
    },
    text(["I could not start the app, so no screenshots."])
  );
  const created = await createAgent({ name: "hero", repo: "shop", instructions: "Restyle the hero section." });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  await fs.mkdir(path.join(created.json.agent.worktreePath!, "src", "components"), { recursive: true });
  await fs.writeFile(path.join(created.json.agent.worktreePath!, "src", "components", "Hero.js"), "export const Hero = () => 'Hi';\n");
  release();
  const updates = await waitFor(
    "the update saying the evidence is still missing",
    () => coordinatorUpdates("hero"),
    (list) => list.some((content) => content.includes("Evidence: still missing")),
    30_000
  );
  assert.ok(
    updates.some((content) =>
      content.includes(
        "Evidence: still missing. It changed UI files (src/components/Hero.js) and was asked for screenshots, but media/hero/ still has no screenshots or recording. Don't report this change as done: capture it with project_browser_check, or ask hero again."
      )
    ),
    updates.join("\n---\n")
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  const child = await childRecord("hero");
  assert.equal(child.turnsCompleted, 2, "no third request: it is asked once");
  assert.equal(child.evidence?.files.length, 0);
  assert.equal(typeof child.evidence?.requestedAt, "number");
});

test("deleting the Project removes every worker worktree and keeps the branches", async () => {
  const record = (await readProject(project.id))!;
  const worktrees = record.children
    .filter((child) => child.deletedAt == null && child.worktreePath)
    .map((child) => ({ path: child.worktreePath!, branch: child.branch! }));
  assert.ok(worktrees.length >= 2);
  const deleted = await api("DELETE", `/api/projects/${project.id}`);
  assert.equal(deleted.status, 200);
  assert.deepEqual(await worktreeList(), [shopRepoReal], "only the user's checkout is left");
  for (const worktree of worktrees) {
    await assert.rejects(fs.access(worktree.path));
    assert.equal(await git(SHOP_REPO, ["branch", "--list", worktree.branch]), worktree.branch);
  }
  assert.equal(
    await git(SHOP_REPO, ["status", "--porcelain", "--untracked-files=no"]),
    "",
    "no tracked file in the user's checkout changed"
  );
});
