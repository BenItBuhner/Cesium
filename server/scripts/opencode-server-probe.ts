import "../src/env-bootstrap.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSafeEnv } from "../src/lib/agents/spawn-env.js";

type JsonObject = Record<string, unknown>;

type ProbeArgs = {
  cwd: string;
  out: string;
  model?: string;
  agent?: string;
  scenario: string;
  baseUrl?: string;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, "..");
const repoRoot = path.resolve(serverDir, "..");

const SCENARIOS: Record<string, string> = {
  basic: "Reply with exactly one short sentence ending with the word pong.",
  context: "Use the prior no-reply context and answer with one short sentence.",
  shell: "Run a harmless command that prints the current working directory.",
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
    } else if (arg === "--agent" && next) {
      out.agent = next;
      index += 1;
    } else if (arg === "--scenario" && next) {
      out.scenario = next;
      index += 1;
    } else if (arg === "--base-url" && next) {
      out.baseUrl = next;
      index += 1;
    }
  }
  const cwd = out.cwd ?? path.join(serverDir, "tmp", "opencode-server-probe", "workspace");
  return {
    cwd,
    out: out.out ?? path.join(serverDir, "tmp", "opencode-server-probe", "events.jsonl"),
    model: out.model ?? (process.env.OPENCODE_SERVER_PROBE_MODEL?.trim() || undefined),
    agent: out.agent ?? (process.env.OPENCODE_SERVER_PROBE_AGENT?.trim() || undefined),
    scenario: out.scenario ?? (process.env.OPENCODE_SERVER_PROBE_SCENARIO?.trim() || "basic"),
    baseUrl: out.baseUrl ?? (process.env.OPENCURSOR_OPENCODE_SERVER_URL?.trim() || undefined),
  };
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(sanitize(value))}\n`, "utf8");
}

function sanitize(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length > 6_000) {
      return `${value.slice(0, 6_000)}...[truncated:${value.length}]`;
    }
    return value
      .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[redacted]")
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
  }
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: JsonObject = {};
  for (const [key, entry] of Object.entries(value as JsonObject)) {
    if (/token|secret|authorization|password|api[_-]?key|cookie/i.test(key)) {
      output[key] = "[redacted]";
    } else {
      output[key] = sanitize(entry);
    }
  }
  return output;
}

async function ensureProbeWorkspace(cwd: string): Promise<void> {
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify(
      {
        name: "opencode-server-probe",
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
    "Disposable workspace for OpenCode Server event schema capture.\n",
    "utf8"
  );
}

function scenarioNames(selected: string): string[] {
  if (selected === "all") {
    return Object.keys(SCENARIOS);
  }
  if (!SCENARIOS[selected]) {
    throw new Error(`Unknown scenario: ${selected}`);
  }
  return [selected];
}

async function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 4096;
      server.close(() => resolve(port));
    });
  });
}

async function resolveOpenCodeCommand(): Promise<string> {
  const configured =
    process.env.OPENCURSOR_OPENCODE_SERVER_BIN?.trim() ||
    process.env.OPENCURSOR_OPENCODE_ACP_BIN?.trim();
  if (configured) {
    return configured;
  }
  if (process.platform === "win32" && process.env.APPDATA?.trim()) {
    const npmShim = path.join(process.env.APPDATA, "npm", "opencode.cmd");
    try {
      await fs.access(npmShim);
      return npmShim;
    } catch {
      // Fall through to PATH resolution.
    }
  }
  return "opencode";
}

function authHeaders(): Record<string, string> {
  const password =
    process.env.OPENCURSOR_OPENCODE_SERVER_PASSWORD?.trim() ||
    process.env.OPENCODE_SERVER_PASSWORD?.trim();
  if (!password) {
    return {};
  }
  const username =
    process.env.OPENCURSOR_OPENCODE_SERVER_USERNAME?.trim() ||
    process.env.OPENCODE_SERVER_USERNAME?.trim() ||
    "opencode";
  return {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  };
}

async function waitForHealth(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/global/health`, {
        headers: authHeaders(),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`OpenCode server did not become healthy at ${baseUrl}`);
}

