import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

type JsonRecord = Record<string, unknown>;

type BackendId = "opencode-server";

type StressResult = {
  backendId: BackendId;
  iteration: number;
  conversationId: string;
  targetDir: string;
  durationMs: number;
  assistantChars: number;
  toolCalls: number;
  finalSeq: number;
};

const repoRoot = path.resolve(process.cwd(), "..");
const defaultWorkspaceRoot = path.join(
  repoRoot,
  "server",
  "tmp",
  `opencode-harness-stress-${Date.now()}`
);

const baseUrl = (process.env.OPENCURSOR_PROBE_BASE_URL ?? "http://localhost:9107").replace(/\/$/, "");
const iterations = Number.parseInt(process.env.OPENCURSOR_PROBE_ITERATIONS ?? "10", 10);
const timeoutMs = Number.parseInt(process.env.OPENCURSOR_PROBE_TIMEOUT_MS ?? "480000", 10);
const requestTimeoutMs = Number.parseInt(process.env.OPENCURSOR_PROBE_REQUEST_TIMEOUT_MS ?? "60000", 10);
const settleMs = Number.parseInt(process.env.OPENCURSOR_PROBE_SETTLE_MS ?? "7000", 10);
const workspaceRoot = path.resolve(process.env.OPENCURSOR_PROBE_WORKSPACE_ROOT ?? defaultWorkspaceRoot);
const requestedModel = process.env.OPENCURSOR_PROBE_MODEL?.trim() || "big-pickle";
const backendList = (process.env.OPENCURSOR_PROBE_BACKENDS ?? "opencode-server")
  .split(",")
  .map((value) => value.trim())
  .filter((value): value is BackendId => value === "opencode-server");

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

loadEnvFile(path.resolve(repoRoot, ".env"));
loadEnvFile(path.resolve(repoRoot, ".env.local"));
loadEnvFile(path.resolve(repoRoot, "server", ".env"));
loadEnvFile(path.resolve(repoRoot, "server", ".env.local"));

