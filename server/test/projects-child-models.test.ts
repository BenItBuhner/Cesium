import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ProjectSnapshot } from "@cesium/core/projects";
import { messageText, startFakeChatModel, text, waitFor } from "./helpers/fake-chat-model.js";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-projects-models-"));

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
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "NVIDIA_API_KEY",
  "CEREBRAS_API_KEY",
  "CROFAI_API_KEY",
  "OPENCURSOR_TRANSCRIPTION_BASE_URL",
  "OPENCURSOR_TRANSCRIPTION_API_KEY",
  "OPENCURSOR_TITLE_MODEL",
  "CESIUM_PROJECTS_ENABLED",
]) {
  delete process.env[key];
}
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
process.env.WORKSPACE_ALLOWED_ROOTS = TEST_DATA_DIR;
process.env.CESIUM_ENGINE_LABEL = "Home";

// Catalog rows from providers with no key on this engine, as models.dev lists them.
const keyless = (providerId: string, modelId: string) => ({
  providerId,
  providerName: providerId,
  modelId,
  modelName: modelId,
  apiKind: "openai-chat-completions",
  supportsTools: true,
  supportsReasoning: false,
  supportsStructuredOutput: false,
  supportsImages: false,
  contextWindow: 200_000,
});
await fs.mkdir(path.join(TEST_DATA_DIR, "profile"), { recursive: true });
await fs.writeFile(
  path.join(TEST_DATA_DIR, "profile", "cesium-agent-models-dev-cache.json"),
  JSON.stringify({
    schemaVersion: 1,
    updatedAt: Date.now(),
    entries: [
      keyless("302ai", "302ai/claude_sonnet_4"),
      keyless("anthropic", "anthropic/claude-sonnet-4-5"),
    ],
  })
);

const model = await startFakeChatModel();
const { script, requestsFor } = model;
process.env.CESIUM_BASE_URL = model.baseUrl;
process.env.CESIUM_API_KEY = "sk-test-projects";
process.env.CESIUM_PROVIDER_ID = "projhost";
process.env.CESIUM_DEFAULT_MODEL = "kimi-k3";
process.env.CESIUM_MODELS = "kimi-k3,nemotron-3-ultra";
const KIMI = "projhost/kimi-k3";
const NEMOTRON = "projhost/nemotron-3-ultra";

const [
  { createCesiumApp },
  { agentRuntimeManager },
  { readConversationRecord },
  { listAgentBackendsWithCache },
  { formatCesiumModelRoster, listCesiumAgentModelRoster },
  { chooseChildModel, requireRunnableChildModel },
  { executeProjectOrchestratorTool },
  { readProject },
  { getWorkspaceById },
] = await Promise.all([
  import("../src/app.js"),
  import("../src/lib/agents/runtime-manager.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/agents/providers.js"),
  import("../src/lib/cesium-agent-settings.js"),
  import("../src/lib/projects/child-model.js"),
  import("../src/lib/projects/orchestrator-tools.js"),
  import("../src/lib/projects/project-store.js"),
  import("../src/lib/workspace-registry.js"),
]);

const app = createCesiumApp();

