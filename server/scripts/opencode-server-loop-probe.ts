import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

type JsonRecord = Record<string, unknown>;

const baseUrl = process.env.OPENCURSOR_PROBE_BASE_URL ?? "http://localhost:9102";
const iterations = Number.parseInt(process.env.OPENCURSOR_PROBE_ITERATIONS ?? "3", 10);
const settleMs = Number.parseInt(process.env.OPENCURSOR_PROBE_SETTLE_MS ?? "12000", 10);
const timeoutMs = Number.parseInt(process.env.OPENCURSOR_PROBE_TIMEOUT_MS ?? "90000", 10);
const requestedWorkspaceRoot = path.resolve(process.env.OPENCURSOR_PROBE_WORKSPACE_ROOT ?? process.cwd());
const requestedModel = process.env.OPENCURSOR_PROBE_MODEL?.trim();

function loadEnvFile(filePath: string): void {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator < 0) continue;
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] ??= value;
    }
  } catch {
    // Optional local env files may not exist.
  }
}

loadEnvFile(path.resolve(".env"));
loadEnvFile(path.resolve(".env.local"));
loadEnvFile(path.resolve("server/.env"));
loadEnvFile(path.resolve("server/.env.local"));

async function request<T = JsonRecord>(
  pathname: string,
  init: RequestInit = {}
): Promise<{ response: Response; text: string; json: T }> {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const text = await response.text();
  let json: T;
  try {
    json = (text ? JSON.parse(text) : null) as T;
  } catch {
    json = null as T;
  }
  return { response, text, json };
}

