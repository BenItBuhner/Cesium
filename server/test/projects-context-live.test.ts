import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ProjectEngineSummary, ProjectSnapshot } from "@cesium/core/projects";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";
import { startFakeChatModel, text, toolCall, waitFor } from "./helpers/fake-chat-model.js";
import { mintPeerToken, revokePeerToken, startPeerEngine } from "./helpers/peer-engine.js";

const HOME_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-live-home-"));
const PEER_DATA_DIR = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cesium-live-peer-")));

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
  "OPENCURSOR_AUTH_USERNAME",
  "OPENCURSOR_AUTH_PASSWORD",
  "CESIUM_MODELS",
  "CESIUM_GITHUB_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
]) {
  delete process.env[key];
}

const model = await startFakeChatModel();
const { script, requestsFor } = model;
const MODEL_ENV = {
  CESIUM_BASE_URL: model.baseUrl,
  CESIUM_API_KEY: "sk-test-projects",
  CESIUM_PROVIDER_ID: "projhost",
  CESIUM_DEFAULT_MODEL: "kimi-k3",
  CESIUM_GITHUB_API_URL: "http://127.0.0.1:9",
};
const MODEL_ID = "projhost/kimi-k3";

const peer = await startPeerEngine({ dataDir: PEER_DATA_DIR, label: "build-box", env: MODEL_ENV });

process.env.OPENCURSOR_DATA_DIR = HOME_DATA_DIR;
process.env.WORKSPACE_ALLOWED_ROOTS = HOME_DATA_DIR;
process.env.CESIUM_PROJECTS_ENABLED = "1";
process.env.CESIUM_ENGINE_LABEL = "home-engine";
Object.assign(process.env, MODEL_ENV);

const [
  { createCesiumApp },
  { readConversationSnapshot },
  { startAgentPromptQueueDrainListener },
  { startProjectWatcher, settleProjectWatcher, pollProjectPeerChildren },
  { liveContextSyncStatus },
  { executeProjectOrchestratorTool },
  { readProject },
] = await Promise.all([
  import("../src/app.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/agents/prompt-queue-drain.js"),
  import("../src/lib/projects/project-watcher.js"),
  import("../src/lib/projects/context-live.js"),
  import("../src/lib/projects/orchestrator-tools.js"),
  import("../src/lib/projects/project-store.js"),
]);

const app = createCesiumApp();
startAgentPromptQueueDrainListener();
const stopWatcher = startProjectWatcher();

/** "Within a couple of seconds": what a write may take to show on the other engine. */
const LIVE_BUDGET_MS = 3_000;
const latencies: Record<"home → peer" | "peer → home", number[]> = { "home → peer": [], "peer → home": [] };

after(async () => {
  stopWatcher();
  peer.stop();
  await model.close();
  await fs.rm(HOME_DATA_DIR, { recursive: true, force: true });
  await fs.rm(PEER_DATA_DIR, { recursive: true, force: true });
});

type Json = Record<string, unknown>;

async function api<T = Json>(method: string, pathname: string, body?: unknown): Promise<{ status: number; json: T }> {
  const response = await app.request(pathname, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as T };
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);
const FINDINGS = "The build passes on build-box.\n";

let project: ProjectSnapshot;
let peerEngineId = "";
let homeToken = { secret: "", id: "" };
let mirror = "";

function homeContext(relative: string): string {
  return path.join(project.contextRoot, relative);
}

