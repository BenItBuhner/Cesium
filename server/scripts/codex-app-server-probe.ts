import "../src/env-bootstrap.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSafeEnv } from "../src/lib/agents/spawn-env.js";
import { AGENT_CAPABILITIES } from "../src/lib/agents/agent-contract.js";
import { createCodexAppServerProvider } from "../src/lib/agents/codex-app-server-provider.js";
import { resolveHarnessRuntimeSpec } from "../src/lib/agents/harness-runtime.js";
import type {
  AgentConversationRecord,
  AgentEventInput,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
  AgentStoredEvent,
} from "../src/lib/agents/types.js";

/**
 * Live probe for the Codex App Server harness.
 *
 * Default mode drives Cesium's real provider (`codex-app-server-provider.ts`)
 * against the installed `codex app-server`, auto-answering approvals and
 * questions, and records the normalized Cesium event stream. `--raw` captures
 * the untouched JSON-RPC wire instead (schema discovery).
 *
 *   bun ./scripts/codex-app-server-probe.ts --scenario all
 *   bun ./scripts/codex-app-server-probe.ts --scenario approval --model kimi-k3
 *   bun ./scripts/codex-app-server-probe.ts --raw --scenario basic
 */

type JsonObject = Record<string, unknown>;

type ProbeArgs = {
  cwd: string;
  out: string;
  model?: string;
  scenario: string;
  raw: boolean;
  answer: "accept" | "decline";
  timeoutMs: number;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, "..");
const repoRoot = path.resolve(serverDir, "..");

type Scenario = {
  prompt: string;
  /** Cesium mode for the conversation. */
  mode?: string;
  /** Cesium execution mode (`permission` config option). */
  permission?: string;
  /** Cancel the turn shortly after streaming starts. */
  cancelAfterMs?: number;
  /** Resume the thread in a fresh process and send this follow-up. */
  resumePrompt?: string;
  /** Attach a small PNG so image input is exercised. */
  attachImage?: boolean;
};

const SCENARIOS: Record<string, Scenario> = {
  basic: { prompt: "Reply with exactly one short sentence ending with the word pong." },
  command: {
    prompt: "Run a harmless shell command that prints the current working directory, then tell me the result in one sentence.",
  },
  approval: {
    prompt: "Run `pwd` in the shell and report the output in one sentence.",
    permission: "on-request",
  },
  edit: {
    prompt:
      "Create or overwrite a file named codex-app-server-probe-output.txt containing exactly one line: Codex App Server probe succeeded. Then confirm in one sentence.",
  },
  plan: {
    prompt:
      "I want to add a tiny HTTP health endpoint to this project. Before planning, you MUST ask me one clarifying question with the request_user_input tool (for example which port to use). After my answer, produce a short plan.",
    mode: "plan",
  },
  question: {
    prompt:
      "Use the request_user_input tool right now to ask me which database I prefer, offering the options Postgres and SQLite. Wait for my answer, then reply with one sentence acknowledging it.",
    mode: "plan",
  },
  // Only works with OPENCURSOR_CODEX_APP_SERVER_ASK_IN_AGENT_MODE=1 (Codex keeps
  // request_user_input plan-only by default).
  "question-agent": {
    prompt:
      "If you have a request_user_input tool, use it right now to ask me which database I prefer (options Postgres and SQLite), wait for my answer, then acknowledge it in one sentence. If you do not have that tool, reply with exactly: NO_QUESTION_TOOL.",
    mode: "agent",
  },
  image: {
    prompt: "Describe the attached image in one short sentence (it is a tiny solid-colour square).",
    attachImage: true,
  },
  cancel: {
    prompt:
      "Write out the numbers from 1 to 3000, one number per line, with no other text. Do not stop early and do not use tools.",
    cancelAfterMs: 1_500,
  },
  resume: {
    prompt: "Remember the codeword AZURE-FALCON. Reply only with: stored.",
    resumePrompt: "What was the codeword I asked you to remember? Reply with just the codeword.",
  },
  badmodel: {
    prompt: "Reply with pong.",
  },
};