async function startServer(input: ProbeArgs): Promise<{
  baseUrl: string;
  child: ChildProcessWithoutNullStreams | null;
}> {
  if (input.baseUrl) {
    await waitForHealth(input.baseUrl);
    return { baseUrl: input.baseUrl.replace(/\/$/, ""), child: null };
  }
  const port = await pickPort();
  const command = await resolveOpenCodeCommand();
  const child = spawn(command, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: input.cwd,
    env: spawnSafeEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => {
    void appendJsonLine(input.out, { type: "server_stdout", text: String(chunk) });
  });
  child.stderr.on("data", (chunk) => {
    void appendJsonLine(input.out, { type: "server_stderr", text: String(chunk) });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  return { baseUrl, child };
}

async function requestJson<T>(
  baseUrl: string,
  route: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${route} failed ${response.status}: ${text.slice(0, 500)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

async function startSseCapture(input: {
  baseUrl: string;
  route: string;
  out: string;
  signal: AbortSignal;
}): Promise<void> {
  const response = await fetch(`${input.baseUrl}${input.route}`, {
    headers: {
      Accept: "text/event-stream",
      ...authHeaders(),
    },
    signal: input.signal,
  });
  if (!response.ok || !response.body) {
    await appendJsonLine(input.out, {
      type: "sse_failed",
      route: input.route,
      status: response.status,
      text: await response.text().catch(() => ""),
    });
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!input.signal.aborted) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.startsWith("data:")) {
          continue;
        }
        const data = line.slice(5).trim();
        if (!data) {
          continue;
        }
        let parsed: unknown = data;
        try {
          parsed = JSON.parse(data);
        } catch {
          // keep raw string
        }
        await appendJsonLine(input.out, { type: "sse", route: input.route, data: parsed });
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

function modelFromDiscovery(provider: unknown, fallback?: string): unknown {
  if (fallback) {
    const [providerID, modelID] = fallback.includes("/")
      ? fallback.split("/", 2)
      : ["", fallback];
    return providerID ? { providerID, modelID } : { modelID };
  }
  const record = provider && typeof provider === "object" ? (provider as JsonObject) : {};
  const defaults = record.default && typeof record.default === "object" ? (record.default as JsonObject) : {};
  const providerID = Object.keys(defaults)[0];
  const modelID = providerID ? defaults[providerID] : undefined;
  return typeof providerID === "string" && typeof modelID === "string"
    ? { providerID, modelID }
    : undefined;
}

async function runScenario(input: {
  baseUrl: string;
  out: string;
  sessionId: string;
  name: string;
  prompt: string;
  model: unknown;
  agent?: string;
}): Promise<void> {
  await appendJsonLine(input.out, { type: "scenario_start", name: input.name });
  if (input.name === "context") {
    const injected = await requestJson(input.baseUrl, `/session/${encodeURIComponent(input.sessionId)}/message`, {
      method: "POST",
      body: JSON.stringify({
        noReply: true,
        parts: [{ type: "text", text: "Context seed: the answer should mention opencode-server-probe." }],
      }),
    }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    await appendJsonLine(input.out, { type: "context_injection", injected });
  }
  const body: JsonObject = {
    parts: [{ type: "text", text: input.prompt }],
    ...(input.model ? { model: input.model } : {}),
    ...(input.agent ? { agent: input.agent } : {}),
  };
  const result = await requestJson(input.baseUrl, `/session/${encodeURIComponent(input.sessionId)}/message`, {
    method: "POST",
    body: JSON.stringify(body),
  }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  await appendJsonLine(input.out, { type: "scenario_result", name: input.name, result });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await ensureProbeWorkspace(args.cwd);
  await fs.rm(args.out, { force: true }).catch(() => undefined);
  const { baseUrl, child } = await startServer(args);
  const abort = new AbortController();
  try {
    await appendJsonLine(args.out, { type: "probe_start", baseUrl, cwd: args.cwd, repoRoot });
    void startSseCapture({ baseUrl, route: "/event", out: args.out, signal: abort.signal }).catch((error) =>
      appendJsonLine(args.out, { type: "sse_error", route: "/event", error: String(error) })
    );
    void startSseCapture({ baseUrl, route: "/global/event", out: args.out, signal: abort.signal }).catch((error) =>
      appendJsonLine(args.out, { type: "sse_error", route: "/global/event", error: String(error) })
    );
    const health = await requestJson(baseUrl, "/global/health");
    await appendJsonLine(args.out, { type: "health", health });
    const providers = await requestJson(baseUrl, "/config/providers").catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    await appendJsonLine(args.out, { type: "config_providers", providers });
    const provider = await requestJson(baseUrl, "/provider").catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    await appendJsonLine(args.out, { type: "provider", provider });
    const agents = await requestJson(baseUrl, "/agent").catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    await appendJsonLine(args.out, { type: "agents", agents });
    const session = await requestJson<{ id: string }>(baseUrl, "/session", {
      method: "POST",
      body: JSON.stringify({ title: `OpenCode Server probe ${Date.now()}` }),
    });
    await appendJsonLine(args.out, { type: "session_created", session });
    const model = modelFromDiscovery(provider, args.model);
    for (const name of scenarioNames(args.scenario)) {
      await runScenario({
        baseUrl,
        out: args.out,
        sessionId: session.id,
        name,
        prompt: SCENARIOS[name]!,
        model,
        agent: args.agent,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await appendJsonLine(args.out, { type: "probe_end", out: args.out });
  } finally {
    abort.abort();
    if (child) {
      child.kill();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
