import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { serve } from "@hono/node-server";
import type { ProjectEngineSummary, ProjectSnapshot } from "@cesium/core/projects";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";
import { messageText, startFakeChatModel, text, toolCall, waitFor } from "./helpers/fake-chat-model.js";
import { createRepoWithRemote } from "./helpers/git-fixtures.js";
import { mintPeerToken, startPeerEngine } from "./helpers/peer-engine.js";

const HOME_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-sync-home-"));
const PEER_DATA_DIR = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cesium-sync-peer-")));

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
  { syncProjectContextWithPeer },
] = await Promise.all([
  import("../src/app.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/agents/prompt-queue-drain.js"),
  import("../src/lib/projects/project-watcher.js"),
  import("../src/lib/projects/context-sync.js"),
]);

const app = createCesiumApp();
startAgentPromptQueueDrainListener();
const stopWatcher = startProjectWatcher();
const homeServer = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
await new Promise<void>((resolve) => homeServer.once("listening", () => resolve()));
void (homeServer.address() as AddressInfo).port;

after(async () => {
  stopWatcher();
  peer.stop();
  await new Promise<void>((resolve) => homeServer.close(() => resolve()));
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

let project: ProjectSnapshot;
let peerEngineId = "";
let mirror = "";

function homeContext(relative: string): string {
  return path.join(project.contextRoot, relative);
}

function mirrorFile(relative: string): string {
  return path.join(mirror, relative);
}

test("an agent on a peer works in a synced copy of the Project context, and what it writes comes home", async () => {
  const token = await mintPeerToken(peer, "home-engine");
  const paired = await api<{ engine: ProjectEngineSummary }>("POST", "/api/projects/engines", {
    baseUrl: peer.url,
    token: token.secret,
  });
  assert.equal(paired.status, 201, JSON.stringify(paired.json));
  peerEngineId = paired.json.engine.id;

  const created = await api<ProjectSnapshot>("POST", "/api/projects", { name: "Sync check", modelId: MODEL_ID });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  project = created.json;
  const repoDir = path.join(PEER_DATA_DIR, "repos", "shop");
  await createRepoWithRemote({
    repoDir,
    remoteDir: path.join(PEER_DATA_DIR, "remotes", "shop.git"),
    files: { "index.js": "module.exports = 1;\n" },
  });
  const bound = await api<ProjectSnapshot>("POST", `/api/projects/${project.id}/repos`, {
    engineId: peerEngineId,
    root: repoDir,
  });
  assert.equal(bound.status, 201, JSON.stringify(bound.json));
  project = bound.json;
  assert.equal(
    (await api("PUT", `/api/projects/${project.id}/context/file`, { path: "docs/plan.md", content: "# Plan v1\n" }))
      .status,
    200
  );

  mirror = path.join(PEER_DATA_DIR, "projects-mirror", token.id, project.id, "context");
  script(
    "builder",
    toolCall("w_findings", "write_file", {
      path: mirrorFile("internal/builder/findings.md"),
      content: "The build passes on build-box.\n",
    }),
    toolCall("t_shot", "terminal", {
      command: `mkdir -p '${mirrorFile("media/builder")}' && echo '${PNG.toString("base64")}' | base64 -d > '${mirrorFile("media/builder/shot.png")}'`,
    }),
    toolCall("w_notes", "write_file", { path: mirrorFile("notes.md"), content: "An edit the coordinator never sees.\n" }),
    text(["Wrote my findings and a screenshot into the Project context."])
  );
  const agent = await api("POST", `/api/projects/${project.id}/agents`, {
    name: "builder",
    repo: "shop",
    instructions: "Check the build and leave findings and a screenshot in the Project context.",
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.json));

  assert.equal(await fs.readFile(mirrorFile("docs/plan.md"), "utf8"), "# Plan v1\n", "the context was copied before it started");
  assert.ok(await fs.readFile(mirrorFile("notes.md"), "utf8"));
  const [request] = await waitFor("the builder's first request", async () => requestsFor("builder"), (list) => list.length > 0);
  const brief = request!.messages.map(messageText).join("\n");
  assert.ok(
    brief.includes(`- Folder: ${mirror}. It is this machine's copy of the Project context on engine home-engine`),
    brief
  );

  const noticeWithCopies = await waitFor(
    "the builder's update with its files copied back",
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
      return texts.find((content) => content.includes('name="builder"')) ?? null;
    },
    (content) => content.includes("Copied back"),
    60_000
  );
  assert.match(
    noticeWithCopies,
    /Copied back to the Project context from build-box: internal\/builder\/findings\.md, media\/builder\/shot\.png\./
  );
  assert.equal(await fs.readFile(homeContext("internal/builder/findings.md"), "utf8"), "The build passes on build-box.\n");
  assert.deepEqual(await fs.readFile(homeContext("media/builder/shot.png")), PNG);
  const homeNotes = await fs.readFile(homeContext("notes.md"), "utf8");
  assert.doesNotMatch(homeNotes, /never sees/, "notes.md is never pulled back");
  assert.equal(await fs.readFile(mirrorFile("notes.md"), "utf8"), homeNotes, "and the coordinator's version replaces the edit");
});

test("the home leads: its notes win, both-sides edits keep a conflict copy, and home deletions reach the peer", async () => {
  await fs.writeFile(homeContext("docs/plan.md"), "# Plan v2 (home)\n");
  await fs.writeFile(mirrorFile("docs/plan.md"), "# Plan v2 (build-box)\n");
  await fs.writeFile(mirrorFile("notes.md"), "Another edit on build-box.\n");
  await fs.rm(homeContext("internal/builder/findings.md"));
  const result = await syncProjectContextWithPeer(project.id, peerEngineId);
  assert.deepEqual(result.conflicts, [{ path: "docs/plan.md", savedAs: "docs/plan.conflict-build-box.md" }]);
  assert.deepEqual(result.deletedOnPeer, ["internal/builder/findings.md"]);
  assert.ok(result.pushed.includes("notes.md"), "the peer's notes.md edit is replaced by the coordinator's");
  assert.equal(result.pulled.includes("notes.md"), false);
  assert.equal(await fs.readFile(homeContext("docs/plan.md"), "utf8"), "# Plan v2 (home)\n");
  assert.equal(await fs.readFile(homeContext("docs/plan.conflict-build-box.md"), "utf8"), "# Plan v2 (build-box)\n");
  assert.equal(await fs.readFile(mirrorFile("docs/plan.md"), "utf8"), "# Plan v2 (home)\n");
  assert.equal(await fs.readFile(mirrorFile("notes.md"), "utf8"), await fs.readFile(homeContext("notes.md"), "utf8"));
  await assert.rejects(fs.access(mirrorFile("internal/builder/findings.md")));

  const again = await syncProjectContextWithPeer(project.id, peerEngineId);
  assert.deepEqual(again.pulled, []);
  assert.deepEqual(again.conflicts, []);
  assert.deepEqual(again.pushed, ["docs/plan.conflict-build-box.md"], "the conflict copy reaches the peer once");
  const quiet = await syncProjectContextWithPeer(project.id, peerEngineId);
  assert.deepEqual(
    [quiet.pushed, quiet.pulled, quiet.deletedOnPeer, quiet.conflicts],
    [[], [], [], []],
    "nothing moves when both sides agree"
  );
});

test("the peer's context routes only reach that token's mirror, inside it", async () => {
  const other = await mintPeerToken(peer, "someone-else");
  const listed = await fetch(`${peer.url}/api/projects/peer/context/${project.id}/manifest`, {
    headers: { authorization: `Bearer ${other.secret}` },
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(((await listed.json()) as { files: unknown[] }).files, [], "another token sees its own, empty mirror");
  for (const bad of ["../escape.md", "%2E%2E/x", ".hidden"]) {
    const response = await fetch(`${peer.url}/api/projects/peer/context/${project.id}/file?path=${bad}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${other.secret}`, "content-type": "application/octet-stream" },
      body: "x",
    });
    assert.equal(response.status, 400, bad);
  }
  const noToken = await fetch(`${peer.url}/api/projects/peer/context/${project.id}/manifest`);
  assert.equal(noToken.status, 401);
});

test("deleting the Project mid-sync stops syncing it, and neither engine keeps a copy", async () => {
  for (let index = 0; index < 40; index += 1) {
    await fs.writeFile(homeContext(`docs/page-${index}.md`), `# Page ${index}\n`);
  }
  const syncing = syncProjectContextWithPeer(project.id, peerEngineId);
  const deleted = await api("DELETE", `/api/projects/${project.id}`);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
  await syncing;
  await assert.rejects(fs.access(path.dirname(mirror)), "the peer dropped its copy");
  await assert.rejects(fs.access(path.join(HOME_DATA_DIR, "projects", project.id)), "no sync recreated the Project's folder");
  await assert.rejects(syncProjectContextWithPeer(project.id, peerEngineId), /being deleted/);
});