function parseArgs(argv: string[]): ProbeArgs {
  const out: Partial<ProbeArgs> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--cwd" && next) {
      out.cwd = path.resolve(next);
      index += 1;
    } else if (arg === "--out" && next) {
      out.out = path.resolve(next);
      index += 1;
    } else if (arg === "--model" && next) {
      out.model = next;
      index += 1;
    } else if (arg === "--scenario" && next) {
      out.scenario = next;
      index += 1;
    } else if (arg === "--answer" && next) {
      out.answer = next === "decline" ? "decline" : "accept";
      index += 1;
    } else if (arg === "--timeout" && next) {
      out.timeoutMs = Number.parseInt(next, 10) * 1000;
      index += 1;
    } else if (arg === "--raw") {
      out.raw = true;
    }
  }
  const cwd = out.cwd ?? path.join(serverDir, "tmp", "codex-app-server-probe", "workspace");
  return {
    cwd,
    out: out.out ?? path.join(serverDir, "tmp", "codex-app-server-probe", "events.jsonl"),
    model: out.model ?? (process.env.CODEX_APP_SERVER_PROBE_MODEL?.trim() || undefined),
    scenario: out.scenario ?? (process.env.CODEX_APP_SERVER_PROBE_SCENARIO?.trim() || "all"),
    raw: out.raw ?? false,
    answer: out.answer ?? "accept",
    timeoutMs: out.timeoutMs ?? 240_000,
  };
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(sanitize(value))}\n`, "utf8");
}

async function ensureProbeWorkspace(cwd: string): Promise<void> {
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify(
      {
        name: "codex-app-server-probe",
        private: true,
        scripts: { test: "node -e \"console.log('probe test ok')\"" },
      },
      null,
      2
    ),
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "notes.txt"),
    "Disposable workspace for Codex App Server event schema capture.\n",
    "utf8"
  );
}

function scenarioNames(selected: string): string[] {
  if (selected === "all") {
    return Object.keys(SCENARIOS).filter((name) => name !== "badmodel");
  }
  const names = selected.split(",").map((name) => name.trim()).filter(Boolean);
  for (const name of names) {
    if (!SCENARIOS[name]) {
      throw new Error(`Unknown scenario: ${name}. Known: ${Object.keys(SCENARIOS).join(", ")}`);
    }
  }
  return names;
}

const SECRET_KEY_PATTERN = /(secret|authorization|api[_-]?key|cookie|password|bearer)/i;
const TOKEN_KEY_PATTERN = /token/i;
const TOKEN_ACCOUNTING_PATTERN = /tokenusage|tokens$|token(count|limit|window|usage)/i;

function sanitize(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length > 4_000) {
      return `${value.slice(0, 4_000)}...[truncated:${value.length}]`;
    }
    return value.replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[redacted]");
  }
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: JsonObject = {};
  for (const [key, entry] of Object.entries(value as JsonObject)) {
    const isTokenAccounting = TOKEN_ACCOUNTING_PATTERN.test(key);
    if (SECRET_KEY_PATTERN.test(key) || (TOKEN_KEY_PATTERN.test(key) && !isTokenAccounting)) {
      output[key] = "[redacted]";
      continue;
    }
    output[key] = sanitize(entry);
  }
  return output;
}

// 1x1 red PNG.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

// ---------------------------------------------------------------------------
// Provider-driven probe
// ---------------------------------------------------------------------------

function createProbeCallbacks(input: {
  root: string;
  out: string;
  scenario: string;
  mode: string;
  modelId: string;
  permission: string;
  providerSessionId?: string | null;
}): {
  callbacks: AgentRuntimeCallbacks;
  events: AgentStoredEvent[];
  conversation: () => AgentConversationRecord;
} {
  const events: AgentStoredEvent[] = [];
  let seq = 0;
  let conversation: AgentConversationRecord = {
    schemaVersion: 1,
    id: `probe-${input.scenario}`,
    workspaceId: "codex-probe-workspace",
    title: `Codex probe ${input.scenario}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastEventSeq: 0,
    status: "idle",
    config: {
      backendId: "codex-app-server",
      mode: input.mode,
      modelId: input.modelId,
      modelName: input.modelId,
    },
    providerSessionId: input.providerSessionId ?? null,
    configOptions: [
      {
        id: "permission",
        name: "Execution Mode",
        category: "permission",
        currentValue: input.permission,
        options: [
          { value: "read-only", name: "Read Only" },
          { value: "workspace-write", name: "Workspace Write" },
          { value: "on-request", name: "Ask Every Time" },
        ],
      },
    ],
    capabilities: AGENT_CAPABILITIES["codex-app-server"],
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: false,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
  };
  const callbacks: AgentRuntimeCallbacks = {
    workspace: {
      id: "codex-probe-workspace",
      root: input.root,
      name: "Codex probe",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOpenedAt: Date.now(),
    },
    conversation,
    appendEvents: async (incoming: AgentEventInput[]) => {
      const stored = incoming.map((event) => {
        seq += 1;
        return { ...event, seq, createdAt: Date.now() } as AgentStoredEvent;
      });
      events.push(...stored);
      for (const event of stored) {
        await appendJsonLine(input.out, { type: "cesium_event", scenario: input.scenario, event });
        console.log(formatEvent(event));
      }
      return stored;
    },
    readSnapshot: async () => null,
    updateConversation: async (patch) => {
      conversation =
        typeof patch === "function"
          ? patch(conversation)
          : ({ ...conversation, ...patch } as AgentConversationRecord);
      callbacks.conversation = conversation;
      return conversation;
    },
  };
  return { callbacks, events, conversation: () => conversation };
}

