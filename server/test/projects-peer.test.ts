import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { ProjectEngineSummary, ProjectSnapshot } from "@cesium/core/projects";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";
import {
  messageText,
  startFakeChatModel,
  text,
  toolCall,
  waitFor,
} from "./helpers/fake-chat-model.js";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-projects-home-"));
const PEER_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-projects-peer-"));
const HOME_REPO = path.join(HOME_DATA_DIR, "repos", "alpha");
const PEER_REPO = path.join(PEER_DATA_DIR, "repos", "beta");
await fs.mkdir(HOME_REPO, { recursive: true });
await fs.mkdir(PEER_REPO, { recursive: true });
const PEER_REPO_REAL = await fs.realpath(PEER_REPO);

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
};
const MODEL_ID = "projhost/kimi-k3";

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// The peer is a separate engine process: its own port, data dir, label and
// login, reached only over HTTP like a second machine would be.
const PEER_PORT = await freePort();
const PEER_URL = `http://127.0.0.1:${PEER_PORT}`;
const PEER_LOGIN = { username: "peer-admin", password: "peer-password-for-tests" };
const peerOutput: string[] = [];
const peerEnv: NodeJS.ProcessEnv = {
  ...process.env,
  ...MODEL_ENV,
  NODE_ENV: "test",
  PORT: String(PEER_PORT),
  HOST: "127.0.0.1",
  OPENCURSOR_DATA_DIR: PEER_DATA_DIR,
  WORKSPACE_ALLOWED_ROOTS: PEER_DATA_DIR,
  CESIUM_PROJECTS_ENABLED: "1",
  CESIUM_ENGINE_LABEL: "peer-engine",
  OPENCURSOR_AUTH_USERNAME: PEER_LOGIN.username,
  OPENCURSOR_AUTH_PASSWORD: PEER_LOGIN.password,
};
// The engine is not a test file; inheriting the runner's context would make
// it report as a nested test.
delete peerEnv.NODE_TEST_CONTEXT;
const peerProcess = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  cwd: SERVER_DIR,
  env: peerEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
peerProcess.stdout?.on("data", (chunk: Buffer) => peerOutput.push(chunk.toString("utf8")));
peerProcess.stderr?.on("data", (chunk: Buffer) => peerOutput.push(chunk.toString("utf8")));

process.env.OPENCURSOR_DATA_DIR = HOME_DATA_DIR;
process.env.WORKSPACE_ALLOWED_ROOTS = HOME_DATA_DIR;
process.env.CESIUM_PROJECTS_ENABLED = "1";
process.env.CESIUM_ENGINE_LABEL = "home-engine";
Object.assign(process.env, MODEL_ENV);

const [
  { createCesiumApp },
  { readConversationRecord, readConversationSnapshot },
  { startAgentPromptQueueDrainListener },
  { formatMidTurnSteer },
  { startProjectWatcher, settleProjectWatcher, pollProjectPeerChildren, heartbeatProjectPeerEngines },
  { readProject },
  { getWorkspaceById },
] = await Promise.all([
  import("../src/app.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/agents/prompt-queue-drain.js"),
  import("../src/lib/agents/cesium-provider.js"),
  import("../src/lib/projects/project-watcher.js"),
  import("../src/lib/projects/project-store.js"),
  import("../src/lib/workspace-registry.js"),
]);

const app = createCesiumApp();
startAgentPromptQueueDrainListener();
const stopWatcher = startProjectWatcher();
const homeServer = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
await new Promise<void>((resolve) => homeServer.once("listening", () => resolve()));
const HOME_URL = `http://127.0.0.1:${(homeServer.address() as AddressInfo).port}`;

after(async () => {
  stopWatcher();
  peerProcess.kill("SIGTERM");
  await new Promise<void>((resolve) => homeServer.close(() => resolve()));
  await model.close();
  await fs.rm(HOME_DATA_DIR, { recursive: true, force: true });
  await fs.rm(PEER_DATA_DIR, { recursive: true, force: true });
});