async function request<T = JsonRecord>(
  pathname: string,
  init: RequestInit = {}
): Promise<{ response: Response; text: string; json: T }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  let response: Response;
  let text = "";
  try {
    response = await fetch(`${baseUrl}${pathname}`, {
      ...init,
      signal: init.signal ?? controller.signal,
    });
    text = await response.text();
  } catch (error) {
    throw new Error(
      `Request ${pathname} did not complete within ${requestTimeoutMs}ms: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    clearTimeout(timer);
  }
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
    throw new Error(`${label} failed: ${result.response.status} ${result.text.slice(0, 1000)}`);
  }
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function pickArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((entry): entry is JsonRecord => Boolean(entry) && typeof entry === "object") : [];
}

function eventSeq(event: JsonRecord): number {
  return typeof event.seq === "number" && Number.isFinite(event.seq) ? event.seq : 0;
}

function assistantText(events: JsonRecord[]): string {
  return events
    .filter((event) => event.kind === "assistant_message_chunk")
    .map((event) => (typeof event.text === "string" ? event.text : ""))
    .join("");
}

function statusTrace(events: JsonRecord[]): string[] {
  return events
    .filter((event) => event.kind === "status")
    .map((event) => `${event.status ?? "unknown"}${event.detail ? `:${event.detail}` : ""}`);
}

function findModel(backend: JsonRecord): { value: string; name: string; configId: string } {
  const configOptions = pickArray(backend.cachedConfigOptions);
  const modelOption = configOptions.find((option) => option.id === "model" || option.category === "model");
  const configId = pickString(modelOption?.id) ?? "model";
  const models = pickArray(modelOption?.options);
  const normalizedNeedle = requestedModel.toLowerCase().replace(/[\s_-]+/g, "");
  const selected =
    models.find((model) =>
      `${model.name ?? ""} ${model.value ?? ""}`.toLowerCase().replace(/[\s_-]+/g, "").includes(normalizedNeedle)
    ) ??
    models.find((model) => /big\s*pickle/i.test(`${model.name ?? ""} ${model.value ?? ""}`)) ??
    models.find((model) => /pickle/i.test(`${model.name ?? ""} ${model.value ?? ""}`));
  const value = pickString(selected?.value);
  if (!value) {
    const shown = models
      .slice(0, 80)
      .map((model) => `${model.name ?? ""} <${model.value ?? ""}>`)
      .join(", ");
    throw new Error(`Could not find Big Pickle for ${backend.id}. Saw ${models.length} models: ${shown}`);
  }
  return { value, name: pickString(selected?.name) ?? value, configId };
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function login(): Promise<Record<string, string>> {
  const username = process.env.OPENCURSOR_AUTH_USERNAME ?? "admin";
  const password = process.env.OPENCURSOR_AUTH_PASSWORD ?? "admin";
  const loginResult = await request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, remember: false }),
  });
  assertOk(loginResult, "login");
  const token = loginResult.response.headers.get("x-opencursor-session-token");
  if (!token) throw new Error("Login succeeded but did not return x-opencursor-session-token.");
  return {
    "content-type": "application/json",
    "x-opencursor-session-token": token,
  };
}

async function prepareWorkspace(authHeaders: Record<string, string>): Promise<{ workspaceId: string; headers: Record<string, string> }> {
  await fs.promises.mkdir(workspaceRoot, { recursive: true });
  await fs.promises.writeFile(
    path.join(workspaceRoot, "README.txt"),
    "Disposable OpenCode harness stress workspace. Safe to delete.\n",
    "utf8"
  );
  const opened = await request<JsonRecord>("/api/workspaces/open", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      root: workspaceRoot,
      name: `OpenCode Harness Stress ${Date.now()}`,
      trackRecent: false,
    }),
  });
  assertOk(opened, "open workspace");
  const workspace = opened.json.workspace as JsonRecord | undefined;
  const workspaceId = pickString(workspace?.id);
  if (!workspaceId) throw new Error("Workspace open did not return an id.");
  return {
    workspaceId,
    headers: {
      ...authHeaders,
      "x-opencursor-workspace-id": workspaceId,
    },
  };
}

async function loadBackendModels(headers: Record<string, string>): Promise<Record<BackendId, { value: string; name: string; configId: string }>> {
  const list = await request<JsonRecord>("/api/agents/conversations?limit=1", { headers });
  assertOk(list, "list conversations");
  const backends = pickArray(list.json.backends);
  const output = {} as Record<BackendId, { value: string; name: string; configId: string }>;
  for (const backendId of backendList) {
    const backend = backends.find((entry) => entry.id === backendId);
    if (!backend) throw new Error(`${backendId} backend is missing.`);
    if (backend.available !== true) throw new Error(`${backendId} backend is not available.`);
    output[backendId] = findModel(backend);
  }
  return output;
}

async function answerPermissionIfNeeded(
  headers: Record<string, string>,
  conversationId: string,
  conversation: JsonRecord
): Promise<boolean> {
  const pending = conversation.pendingPermission as JsonRecord | null | undefined;
  const requestId = pickString(pending?.requestId);
  if (!requestId) return false;
  const options = pickArray(pending?.options);
  const option =
    options.find((entry) => entry.optionId === "allow_always") ??
    options.find((entry) => /allow/i.test(`${entry.optionId ?? ""} ${entry.name ?? ""}`)) ??
    options[0];
  const optionId = pickString(option?.optionId);
  const answered = await request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/permission`, {
    method: "POST",
    headers,
    body: JSON.stringify({ requestId, optionId }),
  });
  assertOk(answered, `answer permission ${conversationId}`);
  return true;
}

async function snapshot(headers: Record<string, string>, conversationId: string): Promise<JsonRecord> {
  const result = await request<JsonRecord>(`/api/agents/conversations/${encodeURIComponent(conversationId)}?full=1`, {
    headers,
  });
  assertOk(result, `snapshot ${conversationId}`);
  return result.json.snapshot as JsonRecord;
}