function formatEvent(event: AgentStoredEvent): string {
  switch (event.kind) {
    case "assistant_message_chunk":
      return `  [assistant] ${JSON.stringify(event.text)}`;
    case "assistant_message_end":
      return `  [assistant_end] ${event.messageId} (${event.stopReason ?? ""})`;
    case "reasoning":
      return `  [reasoning] ${JSON.stringify(event.text.slice(0, 160))}`;
    case "tool_call":
    case "tool_call_update":
      return `  [${event.kind}] ${event.toolCallId} ${event.toolKind ?? ""} ${event.status} "${event.title ?? ""}" ${
        event.detail ? JSON.stringify(event.detail.slice(0, 160)) : ""
      }`;
    case "permission_request":
      return `  [permission_request] ${event.requestId} "${event.title}" options=${event.options.map((o) => o.optionId).join("|")}`;
    case "permission_resolved":
      return `  [permission_resolved] ${event.requestId} ${event.outcome} ${event.optionId ?? ""}`;
    case "question":
      return `  [question:${event.status}] ${event.questionId} ${JSON.stringify(event.prompt)} steps=${event.questions?.length ?? 0}`;
    case "status":
      return `  [status] ${event.status} ${event.detail ? JSON.stringify(event.detail.slice(0, 200)) : ""}`;
    case "system":
      return `  [system:${event.level}] ${event.text.slice(0, 220)}`;
    case "plan":
      return `  [plan] ${event.entries.map((entry) => `${entry.status}:${entry.content}`).join(" | ")}`;
    case "plan_file":
      return `  [plan_file] ${event.path}`;
    default:
      return `  [${event.kind}]`;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Answers approvals/questions as they appear until the turn settles. */
async function autoRespond(input: {
  handle: AgentSessionHandle;
  conversation: () => AgentConversationRecord;
  events: AgentStoredEvent[];
  answer: "accept" | "decline";
  out: string;
  scenario: string;
  done: () => boolean;
}): Promise<void> {
  const answeredPermissions = new Set<string>();
  const answeredQuestions = new Set<string>();
  while (!input.done()) {
    const conversation = input.conversation();
    const permission = conversation.pendingPermission;
    if (permission && !answeredPermissions.has(permission.requestId)) {
      answeredPermissions.add(permission.requestId);
      const optionId =
        input.answer === "accept"
          ? permission.options.find((option) => option.optionId === "accept")?.optionId ??
            permission.options.find((option) => option.kind === "allow_once")?.optionId
          : permission.options.find((option) => option.optionId === "decline")?.optionId ??
            permission.options.find((option) => option.kind === "reject_once")?.optionId;
      await appendJsonLine(input.out, { type: "probe_answer_permission", scenario: input.scenario, requestId: permission.requestId, optionId });
      console.log(`  >> answering permission ${permission.requestId} with ${optionId}`);
      await input.handle.answerPermission({ requestId: permission.requestId, optionId });
    }
    const question = conversation.pendingQuestion;
    if (question && !answeredQuestions.has(question.questionId)) {
      const event = [...input.events]
        .reverse()
        .find(
          (candidate): candidate is Extract<AgentStoredEvent, { kind: "question" }> =>
            candidate.kind === "question" && candidate.questionId === question.questionId && candidate.status === "pending"
        );
      if (event) {
        answeredQuestions.add(question.questionId);
        const steps = event.questions?.length
          ? event.questions
          : [{ id: "single", prompt: event.prompt, options: event.options }];
        const answer = steps
          .map((step) => {
            const first = step.options[0];
            return `${step.prompt}: ${first ? first.label : "Use port 8080"}`;
          })
          .join("\n");
        await appendJsonLine(input.out, { type: "probe_answer_question", scenario: input.scenario, questionId: question.questionId, answer });
        console.log(`  >> answering question ${question.questionId} with ${JSON.stringify(answer)}`);
        await input.handle.answerQuestion?.({ questionId: question.questionId, answer });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function runProviderScenario(args: ProbeArgs, name: string): Promise<void> {
  const scenario = SCENARIOS[name]!;
  const runtime = resolveHarnessRuntimeSpec("codex");
  if (!runtime) {
    throw new Error("Codex CLI not found (set OPENCURSOR_CODEX_BIN or install @openai/codex).");
  }
  const modelId = name === "badmodel" ? "gpt-6-astra" : args.model ?? "__default__";
  const provider = createCodexAppServerProvider({
    backend: {
      id: "codex-app-server",
      label: "Codex",
      description: "probe",
      available: true,
      defaultMode: "agent",
      defaultModelId: "__default__",
      defaultModelName: "Codex App Server Default",
      capabilities: AGENT_CAPABILITIES["codex-app-server"],
    },
    runtime,
    configOptions: [],
  });
  const first = createProbeCallbacks({
    root: args.cwd,
    out: args.out,
    scenario: name,
    mode: scenario.mode ?? "agent",
    modelId,
    permission: scenario.permission ?? "workspace-write",
  });
  await appendJsonLine(args.out, { type: "scenario_start", name, mode: scenario.mode ?? "agent", permission: scenario.permission ?? "workspace-write" });
  console.log(`\n=== scenario ${name} ===`);
  console.log(`  prompt: ${JSON.stringify(scenario.prompt)}`);
  const started = Date.now();
  const handle = await provider.startSession(first.callbacks);
  console.log(`  thread ${handle.sessionId} (model option: ${handle.configOptions.find((o) => o.id === "model")?.options.map((o) => o.value).join(",") ?? "-"})`);
  let turnError: string | null = null;
  const turn = handle
    .prompt({
      text: scenario.prompt,
      userMessageId: `probe-${name}-1`,
      attachments: scenario.attachImage
        ? [{ mimeType: "image/png", data: TINY_PNG_BASE64, name: "square.png" }]
        : undefined,
    })
    .catch((error: unknown) => {
      turnError = error instanceof Error ? error.message : String(error);
    });
  let settled = false;
  void turn.finally(() => {
    settled = true;
  });
  const responder = autoRespond({
    handle,
    conversation: first.conversation,
    events: first.events,
    answer: args.answer,
    out: args.out,
    scenario: name,
    done: () => settled,
  });
  if (scenario.cancelAfterMs) {
    await waitFor(
      () => settled || first.events.some((event) => event.kind === "assistant_message_chunk" || event.kind === "reasoning" || event.kind === "tool_call"),
      args.timeoutMs,
      "streaming before cancel"
    );
    await new Promise((resolve) => setTimeout(resolve, scenario.cancelAfterMs));
    console.log("  >> cancelling turn");
    await handle.cancel();
  }
  await Promise.race([
    turn,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`${name} timed out after ${args.timeoutMs}ms`)), args.timeoutMs)),
  ]);
  settled = true;
  await responder;
  const summary = {
    type: "scenario_end",
    name,
    durationMs: Date.now() - started,
    status: first.conversation().status,
    lastError: first.conversation().lastError,
    turnError,
    contextUsage: first.conversation().contextUsage ?? null,
    counts: countKinds(first.events),
  };
  await appendJsonLine(args.out, summary);
  console.log(`  -> status=${summary.status} error=${summary.lastError ?? turnError ?? "none"} in ${summary.durationMs}ms`);
  const threadId = handle.sessionId;
  await handle.dispose();

  if (scenario.resumePrompt) {
    console.log(`  >> resuming thread ${threadId} in a fresh process`);
    const second = createProbeCallbacks({
      root: args.cwd,
      out: args.out,
      scenario: `${name}-resume`,
      mode: scenario.mode ?? "agent",
      modelId,
      permission: scenario.permission ?? "workspace-write",
      providerSessionId: threadId,
    });
    const resumed = await provider.loadSession(second.callbacks, threadId);
    await appendJsonLine(args.out, { type: "resume_result", name, requested: threadId, actual: resumed.sessionId });
    console.log(`  resumed as ${resumed.sessionId} (${resumed.sessionId === threadId ? "same thread" : "NEW THREAD"})`);
    await Promise.race([
      resumed.prompt({ text: scenario.resumePrompt, userMessageId: `probe-${name}-2` }),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`${name} resume timed out`)), args.timeoutMs)),
    ]);
    const text = second.events
      .filter((event): event is Extract<AgentStoredEvent, { kind: "assistant_message_chunk" }> => event.kind === "assistant_message_chunk")
      .map((event) => event.text)
      .join("");
    await appendJsonLine(args.out, { type: "resume_end", name, status: second.conversation().status, text });
    console.log(`  -> resume status=${second.conversation().status} text=${JSON.stringify(text.slice(0, 200))}`);
    await resumed.dispose();
  }
}