await waitFor(
  "peer engine health",
  async () => {
    if (peerProcess.exitCode != null) {
      throw new Error(`Peer engine exited early:\n${peerOutput.join("").slice(-4000)}`);
    }
    return fetch(`${PEER_URL}/health`)
      .then((response) => (response.ok ? (response.json() as Promise<{ instanceId?: string }>) : null))
      .catch(() => null);
  },
  (health) => typeof health.instanceId === "string",
  90_000
);

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

async function peer<T = Json>(
  method: string,
  pathname: string,
  options: { token?: string; session?: string; body?: unknown } = {}
): Promise<{ status: number; json: T }> {
  const response = await fetch(`${PEER_URL}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.session ? { "x-opencursor-session-token": options.session } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, json: (await response.json().catch(() => ({}))) as T };
}

function eventsOfKind<K extends AgentStoredEvent["kind"]>(
  events: AgentStoredEvent[],
  kind: K
): Array<Extract<AgentStoredEvent, { kind: K }>> {
  return events.filter((event): event is Extract<AgentStoredEvent, { kind: K }> => event.kind === kind);
}

let peerSession = "";
let peerToken = "";
let peerTokenId = "";
let secondToken = "";
let peerEngineId = "";
let project: ProjectSnapshot;

async function orchestratorSnapshot() {
  return readConversationSnapshot(project.orchestrator.workspaceId, project.orchestrator.conversationId);
}

function noticeMessages(events: AgentStoredEvent[]) {
  return eventsOfKind(events, "user_message").filter((event) =>
    event.displayContent?.startsWith("Agent update · ")
  );
}

async function childRecord(name: string) {
  const record = await readProject(project.id);
  const child = record?.children.find((entry) => entry.name === name);
  assert.ok(child, `child ${name} exists`);
  return child;
}

function peerChildPath(child: { workspaceId: string; conversationId: string }, suffix = ""): string {
  return `/api/projects/peer/children/${child.workspaceId}/${child.conversationId}${suffix}`;
}

async function peerObserve(name: string, token = peerToken) {
  return peer<{ exists: boolean; status: string; title: string | null; backendId: string | null }>(
    "GET",
    peerChildPath(await childRecord(name)),
    { token }
  );
}

test("minting a peer token needs a session on the peer; the peer API needs the token", async () => {
  const noToken = await peer("GET", "/api/projects/peer/info");
  assert.equal(noToken.status, 401);
  assert.equal(noToken.json.code, "peer_token_invalid");
  const noSession = await peer("POST", "/api/projects/peer-tokens", { body: { label: "home" } });
  assert.equal(noSession.status, 401, "token minting is behind the peer's login");

  const login = await peer<{ token: string }>("POST", "/api/auth/login", { body: PEER_LOGIN });
  assert.equal(login.status, 200);
  peerSession = login.json.token;
  const minted = await peer<{ token: { id: string; label: string }; secret: string }>(
    "POST",
    "/api/projects/peer-tokens",
    { session: peerSession, body: { label: "home-engine" } }
  );
  assert.equal(minted.status, 201, JSON.stringify(minted.json));
  assert.match(minted.json.secret, /^cpk_[A-Za-z0-9_-]{40,}$/);
  assert.match(minted.json.token.id, /^ptk_[a-f0-9]{8}$/);
  peerToken = minted.json.secret;
  peerTokenId = minted.json.token.id;

  const info = await peer<{
    label: string;
    tokenId: string;
    harnesses: Array<{ id: string; available: boolean }>;
  }>("GET", "/api/projects/peer/info", { token: peerToken });
  assert.equal(info.status, 200);
  assert.equal(info.json.label, "peer-engine");
  assert.equal(info.json.tokenId, peerTokenId);
  assert.ok(info.json.harnesses.some((harness) => harness.id === "cesium-agent" && harness.available));
  const wrong = await peer("GET", "/api/projects/peer/info", { token: `${peerToken}x` });
  assert.equal(wrong.status, 401);

  const tokensFile = path.join(PEER_DATA_DIR, "projects", "peer-tokens.json");
  const stored = await fs.readFile(tokensFile, "utf8");
  assert.equal(stored.includes(peerToken), false, "only a hash of the token is stored");
  assert.equal((await fs.stat(tokensFile)).mode & 0o777, 0o600);
  const listed = await peer<{ tokens: Array<{ id: string }> }>("GET", "/api/projects/peer-tokens", {
    session: peerSession,
  });
  assert.deepEqual(listed.json.tokens.map((token) => token.id), [peerTokenId]);
});

test("pairing verifies the token, refuses this engine itself, and seals the stored token", async () => {
  const badToken = await api("POST", "/api/projects/engines", { baseUrl: PEER_URL, token: "cpk_nope" });
  assert.equal(badToken.status, 400);
  assert.equal(badToken.json.code, "peer_token_invalid");
  const badUrl = await api("POST", "/api/projects/engines", { baseUrl: "ftp://peer", token: peerToken });
  assert.equal(badUrl.status, 400);
  const unreachable = await api("POST", "/api/projects/engines", {
    baseUrl: `http://127.0.0.1:${await freePort()}`,
    token: peerToken,
  });
  assert.equal(unreachable.status, 400);
  assert.equal(unreachable.json.code, "peer_unreachable");

  const selfToken = await api<{ secret: string }>("POST", "/api/projects/peer-tokens", { label: "self" });
  assert.equal(selfToken.status, 201);
  const self = await api("POST", "/api/projects/engines", { baseUrl: HOME_URL, token: selfToken.json.secret });
  assert.equal(self.status, 400);
  assert.match(String(self.json.error), /points at this engine/);

  const paired = await api<{ engine: ProjectEngineSummary }>("POST", "/api/projects/engines", {
    baseUrl: `${PEER_URL}/`,
    token: peerToken,
  });
  assert.equal(paired.status, 201, JSON.stringify(paired.json));
  assert.match(paired.json.engine.id, /^eng_[a-f0-9]{8}$/);
  assert.equal(paired.json.engine.label, "peer-engine");
  assert.equal(paired.json.engine.kind, "peer");
  assert.equal(paired.json.engine.baseUrl, PEER_URL);
  assert.equal(paired.json.engine.online, true);
  peerEngineId = paired.json.engine.id;

  const again = await api<{ engine: ProjectEngineSummary }>("POST", "/api/projects/engines", {
    baseUrl: PEER_URL,
    token: peerToken,
  });
  assert.equal(again.json.engine.id, peerEngineId, "pairing the same engine again re-pairs it");
  const engines = await api<{ engines: ProjectEngineSummary[] }>("GET", "/api/projects/engines");
  assert.deepEqual(
    engines.json.engines.map((engine) => [engine.id, engine.label, engine.kind]),
    [
      ["home", "home-engine", "home"],
      [peerEngineId, "peer-engine", "peer"],
    ]
  );
  const enginesFile = path.join(HOME_DATA_DIR, "projects", "engines.json");
  const stored = await fs.readFile(enginesFile, "utf8");
  assert.equal(stored.includes(peerToken), false, "the peer token is sealed at rest");
  assert.equal((await fs.stat(enginesFile)).mode & 0o777, 0o600);
});