function validateStableSnapshot(input: {
  backendId: BackendId;
  iteration: number;
  targetDir: string;
  before: JsonRecord;
  after: JsonRecord;
}): StressResult {
  const conversation = input.after.conversation as JsonRecord;
  const events = pickArray(input.after.events);
  const beforeEvents = pickArray(input.before.events);
  const queued = pickArray(conversation.queuedPrompts);
  const finalStatus = pickString(conversation.status) ?? "unknown";
  const badStatus = events.find(
    (event) =>
      event.kind === "status" &&
      ["failed", "cancelled", "interrupted"].includes(String(event.status))
  );
  const ends = events.filter((event) => event.kind === "assistant_message_end");
  const text = assistantText(events).trim();
  const toolCalls = events.filter((event) => event.kind === "tool_call").length;
  const finalSeq = Math.max(0, ...ends.map(eventSeq));
  const latestSeq = Math.max(0, ...events.map(eventSeq));
  const beforeLatestSeq = Math.max(0, ...beforeEvents.map(eventSeq));
  const requiredPath = path.join(workspaceRoot, input.targetDir, "README.md");

  if (finalStatus !== "idle") {
    throw new Error(`${input.backendId} #${input.iteration} ended with status ${finalStatus}. Trace: ${statusTrace(events).join(" | ")}`);
  }
  if (queued.length > 0) {
    throw new Error(`${input.backendId} #${input.iteration} left ${queued.length} queued prompts.`);
  }
  if (badStatus) {
    throw new Error(`${input.backendId} #${input.iteration} emitted bad status ${badStatus.status}: ${badStatus.detail ?? ""}`);
  }
  if (ends.length !== 1) {
    throw new Error(`${input.backendId} #${input.iteration} expected exactly 1 assistant end, saw ${ends.length}.`);
  }
  if (!text || text.length < 30) {
    throw new Error(`${input.backendId} #${input.iteration} assistant text is missing or too short.`);
  }
  if (finalSeq < latestSeq) {
    const tail = events
      .filter((event) => eventSeq(event) > finalSeq)
      .map((event) => `${event.seq}:${event.kind}:${event.status ?? ""}`)
      .join(", ");
    throw new Error(`${input.backendId} #${input.iteration} emitted events after assistant end: ${tail}`);
  }
  if (latestSeq !== beforeLatestSeq) {
    throw new Error(`${input.backendId} #${input.iteration} was not stable after settle: ${beforeLatestSeq} -> ${latestSeq}`);
  }
  if (!fs.existsSync(requiredPath)) {
    throw new Error(`${input.backendId} #${input.iteration} did not create expected file ${requiredPath}`);
  }
  return {
    backendId: input.backendId,
    iteration: input.iteration,
    conversationId: pickString(conversation.id) ?? "unknown",
    targetDir: input.targetDir,
    durationMs: 0,
    assistantChars: text.length,
    toolCalls,
    finalSeq,
  };
}

function promptFor(input: { backendId: BackendId; iteration: number; targetDir: string }): string {
  return [
    `Stress run ${input.backendId} #${input.iteration}.`,
    `Create a brand-new tiny Next.js-style frontend application inside ./${input.targetDir}.`,
    "The brief is intentionally loose: make it feel like a polished product landing page for an AI workbench, with a hero, feature cards, a small status panel, and a README explaining how to run it.",
    "Do not install dependencies and do not run a dev server. Create files directly.",
    "At minimum create README.md, package.json, app/page.tsx, app/layout.tsx, and app/globals.css under that directory.",
    "Use whatever file inspection or shell/listing tools you think are helpful, but keep it to one turn.",
    `When done, finish with a concise summary that includes the exact marker STRESS_DONE_${input.backendId}_${input.iteration}.`,
  ].join(" ");
}