function countKinds(events: AgentStoredEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Raw JSON-RPC capture (schema discovery)
// ---------------------------------------------------------------------------

class CodexAppServerProbeClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly notificationHandlers = new Set<(message: JsonObject) => void>();
  private nextId = 1;

  constructor(command: string, args: string[], cwd: string) {
    this.child = spawn(command, args, {
      cwd,
      env: spawnSafeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdout = createInterface({ input: this.child.stdout });
    stdout.on("line", (line) => this.handleLine(line));
    const stderr = createInterface({ input: this.child.stderr });
    stderr.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed) {
        void appendJsonLine(path.join(serverDir, "tmp", "codex-app-server-probe", "stderr.jsonl"), {
          type: "stderr",
          line: trimmed,
        });
      }
    });
    this.child.once("exit", (code, signal) => {
      const error = new Error(`codex app-server exited with code ${code ?? "null"} signal ${signal ?? "null"}`);
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  onNotification(handler: (message: JsonObject) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  async request(method: string, params: JsonObject = {}, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    const message = { method, id, params };
    this.write(message);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  notify(method: string, params: JsonObject = {}): void {
    this.write({ method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  dispose(): void {
    this.child.kill();
  }

  private write(message: JsonObject): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      return;
    }
    const isResponse = typeof message.method !== "string";
    const id = typeof message.id === "number" ? message.id : null;
    if (isResponse && id !== null && this.pending.has(id)) {
      const pending = this.pending.get(id)!;
      this.pending.delete(id);
      if (message.error) {
        const error = message.error as JsonObject;
        pending.reject(new Error(String(error.message ?? "Codex App Server request failed")));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    for (const handler of this.notificationHandlers) {
      handler(message);
    }
  }
}

async function waitForTurnCompleted(
  client: CodexAppServerProbeClient,
  out: string,
  scenario: string,
  timeoutMs: number
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`${scenario} did not emit turn/completed before timeout`));
    }, timeoutMs);
    const cleanup = client.onNotification((message) => {
      void appendJsonLine(out, { type: "notification", scenario, message });
      if (message.id !== undefined && typeof message.method === "string") {
        const id = typeof message.id === "number" || typeof message.id === "string" ? message.id : null;
        let response: unknown = null;
        if (id !== null) {
          // Approval responses must be the `{ decision }` struct on 0.150+.
          if (
            message.method === "item/commandExecution/requestApproval" ||
            message.method === "item/fileChange/requestApproval"
          ) {
            response = { decision: "accept" };
          } else if (message.method === "item/tool/requestUserInput" || message.method === "tool/requestUserInput") {
            const params = (message.params ?? {}) as { questions?: Array<{ id?: string; options?: Array<{ label?: string }> | null }> };
            const answers: Record<string, { answers: string[] }> = {};
            for (const question of params.questions ?? []) {
              if (question.id) {
                answers[question.id] = { answers: [question.options?.[0]?.label ?? "8080"] };
              }
            }
            response = { answers };
          } else if (message.method === "item/permissions/requestApproval") {
            response = { permissions: (message.params as { permissions?: unknown })?.permissions ?? {}, scope: "turn" };
          } else if (message.method === "currentTime/read") {
            response = { currentTimeAt: Math.floor(Date.now() / 1000) };
          } else if (message.method === "mcpServer/elicitation/request") {
            response = { action: "decline", content: null };
          }
          if (response !== null) {
            client.respond(id, response);
          }
        }
        void appendJsonLine(out, { type: "server_request", scenario, message, response });
      }
      const legacyMsg =
        message.method === "codex/event/task_complete" &&
        message.params &&
        typeof message.params === "object" &&
        "msg" in message.params
          ? (message.params as { msg?: { type?: string } }).msg
          : null;
      if (message.method === "turn/completed" || legacyMsg?.type === "task_complete") {
        clearTimeout(timeout);
        cleanup();
        resolve();
      }
    });
  });
}

async function runRawScenario(input: {
  client: CodexAppServerProbeClient;
  out: string;
  threadId: string;
  name: string;
  scenario: Scenario;
  cwd: string;
  model?: string;
  timeoutMs: number;
}): Promise<void> {
  // Codex >= 0.153 only accepts `untrusted | on-request | never | granular`;
  // `on-failure` was removed. `never` keeps unattended scenarios unattended.
  const approvalPolicy = input.scenario.permission === "on-request" ? "untrusted" : "never";
  await appendJsonLine(input.out, { type: "scenario_start", name: input.name });
  await input.client.request("turn/start", {
    threadId: input.threadId,
    input: [{ type: "text", text: input.scenario.prompt }],
    cwd: input.cwd,
    ...(input.model ? { model: input.model } : {}),
    approvalPolicy,
    sandboxPolicy:
      input.scenario.mode === "plan"
        ? { type: "readOnly", networkAccess: true }
        : { type: "workspaceWrite", writableRoots: [input.cwd], networkAccess: true },
    ...(input.scenario.mode === "plan" && input.model
      ? { collaborationMode: { mode: "plan", settings: { model: input.model, reasoning_effort: null } } }
      : {}),
  });
  await waitForTurnCompleted(input.client, input.out, input.name, input.timeoutMs);
  await appendJsonLine(input.out, { type: "scenario_end", name: input.name });
}

async function runRaw(args: ProbeArgs): Promise<void> {
  const runtime = resolveHarnessRuntimeSpec("codex");
  const command = runtime?.command ?? "codex";
  const client = new CodexAppServerProbeClient(command, [...(runtime?.args ?? []), "app-server"], args.cwd);
  try {
    await appendJsonLine(args.out, { type: "probe_start", command, cwd: args.cwd, model: args.model ?? null, repoRoot });
    const init = await client.request("initialize", {
      clientInfo: { name: "cesium_codex_app_server_probe", title: "Cesium Codex App Server Probe", version: "0.2.0" },
      capabilities: { experimentalApi: true },
    });
    await appendJsonLine(args.out, { type: "initialize_result", result: init });
    client.notify("initialized");

    for (const method of ["account/read", "config/read", "model/list", "collaborationMode/list", "configRequirements/read"]) {
      const result = await client
        .request(method, method === "model/list" ? { limit: 50, includeHidden: false } : {})
        .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
      await appendJsonLine(args.out, { type: "rpc_result", method, result });
    }

    // `model/list` only knows the built-in OpenAI catalog; only pin a model when asked.
    const started = (await client.request("thread/start", {
      cwd: args.cwd,
      ...(args.model ? { model: args.model } : {}),
      serviceName: "cesium_codex_app_server_probe",
    })) as { thread?: { id?: unknown }; model?: unknown; modelProvider?: unknown };
    await appendJsonLine(args.out, { type: "thread_start_result", result: started });
    const threadId = typeof started.thread?.id === "string" ? started.thread.id : "";
    if (!threadId) {
      throw new Error("thread/start did not return a thread id");
    }
    const model = args.model ?? (typeof started.model === "string" ? started.model : undefined);
    for (const name of scenarioNames(args.scenario)) {
      await runRawScenario({
        client,
        out: args.out,
        threadId,
        name,
        scenario: SCENARIOS[name]!,
        cwd: args.cwd,
        model,
        timeoutMs: args.timeoutMs,
      });
    }
    await appendJsonLine(args.out, { type: "probe_end", out: args.out });
  } finally {
    client.dispose();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await ensureProbeWorkspace(args.cwd);
  await fs.rm(args.out, { force: true }).catch(() => undefined);
  if (args.raw) {
    await runRaw(args);
    return;
  }
  await appendJsonLine(args.out, { type: "probe_start", cwd: args.cwd, model: args.model ?? null, repoRoot, mode: "provider" });
  const failures: string[] = [];
  for (const name of scenarioNames(args.scenario)) {
    try {
      await runProviderScenario(args, name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name}: ${message}`);
      await appendJsonLine(args.out, { type: "scenario_failed", name, error: message });
      console.error(`  !! scenario ${name} failed: ${message}`);
    }
  }
  await appendJsonLine(args.out, { type: "probe_end", out: args.out, failures });
  console.log(`\nEvents written to ${args.out}`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} scenario(s) failed:\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    // Storage/plugin bootstrap keeps handles open; the probe has nothing left to do.
    process.exit(process.exitCode ?? 0);
  });