after(async () => {
  await model.close();
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

async function api<T = Record<string, unknown>>(
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

type CreateResult = { created: { name: string; model: string | null }; warning?: string };

let project: ProjectSnapshot;

async function setProjectDefaultModel(modelId: string) {
  const patched = await api<ProjectSnapshot>("PATCH", `/api/projects/${project.id}`, {
    settings: { defaultChildModelId: modelId },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  project = patched.json;
}

async function createAgent(args: Record<string, unknown>): Promise<CreateResult> {
  return JSON.parse(
    await executeProjectOrchestratorTool(project.id, "project_create_agent", {
      instructions: "Say hello.",
      ...args,
    })
  ) as CreateResult;
}

async function childConversation(name: string) {
  const child = (await readProject(project.id))?.children.find((entry) => entry.name === name);
  assert.ok(child, `child ${name} exists`);
  return waitFor(
    `${name} finishes its turn`,
    () => readConversationRecord(child.workspaceId, child.conversationId),
    (record) => record.status === "idle"
  );
}

function upstreamModel(name: string): string | undefined {
  return (requestsFor(name)[0] as { model?: string } | undefined)?.model;
}

test("the credentialed roster drops catalog models whose provider has no key here", async () => {
  const everything = (await listCesiumAgentModelRoster()).map((entry) => entry.modelId);
  assert.ok(everything.includes("302ai/claude_sonnet_4"), "the ordinary roster is unchanged");
  assert.ok(everything.includes("anthropic/claude-sonnet-4-5"));

  const runnable = await listCesiumAgentModelRoster({ credentialedOnly: true });
  assert.deepEqual(runnable.map((entry) => entry.modelId), [KIMI, NEMOTRON]);
  const [heading, first] = formatCesiumModelRoster(runnable, { heading: "Runnable here:" }).split("\n");
  assert.equal(heading, "Runnable here:");
  assert.ok(first?.startsWith(`- ${KIMI} (current default) [`), first);
});

test("chooseChildModel keeps runnable models, resolves bare names, and falls back from keyless ones", async () => {
  const pick = (requested: string | null, fallback: string | null = null, harness = "cesium-agent") =>
    chooseChildModel({ harness, requested, fallback, engineLabel: "Home" });
  const models = `Models with credentials on Home: ${KIMI}, ${NEMOTRON}.`;

  assert.deepEqual(await pick(NEMOTRON, KIMI), { modelId: NEMOTRON, warning: null });
  assert.deepEqual(await pick("nemotron-3-ultra"), { modelId: NEMOTRON, warning: null });
  assert.deepEqual(
    await pick("projhost/not-in-the-catalog"),
    { modelId: "projhost/not-in-the-catalog", warning: null },
    "a provider with a key may serve models the catalog does not know yet"
  );
  assert.deepEqual(await pick(null, NEMOTRON), { modelId: NEMOTRON, warning: null });
  assert.deepEqual(await pick(null), { modelId: null, warning: null }, "the harness default runs");

  assert.deepEqual(await pick("302ai/claude_sonnet_4", NEMOTRON), {
    modelId: NEMOTRON,
    warning: `Model "302ai/claude_sonnet_4" cannot run on Home: no API key is configured there for provider "302ai". The agent runs on ${NEMOTRON} (the Project default) instead. ${models}`,
  });
  assert.deepEqual(await pick("302ai/claude_sonnet_4"), {
    modelId: KIMI,
    warning: `Model "302ai/claude_sonnet_4" cannot run on Home: no API key is configured there for provider "302ai". The agent runs on ${KIMI} (the Home default) instead. ${models}`,
  });
  assert.deepEqual(await pick(null, "anthropic/claude-sonnet-4-5"), {
    modelId: KIMI,
    warning: `The Project default model "anthropic/claude-sonnet-4-5" cannot run on Home: no API key is configured there for provider "anthropic". The agent runs on ${KIMI} (the Home default) instead. ${models}`,
  });
  assert.equal(
    (await pick("claude-9")).warning?.split(". The agent")[0],
    'Model "claude-9" cannot run on Home: no model with credentials there is named "claude-9"'
  );
  assert.deepEqual(
    await pick("302ai/claude_sonnet_4", null, "codex-app-server"),
    { modelId: "302ai/claude_sonnet_4", warning: null },
    "other harnesses own their model handling"
  );

  assert.equal(
    await requireRunnableChildModel({ harness: "cesium-agent", requested: "kimi-k3", engineLabel: "Home" }),
    KIMI
  );
  await assert.rejects(
    requireRunnableChildModel({
      harness: "cesium-agent",
      requested: "302ai/claude_sonnet_4",
      engineLabel: "Home",
    }),
    {
      name: "ProjectError",
      message: `Model "302ai/claude_sonnet_4" cannot run on Home: no API key is configured there for provider "302ai". ${models}`,
    }
  );
});

test("with no model credentialed anywhere, a keyless request is refused outright", async () => {
  const saved = { base: process.env.CESIUM_BASE_URL, key: process.env.CESIUM_API_KEY };
  delete process.env.CESIUM_BASE_URL;
  delete process.env.CESIUM_API_KEY;
  try {
    await assert.rejects(
      chooseChildModel({ harness: "cesium-agent", requested: "302ai/claude_sonnet_4", engineLabel: "Home" }),
      {
        name: "ProjectError",
        message:
          'Model "302ai/claude_sonnet_4" cannot run on Home: no API key is configured there for provider "302ai", and no other Cesium Agent model has credentials there. Add a provider key under Settings → Agents → Cesium Agent on Home, or use another harness.',
      }
    );
  } finally {
    process.env.CESIUM_BASE_URL = saved.base;
    process.env.CESIUM_API_KEY = saved.key;
  }
});

test("the orchestrator is offered only models it can start agents on", async () => {
  const created = await api<ProjectSnapshot>("POST", "/api/projects", { name: "Models", modelId: KIMI });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  project = created.json;
  await setProjectDefaultModel(NEMOTRON);

  script("orchestrator", text(["Ready."]));
  const workspace = await getWorkspaceById(project.orchestrator.workspaceId);
  assert.ok(workspace);
  await agentRuntimeManager.promptConversation(workspace, project.orchestrator.conversationId, "Plan.");
  await waitFor(
    "orchestrator turn",
    () => readConversationRecord(project.orchestrator.workspaceId, project.orchestrator.conversationId),
    (record) => record.status === "idle" && requestsFor("orchestrator").length === 1
  );
  const prompt = requestsFor("orchestrator")[0]!.messages.map(messageText).join("\n");
  const roster = prompt.match(/<available-models>\n([\s\S]*?)\n<\/available-models>/)?.[1] ?? "";
  assert.match(roster, /^Cesium Agent models with credentials on Home \(this engine\), for project_create_agent\.model\./);
  assert.match(roster, new RegExp(`^- ${NEMOTRON} \\(current default\\)`, "m"), "marks the Project default");
  assert.match(roster, new RegExp(`^- ${KIMI} \\[`, "m"));
  assert.doesNotMatch(roster, /302ai|anthropic/);
});

test("project_create_agent starts keyless requests on a runnable model and warns the orchestrator", async () => {
  const fixer = await createAgent({ name: "fixer", model: "302ai/claude_sonnet_4" });
  assert.equal(fixer.created.model, NEMOTRON);
  assert.equal(
    fixer.warning,
    `Model "302ai/claude_sonnet_4" cannot run on Home: no API key is configured there for provider "302ai". The agent runs on ${NEMOTRON} (the Project default) instead. Models with credentials on Home: ${KIMI}, ${NEMOTRON}.`
  );
  assert.equal((await childConversation("fixer")).config.modelId, NEMOTRON);
  assert.equal(upstreamModel("fixer"), "nemotron-3-ultra", "the turn went to the credentialed provider");

  const bare = await createAgent({ name: "bare", model: "kimi-k3" });
  assert.equal(bare.created.model, KIMI);
  assert.equal("warning" in bare, false);
  const plain = await createAgent({ name: "plain" });
  assert.equal(plain.created.model, NEMOTRON, "no model means the Project default");
  assert.equal("warning" in plain, false);

  await setProjectDefaultModel("anthropic/claude-sonnet-4-5");
  const orphaned = await createAgent({ name: "orphaned" });
  assert.equal(orphaned.created.model, KIMI);
  assert.match(
    orphaned.warning ?? "",
    /^The Project default model "anthropic\/claude-sonnet-4-5" cannot run on Home: no API key is configured there for provider "anthropic"\. The agent runs on projhost\/kimi-k3 \(the Home default\) instead\./
  );
  await setProjectDefaultModel(NEMOTRON);

  const viaRoute = await api<{ agent: { modelId: string }; warning?: string }>(
    "POST",
    `/api/projects/${project.id}/agents`,
    { name: "manual", instructions: "Say hello.", model: "anthropic/claude-sonnet-4-5" }
  );
  assert.equal(viaRoute.status, 201, JSON.stringify(viaRoute.json));
  assert.equal(viaRoute.json.agent.modelId, NEMOTRON);
  assert.match(viaRoute.json.warning ?? "", /^Model "anthropic\/claude-sonnet-4-5" cannot run on Home/);

  for (const name of ["bare", "plain", "orphaned", "manual"]) {
    await childConversation(name);
  }
  assert.equal(upstreamModel("orphaned"), "kimi-k3");
});

test("project_update_agent refuses a keyless model and resolves a bare name", async () => {
  await assert.rejects(
    executeProjectOrchestratorTool(project.id, "project_update_agent", {
      agent: "fixer",
      model: "302ai/claude_sonnet_4",
    }),
    {
      name: "ProjectError",
      message: `Model "302ai/claude_sonnet_4" cannot run on Home: no API key is configured there for provider "302ai". Models with credentials on Home: ${KIMI}, ${NEMOTRON}.`,
    }
  );
  assert.equal((await childConversation("fixer")).config.modelId, NEMOTRON, "the agent keeps its model");

  const updated = JSON.parse(
    await executeProjectOrchestratorTool(project.id, "project_update_agent", { agent: "fixer", model: "kimi-k3" })
  ) as { updated: { model: string } };
  assert.equal(updated.updated.model, KIMI);
  assert.equal((await readProject(project.id))?.children.find((child) => child.name === "fixer")?.modelId, KIMI);
});

test("project_create_agent refuses a harness that cannot run on this engine", async () => {
  await assert.rejects(
    createAgent({ name: "ghost", harness: "nope" }),
    (error: Error) => {
      assert.equal(error.name, "ProjectError");
      assert.match(error.message, /^Unknown harness "nope"\. Harnesses available on Home: .*cesium-agent/);
      return true;
    }
  );
  const unavailable = (await listAgentBackendsWithCache()).find((backend) => !backend.available);
  assert.ok(unavailable, "some harness is not installed or signed in on the test machine");
  await assert.rejects(createAgent({ name: "ghost", harness: unavailable.id }), (error: Error) => {
    assert.equal(error.name, "ProjectError");
    assert.equal(
      error.message.split(". Harnesses")[0],
      `${unavailable.label} (${unavailable.id}) cannot run on Home: it is not installed or has no credentials there`
    );
    return true;
  });
  const record = await readProject(project.id);
  assert.equal(record?.children.some((child) => child.name === "ghost"), false);
});