async function runOne(input: {
  headers: Record<string, string>;
  backendId: BackendId;
  model: { value: string; name: string; configId: string };
  iteration: number;
}): Promise<StressResult> {
  const targetDir = path.posix.join("generated", `${input.backendId}-big-pickle-${String(input.iteration).padStart(2, "0")}`);
  const startedAt = Date.now();
  console.log(`[stress] create ${input.backendId} #${input.iteration}`);
  const create = await request<JsonRecord>("/api/agents/conversations", {
    method: "POST",
    headers: input.headers,
    body: JSON.stringify({
      title: `Stress ${input.backendId} #${input.iteration}`,
      backendId: input.backendId,
      mode: "agent",
      modelId: input.model.value,
      modelName: input.model.name,
    }),
  });
  assertOk(create, `create ${input.backendId} #${input.iteration}`);
  const conversation = create.json.conversation as JsonRecord | undefined;
  const conversationId = pickString(conversation?.id);
  if (!conversationId) throw new Error("Conversation create returned no id.");

  console.log(`[stress] patch model ${input.backendId} #${input.iteration}`);
  const patch = await request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/config`, {
    method: "PATCH",
    headers: input.headers,
    body: JSON.stringify({
      mode: "agent",
      modelId: input.model.value,
      modelName: input.model.name,
      setConfigOptions: [{ configId: input.model.configId, value: input.model.value }],
    }),
  });
  assertOk(patch, `patch ${input.backendId} #${input.iteration}`);

  console.log(`[stress] prompt ${input.backendId} #${input.iteration}`);
  const prompt = await request<JsonRecord>(`/api/agents/conversations/${encodeURIComponent(conversationId)}/prompt`, {
    method: "POST",
    headers: input.headers,
    body: JSON.stringify({
      text: promptFor({ backendId: input.backendId, iteration: input.iteration, targetDir }),
      clientEventId: `stress-user-${input.backendId}-${input.iteration}-${randomUUID()}`,
      clientMessageId: `stress-message-${input.backendId}-${input.iteration}-${randomUUID()}`,
    }),
  });
  assertOk(prompt, `prompt ${input.backendId} #${input.iteration}`);
  console.log(`[stress] prompt accepted ${input.backendId} #${input.iteration}`);

  let current = await snapshot(input.headers, conversationId);
  while (Date.now() - startedAt < timeoutMs) {
    const conversationRecord = current.conversation as JsonRecord;
    const status = pickString(conversationRecord.status) ?? "unknown";
    if (status === "awaiting_permission") {
      console.log(`[stress] permission requested ${input.backendId} #${input.iteration}`);
      const answered = await answerPermissionIfNeeded(input.headers, conversationId, conversationRecord);
      if (answered) {
        await wait(500);
      }
    }
    if (status !== "running" && status !== "awaiting_permission") {
      break;
    }
    await wait(1500);
    current = await snapshot(input.headers, conversationId);
  }

  const finalConversation = current.conversation as JsonRecord;
  const finalStatus = pickString(finalConversation.status) ?? "unknown";
  if (finalStatus === "running" || finalStatus === "awaiting_permission") {
    throw new Error(`${input.backendId} #${input.iteration} timed out after ${timeoutMs}ms with status ${finalStatus}.`);
  }
  if (finalStatus !== "idle") {
    throw new Error(`${input.backendId} #${input.iteration} ended with status ${finalStatus}.`);
  }

  await wait(settleMs);
  const settled = await snapshot(input.headers, conversationId);
  const result = validateStableSnapshot({
    backendId: input.backendId,
    iteration: input.iteration,
    targetDir,
    before: current,
    after: settled,
  });
  result.durationMs = Date.now() - startedAt;
  return result;
}

async function main(): Promise<void> {
  if (backendList.length === 0) {
    throw new Error("No valid backends requested.");
  }
  const authHeaders = await login();
  const { workspaceId, headers } = await prepareWorkspace(authHeaders);
  const models = await loadBackendModels(headers);
  console.log(
    JSON.stringify(
      {
        baseUrl,
        workspaceId,
        workspaceRoot,
        backends: backendList,
        iterations,
        settleMs,
        timeoutMs,
        requestTimeoutMs,
        models,
      },
      null,
      2
    )
  );

  const results: StressResult[] = [];
  for (const backendId of backendList) {
    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      console.log(`[stress] starting ${backendId} #${iteration}/${iterations}`);
      const result = await runOne({ headers, backendId, model: models[backendId], iteration });
      results.push(result);
      console.log(
        `[stress] ok ${backendId} #${iteration}: ${result.durationMs}ms, chars=${result.assistantChars}, tools=${result.toolCalls}, dir=${result.targetDir}`
      );
    }
  }

  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

main().catch((error) => {
  console.error("[stress] failed:", error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
