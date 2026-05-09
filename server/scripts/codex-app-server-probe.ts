import "../src/env-bootstrap.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSafeEnv } from "../src/lib/agents/spawn-env.js";

type JsonObject = Record<string, unknown>;

type ProbeArgs = {
  cwd: string;
  out: string;
  model?: string;
  scenario: string;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, "..");
const repoRoot = path.resolve(serverDir, "..");

const DEFAULT_SCENARIOS: Record<string, string> = {
  basic: "Reply with exactly one short sentence ending with the word pong.",
  command: "Run a harmless command that prints the current working directory.",
  approval:
    "Run a harmless command that prints the current working directory. This scenario is expected to request approval.",
  edit: "Create or update a file named codex-app-server-probe-output.txt with one line saying Codex App Server probe succeeded.",
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
    }
  }
  const cwd = out.cwd ?? path.join(serverDir, "tmp", "codex-app-server-probe", "workspace");
  return {
    cwd,
    out: out.out ?? path.join(serverDir, "tmp", "codex-app-server-probe", "events.jsonl"),
    model: out.model ?? (process.env.CODEX_APP_SERVER_PROBE_MODEL?.trim() || undefined),
    scenario: out.scenario ?? (process.env.CODEX_APP_SERVER_PROBE_SCENARIO?.trim() || "all"),
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

async function resolveCodexCommand(): Promise<string> {
  const configured = process.env.OPENCURSOR_CODEX_APP_SERVER_BIN?.trim() || process.env.OPENCURSOR_CODEX_BIN?.trim();
  if (configured) {
    return configured;
  }
  if (process.platform === "win32" && process.env.APPDATA?.trim()) {
    const npmShim = path.join(process.env.APPDATA, "npm", "codex.cmd");
    const pathMatches = await new Promise<string[]>((resolve) => {
      const child = spawn("where.exe", ["codex.cmd"], {
        env: spawnSafeEnv(),
        windowsHide: true,
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.on("error", () => resolve([]));
      child.on("exit", (code) => {
        resolve(
          code === 0
            ? stdout
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
            : []
        );
      });
    });
    const normalizedNpmShim = path.normalize(npmShim).toLowerCase();
    const pathShim = pathMatches.find(
      (match) => path.normalize(match).toLowerCase() !== normalizedNpmShim
    );
    if (pathShim) {
      return pathShim;
    }
    try {
      await fs.access(npmShim);
      return npmShim;
    } catch {
      // Fall through to PATH resolution by child_process.
    }
  }
  return "codex";
}

function scenarioNames(selected: string): string[] {
  if (selected === "all") {
    return Object.keys(DEFAULT_SCENARIOS);
  }
  if (!DEFAULT_SCENARIOS[selected]) {
    throw new Error(`Unknown scenario: ${selected}`);
  }
  return [selected];
}

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
    if (/token|secret|authorization|api[_-]?key|cookie/i.test(key)) {
      output[key] = "[redacted]";
      continue;
    }
    output[key] = sanitize(entry);
  }
  return output;
}

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

  respond(id: number, result: unknown): void {
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
    const id = typeof message.id === "number" ? message.id : null;
    if (id !== null && this.pending.has(id)) {
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
  scenario: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`${scenario} did not emit turn/completed before timeout`));
    }, 180_000);
    const cleanup = client.onNotification((message) => {
      void appendJsonLine(out, { type: "notification", scenario, message });
      if (message.id !== undefined && typeof message.method === "string") {
        const id = typeof message.id === "number" ? message.id : null;
        if (
          id !== null &&
          (message.method === "item/commandExecution/requestApproval" ||
            message.method === "item/fileChange/requestApproval")
        ) {
          client.respond(id, "accept");
        }
        void appendJsonLine(out, {
          type: "server_request",
          scenario,
          message,
          response: "accept",
        });
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

async function runScenario(input: {
  client: CodexAppServerProbeClient;
  out: string;
  threadId: string;
  name: string;
  prompt: string;
  cwd: string;
  model?: string;
}): Promise<void> {
  const approvalPolicy = input.name === "approval" ? "on-request" : "on-failure";
  await appendJsonLine(input.out, { type: "scenario_start", name: input.name });
  await input.client.request("turn/start", {
    threadId: input.threadId,
    mode: "agent",
    input: [{ type: "text", text: input.prompt }],
    cwd: input.cwd,
    ...(input.model ? { model: input.model } : {}),
    approvalPolicy,
    sandboxPolicy: {
      type: "workspaceWrite",
      mode: "workspaceWrite",
      writableRoots: [input.cwd],
      networkAccess: true,
      writable_roots: [input.cwd],
      network_access: true,
      exclude_tmpdir_env_var: false,
      exclude_slash_tmp: false,
    },
  });
  await waitForTurnCompleted(input.client, input.out, input.name);
  await appendJsonLine(input.out, { type: "scenario_end", name: input.name });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await ensureProbeWorkspace(args.cwd);
  await fs.rm(args.out, { force: true }).catch(() => undefined);

  const command = await resolveCodexCommand();
  const client = new CodexAppServerProbeClient(command, ["app-server"], args.cwd);
  try {
    await appendJsonLine(args.out, {
      type: "probe_start",
      command,
      cwd: args.cwd,
      model: args.model ?? null,
      repoRoot,
    });
    const init = await client.request("initialize", {
      clientInfo: {
        name: "opencursor_codex_app_server_probe",
        title: "OpenCursor Codex App Server Probe",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    await appendJsonLine(args.out, { type: "initialize_result", result: init });
    client.notify("initialized");

    let discoveredModel: string | undefined;
    for (const method of ["account/read", "model/list", "configRequirements/read"]) {
      const result = await client
        .request(method, method === "model/list" ? { limit: 50, includeHidden: false } : {})
        .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
      if (method === "model/list" && result && typeof result === "object" && "data" in result) {
        const data = Array.isArray((result as { data?: unknown }).data)
          ? ((result as { data: Array<Record<string, unknown>> }).data)
          : [];
        discoveredModel =
          data.find((entry) => entry.isDefault === true && typeof entry.id === "string")?.id as
            | string
            | undefined;
        discoveredModel ??= typeof data[0]?.id === "string" ? data[0].id : undefined;
      }
      await appendJsonLine(args.out, { type: "rpc_result", method, result });
    }
    const selectedModel = args.model ?? discoveredModel;

    const started = (await client.request("thread/start", {
      cwd: args.cwd,
      ...(selectedModel ? { model: selectedModel } : {}),
      serviceName: "opencursor_codex_app_server_probe",
    })) as { thread?: { id?: unknown } };
    await appendJsonLine(args.out, { type: "thread_start_result", result: started });
    const threadId = typeof started.thread?.id === "string" ? started.thread.id : "";
    if (!threadId) {
      throw new Error("thread/start did not return a thread id");
    }

    for (const name of scenarioNames(args.scenario)) {
      await runScenario({
        client,
        out: args.out,
        threadId,
        name,
        prompt: DEFAULT_SCENARIOS[name]!,
        cwd: args.cwd,
        model: selectedModel,
      });
    }
    await appendJsonLine(args.out, { type: "probe_end", out: args.out });
  } finally {
    client.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