test("a Project binds repositories on both engines and lists the peer's harnesses", async () => {
  const created = await api<ProjectSnapshot>("POST", "/api/projects", {
    name: "Fleet",
    modelId: MODEL_ID,
    repos: [{ root: HOME_REPO }, { root: PEER_REPO, engineId: "peer-engine" }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  project = created.json;
  assert.deepEqual(
    project.repos.map((repo) => [repo.name, repo.engineId, repo.root]),
    [
      ["alpha", "home", await fs.realpath(HOME_REPO)],
      ["beta", peerEngineId, PEER_REPO_REAL],
    ]
  );
  const patched = await api<ProjectSnapshot>("PATCH", `/api/projects/${project.id}`, {
    settings: { defaultChildModelId: MODEL_ID },
  });
  project = patched.json;

  const outsidePeerRoots = await api("POST", `/api/projects/${project.id}/repos`, {
    root: HOME_REPO,
    engineId: peerEngineId,
  });
  assert.equal(outsidePeerRoots.status, 400, "the peer enforces its own allowed roots");
  assert.match(String(outsidePeerRoots.json.error), /not allowed/);
  const unknownEngine = await api("POST", `/api/projects/${project.id}/repos`, {
    root: HOME_REPO,
    engineId: "nowhere",
  });
  assert.equal(unknownEngine.status, 400);
  assert.match(String(unknownEngine.json.error), /Unknown engine "nowhere"/);

  const engines = await api<{
    engines: Array<ProjectEngineSummary & { repos: Array<{ name: string }>; harnesses: Array<{ id: string }> }>;
  }>("GET", `/api/projects/${project.id}/engines`);
  const remote = engines.json.engines.find((engine) => engine.id === peerEngineId);
  assert.ok(remote);
  assert.deepEqual(remote.repos.map((repo) => repo.name), ["beta"]);
  assert.ok(remote.harnesses.some((harness) => harness.id === "cesium-agent"));
});

test("the orchestrator runs agents on both engines and hears back from the remote one", async () => {
  script("local", text(["Local done."]));
  script("remote", text(["Remote ", "done."]));
  script(
    "orchestrator",
    toolCall("call_local", "project_create_agent", { name: "local", repo: "alpha", instructions: "Work here." }),
    toolCall("call_remote", "project_create_agent", { name: "remote", repo: "beta", instructions: "Work there." }),
    text(["Started both."])
  );
  const workspace = await getWorkspaceById(project.orchestrator.workspaceId);
  assert.ok(workspace);
  const { agentRuntimeManager } = await import("../src/lib/agents/runtime-manager.js");
  await agentRuntimeManager.promptConversation(workspace, project.orchestrator.conversationId, "Go.");

  const snapshot = await waitFor(
    "reports from both engines",
    orchestratorSnapshot,
    (value) => {
      const notices = noticeMessages(value.events).map((event) => event.content).join("\n");
      return notices.includes('name="local"') && notices.includes("Remote done.");
    },
    30_000
  );
  const created = eventsOfKind(snapshot.events, "tool_call_update").find(
    (event) => event.toolCallId === "call_remote" && event.status !== "in_progress"
  );
  assert.equal(
    (JSON.parse(created?.detail ?? "{}") as { created?: { engine?: string } }).created?.engine,
    peerEngineId
  );

  const remote = await childRecord("remote");
  const beta = project.repos.find((repo) => repo.name === "beta")!;
  assert.equal(remote.engineId, peerEngineId);
  assert.equal(remote.workspaceId, beta.workspaceId, "the child runs in the peer's workspace");
  assert.equal(remote.turnsCompleted, 1);
  assert.equal(remote.lastReplyPreview, "Remote done.");
  assert.equal(
    await readConversationRecord(remote.workspaceId, remote.conversationId),
    null,
    "the conversation lives on the peer, not here"
  );
  const observed = await peerObserve("remote");
  assert.equal(observed.status, 200);
  assert.equal(observed.json.title, "remote");
  assert.equal(observed.json.backendId, "cesium-agent");
  assert.match(messageText(requestsFor("remote")[0]!.messages.at(-1)), /Work in the "beta" repository/);

  const reminder = requestsFor("orchestrator")[0]!.messages.map(messageText).join("\n");
  assert.match(
    reminder,
    new RegExp(`Engines:\\n- home: home-engine \\(this engine\\)\\n- ${peerEngineId}: peer-engine\\n`)
  );
});

test("steer, queue, transcript and rename reach a remote agent", async () => {
  script(
    "worker",
    toolCall("call_worker_wait", "wait", { seconds: 3, reason: "long build" }),
    text(["Worker built v1 with a changelog."]),
    text(["Worker wrote docs."])
  );
  const created = await api<{ agent: { engineId: string; repoId: string | null } }>(
    "POST",
    `/api/projects/${project.id}/agents`,
    { name: "worker", engine: peerEngineId, instructions: "Build v1." }
  );
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.agent.engineId, peerEngineId);
  assert.equal(created.json.agent.repoId, null, "no repo: a scratch folder on the peer");
  await waitFor("worker first request", async () => requestsFor("worker").length, (count) => count >= 1);

  const steer = await api("POST", `/api/projects/${project.id}/agents/worker/messages`, {
    text: "Add a changelog.",
    delivery: "steer",
  });
  assert.deepEqual(steer.json, { agent: "worker", delivery: "mid_turn" });
  const queue = await api("POST", `/api/projects/${project.id}/agents/worker/messages`, {
    text: "Then write docs.",
    delivery: "queue",
  });
  assert.deepEqual(queue.json, { agent: "worker", delivery: "queued" });

  const child = await waitFor(
    "worker reports both turns",
    () => childRecord("worker"),
    (value) => value.turnsCompleted === 2 && value.lastReplyPreview === "Worker wrote docs.",
    30_000
  );
  assert.equal(child.lastStatus, "idle");
  const workerRequests = requestsFor("worker");
  assert.equal(workerRequests.length, 3);
  assert.equal(messageText(workerRequests[1]!.messages.at(-1)), formatMidTurnSteer("Add a changelog."));
  assert.match(messageText(workerRequests[2]!.messages.at(-1)), /Then write docs\./);

  const transcript = await api<{ agent: string; status: string; transcript: string }>(
    "GET",
    `/api/projects/${project.id}/agents/worker/transcript?turns=5`
  );
  assert.equal(transcript.status, 200);
  assert.equal(transcript.json.status, "idle");
  assert.match(transcript.json.transcript, /User: Build v1\./);
  assert.match(transcript.json.transcript, /Assistant: Worker wrote docs\./);

  const renamed = await api<{ agent: { name: string } }>("PATCH", `/api/projects/${project.id}/agents/worker`, {
    name: "Builder",
  });
  assert.equal(renamed.json.agent.name, "builder");
  assert.equal((await peerObserve("builder")).json.title, "builder");
});

test("stopping a busy remote agent is silent", async () => {
  script("sleeper", toolCall("call_sleeper_wait", "wait", { seconds: 5, reason: "sleep" }));
  const created = await api("POST", `/api/projects/${project.id}/agents`, {
    name: "sleeper",
    engine: "peer-engine",
    instructions: "Sleep.",
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  await waitFor("sleeper first request", async () => requestsFor("sleeper").length, (count) => count >= 1);
  const noticeCount = noticeMessages((await orchestratorSnapshot())!.events).length;

  const stopped = await api<{ stopped: boolean }>("POST", `/api/projects/${project.id}/agents/sleeper/stop`);
  assert.equal(stopped.status, 200, JSON.stringify(stopped.json));
  assert.equal(stopped.json.stopped, true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await pollProjectPeerChildren({ force: true });
  await settleProjectWatcher();
  const after = await orchestratorSnapshot();
  const sleeperNotices = [
    ...noticeMessages(after!.events).slice(noticeCount).map((event) => event.content),
    ...after!.conversation.queuedPrompts.map((entry) => entry.text),
  ].filter((content) => content.includes('name="sleeper"'));
  assert.deepEqual(sleeperNotices, [], "no notice for a stop the orchestrator caused");
  const sleeper = await childRecord("sleeper");
  assert.equal(sleeper.suppressReports, true);
  assert.equal((await peerObserve("sleeper")).json.status, "cancelled");
});

test("another peer token cannot see or drive this engine's agents", async () => {
  const minted = await peer<{ secret: string }>("POST", "/api/projects/peer-tokens", {
    session: peerSession,
    body: { label: "someone else" },
  });
  secondToken = minted.json.secret;
  const builder = await childRecord("builder");
  const observed = await peer("GET", peerChildPath(builder), { token: secondToken });
  assert.equal(observed.status, 404);
  assert.equal(observed.json.code, "peer_child_not_found");
  const steered = await peer("POST", peerChildPath(builder, "/messages"), {
    token: secondToken,
    body: { text: "hijack", delivery: "steer" },
  });
  assert.equal(steered.status, 404);
  const deleted = await peer("DELETE", peerChildPath(builder), { token: secondToken });
  assert.equal(deleted.status, 404);
  const traversal = await peer("GET", "/api/projects/peer/children/..%2F..%2Fetc/passwd", {
    token: peerToken,
  });
  assert.equal(traversal.status, 404);
  assert.equal((await peerObserve("builder")).json.exists, true, "the real owner still reaches it");
});

test("deleting a remote agent and then the Project cleans up on the peer", async () => {
  const builder = await childRecord("builder");
  const removed = await api("DELETE", `/api/projects/${project.id}/agents/builder`);
  assert.deepEqual(removed.json, { agent: "builder", deleted: true });
  assert.equal((await peer("GET", peerChildPath(builder), { token: peerToken })).status, 404);

  const inUse = await api("DELETE", `/api/projects/engines/${peerEngineId}`);
  assert.equal(inUse.status, 409);
  assert.equal(inUse.json.code, "engine_in_use");

  const record = (await readProject(project.id))!;
  const deleted = await api("DELETE", `/api/projects/${project.id}`);
  assert.equal(deleted.status, 200);
  for (const child of record.children.filter((entry) => entry.engineId === peerEngineId)) {
    assert.equal((await peer("GET", peerChildPath(child), { token: peerToken })).status, 404, child.name);
  }
  const info = await peer<{ workspaces: Array<{ root: string }> }>("GET", "/api/projects/peer/info", {
    token: peerToken,
  });
  assert.ok(
    info.json.workspaces.some((workspace) => workspace.root === PEER_REPO_REAL),
    "the peer's repository stays registered"
  );
});

test("revoking the peer token takes the engine offline; pairing again brings it back", async () => {
  script("probe", text(["Probe done."]));
  const created = await api<ProjectSnapshot>("POST", "/api/projects", { name: "Second", modelId: MODEL_ID });
  project = created.json;
  const agent = await api("POST", `/api/projects/${project.id}/agents`, {
    name: "probe",
    engine: peerEngineId,
    instructions: "Probe.",
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.json));
  await waitFor(
    "probe report",
    () => childRecord("probe"),
    (value) => value.lastReplyPreview === "Probe done.",
    30_000
  );

  const revoked = await peer("DELETE", `/api/projects/peer-tokens/${peerTokenId}`, { session: peerSession });
  assert.equal(revoked.status, 200);
  const probe = await api<{ agent: { status: string } }>("GET", `/api/projects/${project.id}/agents/probe`);
  assert.equal(probe.json.agent.status, "unknown");
  const message = await api("POST", `/api/projects/${project.id}/agents/probe/messages`, {
    text: "hello?",
    delivery: "queue",
  });
  assert.equal(message.status, 502);
  assert.equal(message.json.code, "peer_token_invalid");
  await heartbeatProjectPeerEngines();
  const offline = await api<{ engines: ProjectEngineSummary[] }>("GET", "/api/projects/engines");
  const remote = offline.json.engines.find((engine) => engine.id === peerEngineId)!;
  assert.equal(remote.online, false);
  assert.match(String(remote.error), /revoked/);

  const repaired = await api<{ engine: ProjectEngineSummary }>("POST", "/api/projects/engines", {
    baseUrl: PEER_URL,
    token: secondToken,
  });
  assert.equal(repaired.status, 201);
  assert.equal(repaired.json.engine.id, peerEngineId);
  assert.equal(repaired.json.engine.online, true);

  assert.equal((await api("DELETE", `/api/projects/${project.id}`)).status, 200);
  assert.equal((await api("DELETE", `/api/projects/engines/${peerEngineId}`)).status, 200);
  const engines = await api<{ engines: ProjectEngineSummary[] }>("GET", "/api/projects/engines");
  assert.deepEqual(engines.json.engines.map((engine) => engine.id), ["home"]);
});