function assertOk(result: { response: Response; text: string }, label: string): void {
  if (!result.response.ok) {
    throw new Error(`${label} failed: ${result.response.status} ${result.text.slice(0, 500)}`);
  }
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function summarizeSnapshot(snapshot: JsonRecord): {
  status: string;
  queueLength: number;
  userMessages: number;
  assistantEnds: string[];
  assistantChunksByMessage: Record<string, number>;
  statusTrace: string[];
  tail: Array<{ seq: unknown; kind: unknown; messageId?: unknown; status?: unknown; text?: string }>;
  providerSessionId: string | null;
} {
  const conversation = snapshot.conversation as JsonRecord | undefined;
  const events = Array.isArray(snapshot.events) ? (snapshot.events as JsonRecord[]) : [];
  const chunks: Record<string, number> = {};
  const assistantEnds: string[] = [];
  const statusTrace: string[] = [];
  let userMessages = 0;
  for (const event of events) {
    if (event.kind === "user_message") userMessages += 1;
    if (event.kind === "assistant_message_chunk") {
      const id = pickString(event.messageId) ?? "unknown";
      chunks[id] = (chunks[id] ?? 0) + 1;
    }
    if (event.kind === "assistant_message_end") {
      assistantEnds.push(pickString(event.messageId) ?? "unknown");
    }
    if (event.kind === "status") {
      statusTrace.push(String(event.status));
    }
  }
  const queued = Array.isArray(conversation?.queuedPrompts) ? conversation.queuedPrompts : [];
  return {
    status: String(conversation?.status ?? "unknown"),
    providerSessionId: pickString(conversation?.providerSessionId),
    queueLength: queued.length,
    userMessages,
    assistantEnds,
    assistantChunksByMessage: chunks,
    statusTrace,
    tail: events.slice(-10).map((event) => ({
      seq: event.seq,
      kind: event.kind,
      messageId: event.messageId,
      status: event.status,
      text: typeof event.text === "string" ? event.text.slice(0, 140) : undefined,
    })),
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const username = process.env.OPENCURSOR_AUTH_USERNAME ?? "admin";
  const password = process.env.OPENCURSOR_AUTH_PASSWORD ?? "admin";
  const login = await request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, remember: false }),
  });
  assertOk(login, "login");
  const token = login.response.headers.get("x-opencursor-session-token");
  if (!token) throw new Error("Login succeeded but no session token was returned.");

  const authHeaders = {
    "content-type": "application/json",
    "x-opencursor-session-token": token,
  };
  const bootstrap = await request<JsonRecord>("/api/workspaces/bootstrap", {
    headers: authHeaders,
  });
  assertOk(bootstrap, "bootstrap");
  const workspaces = (bootstrap.json.workspaces as JsonRecord[] | undefined) ?? [];
  const requestedWorkspace = workspaces.find((workspace) => {
    const root = pickString(workspace.root);
    return root ? path.resolve(root).toLowerCase() === requestedWorkspaceRoot.toLowerCase() : false;
  });
  const workspaceId =
    pickString(requestedWorkspace?.id) ??
    pickString(bootstrap.json.startupWorkspaceId) ??
    pickString(bootstrap.json.defaultWorkspaceId) ??
    (workspaces[0]?.id as string | undefined);
  if (!workspaceId) throw new Error("No workspace id returned by bootstrap.");

  const headers = {
    ...authHeaders,
    "x-opencursor-workspace-id": workspaceId,
  };
  const list = await request<JsonRecord>("/api/agents/conversations?limit=1", { headers });
  assertOk(list, "list conversations");
  const backends = (list.json.backends as JsonRecord[] | undefined) ?? [];
  const backend = backends.find((entry) => entry.id === "opencode-server");
  if (!backend) throw new Error("The opencode-server backend is not present.");
  if (backend.available !== true) throw new Error("The opencode-server backend is not available.");
  const modelOption = ((backend.cachedConfigOptions as JsonRecord[] | undefined) ?? []).find(
    (option) => option.id === "model" || option.category === "model"
  );
  const models = (modelOption?.options as JsonRecord[] | undefined) ?? [];
  const requestedModelPattern = requestedModel
    ? new RegExp(requestedModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    : null;
  const selectedModel = requestedModelPattern
    ? models.find((model) => requestedModelPattern.test(`${model.name ?? ""} ${model.value ?? ""}`))
    : models.find((model) => /big\s*pickle/i.test(`${model.name ?? ""} ${model.value ?? ""}`)) ??
      models.find((model) => /pickle/i.test(`${model.name ?? ""} ${model.value ?? ""}`));
  const modelValue = pickString(selectedModel?.value);
  const modelName = pickString(selectedModel?.name) ?? modelValue;
  if (!modelValue || !modelName) {
    const shown = models
      .slice(0, 60)
      .map((model) => `${model.name ?? ""} <${model.value ?? ""}>`)
      .join(", ");
    throw new Error(
      `Could not find requested opencode-server model (${requestedModel ?? "Big Pickle"}) in ${models.length} models. First models: ${shown}`
    );
  }

  console.log(
    JSON.stringify(
      {
        baseUrl,
        workspaceId,
        workspaceRoot: requestedWorkspaceRoot,
        backend: { id: backend.id, label: backend.label },
        model: { value: modelValue, name: modelName },
        iterations,
        settleMs,
      },
      null,
      2
    )
  );

  const failures: unknown[] = [];
  for (let index = 1; index <= iterations; index += 1) {
    const probeId = `opencode-loop-${index}-${randomUUID().slice(0, 8)}`;
    const create = await request<JsonRecord>("/api/agents/conversations", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: `OpenCode loop probe ${index}`,
        backendId: "opencode-server",
        mode: "agent",
        modelId: modelValue,
        modelName,
      }),
    });
    assertOk(create, `create conversation ${index}`);
    const conversation = (create.json.conversation as JsonRecord | undefined) ?? {};
    const conversationId = pickString(conversation.id);
    if (!conversationId) throw new Error("Create conversation did not return an id.");
    if ((conversation.config as JsonRecord | undefined)?.backendId !== "opencode-server") {
      throw new Error(`Created conversation used wrong backend: ${JSON.stringify(conversation.config)}`);
    }

    const patch = await request(`/api/agents/conversations/${conversationId}/config`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        modelId: modelValue,
        modelName,
        setConfigOptions: [{ configId: "model", value: modelValue }],
      }),
    });
    assertOk(patch, `patch model ${index}`);

    const promptText = [
      `Probe id: ${probeId}.`,
      "Use exactly one assistant response.",
      `Reply with exactly: DONE ${probeId}`,
      "Do not call tools. Do not ask follow-up questions. Do not continue after that exact line.",
    ].join(" ");
    const startedAt = Date.now();
    const prompt = await request<JsonRecord>(`/api/agents/conversations/${conversationId}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: promptText,
        clientEventId: `probe-user-${probeId}`,
        clientMessageId: `probe-message-${probeId}`,
      }),
    });
    assertOk(prompt, `prompt ${index}`);

    let snapshot = prompt.json.snapshot as JsonRecord;
    let summary = summarizeSnapshot(snapshot);
    while (Date.now() - startedAt < timeoutMs && ["running", "awaiting_permission"].includes(summary.status)) {
      await sleep(1000);
      const next = await request<JsonRecord>(`/api/agents/conversations/${conversationId}?full=1`, {
        headers,
      });
      assertOk(next, `poll ${index}`);
      snapshot = next.json.snapshot as JsonRecord;
      summary = summarizeSnapshot(snapshot);
    }
    const idleAt = Date.now();
    const postIdleSummaries = [summary];
    while (Date.now() - idleAt < settleMs) {
      await sleep(1000);
      const next = await request<JsonRecord>(`/api/agents/conversations/${conversationId}?full=1`, {
        headers,
      });
      assertOk(next, `settle poll ${index}`);
      snapshot = next.json.snapshot as JsonRecord;
      summary = summarizeSnapshot(snapshot);
      postIdleSummaries.push(summary);
    }

    const finalSummary = postIdleSummaries.at(-1)!;
    const cleanCompletion = finalSummary.status === "idle" && finalSummary.assistantEnds.length === 1;
    const cleanProviderFailure = finalSummary.status === "failed" && finalSummary.assistantEnds.length === 0;
    const issue =
      (!cleanCompletion && !cleanProviderFailure) ||
      finalSummary.queueLength !== 0 ||
      finalSummary.userMessages !== 1;
    const result = {
      iteration: index,
      conversationId,
      probeId,
      status: finalSummary.status,
      providerSessionId: finalSummary.providerSessionId,
      queueLength: finalSummary.queueLength,
      userMessages: finalSummary.userMessages,
      assistantEnds: finalSummary.assistantEnds,
      assistantChunksByMessage: finalSummary.assistantChunksByMessage,
      statusTrace: finalSummary.statusTrace,
      tail: finalSummary.tail,
      elapsedMs: Date.now() - startedAt,
      issue,
    };
    console.log(JSON.stringify(result, null, 2));
    if (issue) failures.push(result);
  }

  if (failures.length > 0) {
    throw new Error(`OpenCode loop probe found ${failures.length} failing iteration(s).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