function mirrorFile(relative: string): string {
  return path.join(mirror, relative);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

function hasContent(file: string, expected: string | Buffer): () => Promise<boolean> {
  const wanted = Buffer.isBuffer(expected) ? expected : Buffer.from(expected);
  return async () => (await fs.readFile(file).catch(() => null))?.equals(wanted) === true;
}

function isGone(file: string): () => Promise<boolean> {
  return async () => (await fs.stat(file).catch(() => null)) === null;
}

/** Milliseconds from `startedAt` until `visible` holds, checked every 10 ms. */
async function msUntil(label: string, startedAt: number, visible: () => Promise<boolean>, timeoutMs = 20_000): Promise<number> {
  for (;;) {
    if (await visible()) {
      return Date.now() - startedAt;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}.`);
    }
    await sleep(10);
  }
}

function record(direction: keyof typeof latencies, label: string, ms: number): number {
  latencies[direction].push(ms);
  assert.ok(ms < LIVE_BUDGET_MS, `${label} took ${ms} ms (${direction}); the budget is ${LIVE_BUDGET_MS} ms`);
  return ms;
}

async function childNamed(name: string, projectId = project.id) {
  const child = (await readProject(projectId))?.children.find((entry) => entry.name === name);
  assert.ok(child, `child ${name} exists`);
  return child;
}

/** The coordinator's turn (or queued notice) about `name` once `ready` holds. */
function coordinatorNotice(name: string, ready: (content: string) => boolean): Promise<string> {
  return waitFor(
    `the update from ${name}`,
    async () => {
      await pollProjectPeerChildren({ force: true });
      await settleProjectWatcher();
      const snapshot = await readConversationSnapshot(project.orchestrator.workspaceId, project.orchestrator.conversationId);
      const texts = [
        ...(snapshot?.events ?? [])
          .filter((event): event is Extract<AgentStoredEvent, { kind: "user_message" }> => event.kind === "user_message")
          .map((event) => event.content),
        ...(snapshot?.conversation.queuedPrompts ?? []).map((entry) => entry.text),
      ];
      return texts.find((content) => content.includes(`name="${name}"`) && ready(content)) ?? null;
    },
    () => true,
    60_000
  );
}

function liveUp(projectId: string) {
  return waitFor(
    "live sync with build-box",
    async () => liveContextSyncStatus(),
    (status) => status.links[peerEngineId]?.up === true && status.projects[projectId]?.watching === true
  );
}

test("the home's writes reach a peer agent's copy of the context within moments", async (t) => {
  homeToken = await mintPeerToken(peer, "home-engine");
  const paired = await api<{ engine: ProjectEngineSummary }>("POST", "/api/projects/engines", {
    baseUrl: peer.url,
    token: homeToken.secret,
  });
  assert.equal(paired.status, 201, JSON.stringify(paired.json));
  peerEngineId = paired.json.engine.id;
  const created = await api<ProjectSnapshot>("POST", "/api/projects", { name: "Live sync", modelId: MODEL_ID });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  project = created.json;

  script("scout", text(["Ready."]));
  const agent = await api("POST", `/api/projects/${project.id}/agents`, {
    name: "scout",
    engine: peerEngineId,
    instructions: "Wait for instructions.",
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.json));
  mirror = path.join(PEER_DATA_DIR, "projects-mirror", homeToken.id, project.id, "context");
  await waitFor("the scout's first turn to be reported", async () => childNamed("scout"), (child) => child.turnsCompleted >= 1, 60_000);
  await liveUp(project.id);
  const requestsBefore = requestsFor("scout").length;

  const notes = "# Live sync\n\n- [ ] scout: check the build\n";
  let startedAt = Date.now();
  await executeProjectOrchestratorTool(project.id, "project_context_write", { path: "notes.md", content: notes });
  const notesMs = record(
    "home → peer",
    "the coordinator's notes.md",
    await msUntil("the coordinator's notes on build-box", startedAt, hasContent(mirrorFile("notes.md"), notes))
  );

  startedAt = Date.now();
  const uploaded = await app.request(`/api/projects/${project.id}/context/upload?path=media/uploads/mock.png`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: PNG,
  });
  assert.equal(uploaded.status, 201);
  const uploadMs = record(
    "home → peer",
    "an upload",
    await msUntil("the upload on build-box", startedAt, hasContent(mirrorFile("media/uploads/mock.png"), PNG))
  );

  startedAt = Date.now();
  await fs.writeFile(homeContext("docs/brief.md"), "# Brief\n");
  const folderMs = record(
    "home → peer",
    "a file saved into the home's folder",
    await msUntil("the brief on build-box", startedAt, hasContent(mirrorFile("docs/brief.md"), "# Brief\n"))
  );

  t.diagnostic(`home → peer: notes.md ${notesMs} ms, upload ${uploadMs} ms, file saved into the folder ${folderMs} ms`);
  assert.equal(requestsFor("scout").length, requestsBefore, "the scout sat idle: no turn ended to carry them over");
});

test("what an agent on the peer saves comes home while it is still working", async (t) => {
  script(
    "scout",
    toolCall("w_findings", "write_file", { path: mirrorFile("internal/scout/findings.md"), content: FINDINGS }),
    toolCall("t_shot", "terminal", {
      command: `mkdir -p '${mirrorFile("media/scout")}' && echo '${PNG.toString("base64")}' | base64 -d > '${mirrorFile("media/scout/shot.png")}'`,
    }),
    toolCall("t_wait", "terminal", { command: "sleep 8" }),
    text(["Findings and a screenshot are in the Project context."])
  );
  const requestsBefore = requestsFor("scout").length;
  const sent = await api("POST", `/api/projects/${project.id}/agents/scout/messages`, {
    text: "Check the build and leave findings and a screenshot in the Project context.",
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  await waitFor(
    "the findings and the screenshot at home",
    async () =>
      (await hasContent(homeContext("internal/scout/findings.md"), FINDINGS)()) &&
      (await hasContent(homeContext("media/scout/shot.png"), PNG)())
        ? true
        : null,
    Boolean,
    20_000
  );
  assert.ok(
    requestsFor("scout").length < requestsBefore + 4,
    "they came home during the agent's turn (it is still sleeping), not from the sync at its end"
  );

  // More saves while the turn still runs, timed from the write to the file showing at home.
  const timings: number[] = [];
  for (const name of ["a", "b", "c"]) {
    const relative = `internal/scout/note-${name}.md`;
    const startedAt = Date.now();
    await fs.writeFile(mirrorFile(relative), `Note ${name}\n`);
    timings.push(
      record(
        "peer → home",
        `${relative} saved on the peer`,
        await msUntil(`${relative} at home`, startedAt, hasContent(homeContext(relative), `Note ${name}\n`))
      )
    );
  }
  assert.ok(requestsFor("scout").length < requestsBefore + 4, "still inside the same turn");
  t.diagnostic(`peer → home: ${timings.map((ms) => `${ms} ms`).join(", ")}`);

  const notice = await coordinatorNotice("scout", (content) => content.includes("Copied back"));
  assert.match(
    notice,
    /Copied back to the Project context from build-box: internal\/scout\/findings\.md, internal\/scout\/note-a\.md, internal\/scout\/note-b\.md, internal\/scout\/note-c\.md, media\/scout\/shot\.png\./,
    "the coordinator still hears about everything that came back live"
  );
});

test("live sync keeps the rules: the home wins, both-sides edits keep both, deletions only flow home → peer", async () => {
  const homeNotes = await fs.readFile(homeContext("notes.md"), "utf8");
  await fs.writeFile(mirrorFile("notes.md"), "An edit the coordinator never sees.\n");
  await msUntil("the coordinator's notes back on build-box", Date.now(), hasContent(mirrorFile("notes.md"), homeNotes));
  assert.equal(await fs.readFile(homeContext("notes.md"), "utf8"), homeNotes, "notes.md is never pulled back");

  await fs.rm(mirrorFile("internal/scout/findings.md"));
  await msUntil("the findings back on build-box", Date.now(), hasContent(mirrorFile("internal/scout/findings.md"), FINDINGS));
  assert.equal(await fs.readFile(homeContext("internal/scout/findings.md"), "utf8"), FINDINGS, "a deletion on the peer never reaches home");

  const deleted = await api("DELETE", `/api/projects/${project.id}/context/file?path=docs/brief.md`);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
  await msUntil("the brief gone from build-box", Date.now(), isGone(mirrorFile("docs/brief.md")));

  await fs.writeFile(homeContext("docs/plan.md"), "# Plan v1\n");
  await msUntil("plan v1 on build-box", Date.now(), hasContent(mirrorFile("docs/plan.md"), "# Plan v1\n"));
  await sleep(800);
  // Both edits land before either engine's settle window ends, so one sync sees both.
  writeFileSync(homeContext("docs/plan.md"), "# Plan v2 (home)\n");
  writeFileSync(mirrorFile("docs/plan.md"), "# Plan v2 (build-box)\n");
  const read = (file: string) => fs.readFile(file, "utf8").catch(() => null);
  await waitFor(
    "both engines to settle the conflicting edits",
    async () => ({
      homePlan: await read(homeContext("docs/plan.md")),
      homeCopy: await read(homeContext("docs/plan.conflict-build-box.md")),
      peerPlan: await read(mirrorFile("docs/plan.md")),
      peerCopy: await read(mirrorFile("docs/plan.conflict-build-box.md")),
    }),
    (files) =>
      files.homePlan === "# Plan v2 (home)\n" &&
      files.homeCopy === "# Plan v2 (build-box)\n" &&
      files.peerPlan === "# Plan v2 (home)\n" &&
      files.peerCopy === "# Plan v2 (build-box)\n",
    10_000
  );
});

test("the peer only takes the home's write or delete on the version the home listed", async () => {
  // A copy the home engine never synced, so its own live sync leaves these files alone.
  const projectId = "prj_0000000000aa";
  const file = path.join(PEER_DATA_DIR, "projects-mirror", homeToken.id, projectId, "context", "docs", "guard.md");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "the agent's version\n");
  const call = (method: string, query: string, body?: string) =>
    fetch(`${peer.url}/api/projects/peer/context/${projectId}/file?path=docs/guard.md${query}`, {
      method,
      headers: { authorization: `Bearer ${homeToken.secret}`, "content-type": "application/octet-stream" },
      ...(body === undefined ? {} : { body }),
    });

  for (const stale of [sha256("the version the home listed\n"), "absent"]) {
    const refused = await call("PUT", `&mtime=1000&ifMatch=${stale}`, "the home's version\n");
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { code: string }).code, "context_changed");
    assert.equal(await fs.readFile(file, "utf8"), "the agent's version\n", "the agent's edit stays for the next sync");
  }
  const written = await call("PUT", `&mtime=1000&ifMatch=${sha256("the agent's version\n")}`, "the home's version\n");
  assert.equal(written.status, 200);
  assert.equal(await fs.readFile(file, "utf8"), "the home's version\n");

  assert.equal((await call("DELETE", `&ifMatch=${sha256("the agent's version\n")}`)).status, 409);
  assert.equal((await call("DELETE", `&ifMatch=${sha256("the home's version\n")}`)).status, 200);
  await assert.rejects(fs.access(file));
  assert.equal((await call("PUT", "&mtime=1000", "an older home's write\n")).status, 200, "without ifMatch it writes as before");
});

test("the peer answers a waiting request as soon as its agent writes, and not for the home's own writes", async () => {
  const projectId = "prj_0000000000bb";
  const folder = path.join(PEER_DATA_DIR, "projects-mirror", homeToken.id, projectId, "context");
  const changes = async (query: string) => {
    const response = await fetch(`${peer.url}/api/projects/peer/context-changes?${query}`, {
      headers: { authorization: `Bearer ${homeToken.secret}` },
    });
    return { status: response.status, body: (await response.json()) as { feed: string; cursor: number; projects: string[]; reset: boolean } };
  };

  const first = await changes("cursor=0&wait=0");
  assert.equal(first.status, 200);
  assert.equal(first.body.reset, true, "a caller without the peer's feed id syncs everything first");
  const { feed } = first.body;
  let cursor = first.body.cursor;

  // Answers for other copies (the last test's files settling, say) are skipped with their cursor.
  const waiting = changes(`feed=${feed}&cursor=${cursor}&wait=10000`);
  await sleep(200);
  const writtenAt = Date.now();
  await fs.mkdir(path.join(folder, "internal"), { recursive: true });
  await fs.writeFile(path.join(folder, "internal", "found.md"), "found\n");
  let answer = await waiting;
  while (!answer.body.projects.includes(projectId) && Date.now() - writtenAt < 10_000) {
    assert.equal(answer.body.reset, false);
    cursor = answer.body.cursor;
    answer = await changes(`feed=${feed}&cursor=${cursor}&wait=10000`);
  }
  assert.ok(answer.body.projects.includes(projectId), JSON.stringify(answer.body));
  assert.ok(Date.now() - writtenAt < 3_000, "answered at once, not at the end of its wait");
  cursor = answer.body.cursor;

  const reported = new Set<string>();
  const quietUntil = Date.now() + 1_500;
  const pushing = sleep(100).then(() =>
    fetch(`${peer.url}/api/projects/peer/context/${projectId}/file?path=docs/from-home.md&mtime=5000`, {
      method: "PUT",
      headers: { authorization: `Bearer ${homeToken.secret}`, "content-type": "application/octet-stream" },
      body: "pushed by the home\n",
    })
  );
  while (Date.now() < quietUntil) {
    const next = await changes(`feed=${feed}&cursor=${cursor}&wait=${Math.max(0, quietUntil - Date.now())}`);
    cursor = next.body.cursor;
    next.body.projects.forEach((id) => reported.add(id));
  }
  assert.equal((await pushing).status, 200);
  assert.equal(reported.has(projectId), false, "the home's own write is not reported back to it");

  const stranger = await changes(`feed=0123456789abcdef&cursor=${cursor}&wait=0`);
  assert.equal(stranger.body.reset, true, "an unknown feed (a restarted peer) asks for everything");
  assert.equal((await fetch(`${peer.url}/api/projects/peer/context-changes?wait=0`)).status, 401);
});

test("deleting the Project stops its live sync, and nothing brings its folders back", async () => {
  const deleted = await api("DELETE", `/api/projects/${project.id}`);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
  const status = liveContextSyncStatus();
  assert.equal(status.projects[project.id], undefined, "no watch on the deleted Project");
  assert.equal(status.links[peerEngineId], undefined, "no Project left on build-box, so no link to it");
  await assert.rejects(fs.access(path.dirname(mirror)), "the peer dropped its copy");

  // A straggling write into the old copy on the peer must not bring the Project back.
  await fs.mkdir(mirrorFile("internal/late"), { recursive: true });
  await fs.writeFile(mirrorFile("internal/late/after-delete.md"), "late\n");
  await sleep(1_500);
  await assert.rejects(fs.access(path.join(HOME_DATA_DIR, "projects", project.id)), "no sync recreated the Project's folder");
});

test("revoking the home's token ends the live link, and the peer drops every copy it kept", async (t) => {
  const created = await api<ProjectSnapshot>("POST", "/api/projects", { name: "Revoke check", modelId: MODEL_ID });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const second = created.json;
  script("lookout", text(["Ready."]));
  const agent = await api("POST", `/api/projects/${second.id}/agents`, {
    name: "lookout",
    engine: peerEngineId,
    instructions: "Wait for instructions.",
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.json));
  await liveUp(second.id);
  const secondMirror = path.join(PEER_DATA_DIR, "projects-mirror", homeToken.id, second.id, "context");
  const startedAt = Date.now();
  await fs.writeFile(path.join(second.contextRoot, "docs", "before.md"), "before\n");
  record(
    "home → peer",
    "a file saved into the second Project",
    await msUntil("before.md on build-box", startedAt, hasContent(path.join(secondMirror, "docs", "before.md"), "before\n"))
  );

  await revokePeerToken(peer, homeToken.id);
  const mirrors = path.join(PEER_DATA_DIR, "projects-mirror", homeToken.id);
  await assert.rejects(fs.access(mirrors), "the peer dropped every copy kept for the token");
  await waitFor("the live link to go down", async () => liveContextSyncStatus(), (status) => status.links[peerEngineId]?.up === false, 10_000);
  await fs.writeFile(path.join(second.contextRoot, "docs", "after.md"), "after\n");
  await sleep(1_500);
  await assert.rejects(fs.access(mirrors), "and no live sync recreated them");

  const all = [...latencies["home → peer"], ...latencies["peer → home"]];
  t.diagnostic(
    `write-to-visible: home → peer ${latencies["home → peer"].join(", ")} ms; peer → home ${latencies["peer → home"].join(", ")} ms; max ${Math.max(...all)} ms`
  );
});
