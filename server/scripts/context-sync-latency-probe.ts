import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectChildSummary, ProjectSnapshot } from "@cesium/core/projects";
import { startFakeChatModel, text } from "../test/helpers/fake-chat-model.js";

/**
 * Measures how long a Project context write on one engine takes to show on
 * the other, both ways, between two real engines started from a checkout: a
 * home, and a peer ("build-box") holding a copy of the context for an idle
 * agent there. Home → peer writes go through the home's context API (what the
 * coordinator and the web UI use) and are timed until the peer's copy has
 * them. Peer → home writes are saved into the peer's copy the way an agent's
 * file tools do, and timed until the home's context API returns them. The
 * agent's model is a local fake: only the engines and their sync are real.
 *
 *   bun ./scripts/context-sync-latency-probe.ts --samples 10
 *   bun ./scripts/context-sync-latency-probe.ts --server-dir /tmp/main/server --jitter-ms 60000 --label before
 *
 * Options: --server-dir (the checkout whose engines run; default this one),
 * --runtime bun|node (default bun), --samples per direction (default 5),
 * --jitter-ms (random pause before each write, default 1500; ~60000 spreads
 * writes over a periodic sync's cycle), --timeout-ms per write (default
 * 120000), --label, --out (JSON summary; default tmp/context-sync-latency).
 */

type Args = {
  serverDir: string;
  runtime: "bun" | "node";
  samples: number;
  jitterMs: number;
  timeoutMs: number;
  label: string;
  out: string;
};

type Direction = "home → peer" | "peer → home";

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): Args {
  const args: Args = {
    serverDir: path.resolve(here, ".."),
    runtime: "bun",
    samples: 5,
    jitterMs: 1_500,
    timeoutMs: 120_000,
    label: "latency",
    out: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new Error(`${flag} needs a value`);
      }
      index += 1;
      return next;
    };
    if (flag === "--server-dir") args.serverDir = path.resolve(value());
    else if (flag === "--runtime") args.runtime = value() === "node" ? "node" : "bun";
    else if (flag === "--samples") args.samples = Math.max(1, Number.parseInt(value(), 10) || 5);
    else if (flag === "--jitter-ms") args.jitterMs = Math.max(0, Number.parseInt(value(), 10) || 0);
    else if (flag === "--timeout-ms") args.timeoutMs = Math.max(1_000, Number.parseInt(value(), 10) || 120_000);
    else if (flag === "--label") args.label = value();
    else if (flag === "--out") args.out = path.resolve(value());
    else throw new Error(`Unknown option ${flag}`);
  }
  args.out ||= path.resolve(here, "..", "tmp", "context-sync-latency", `${args.label}.json`);
  return args;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function until<T>(label: string, probe: () => Promise<T | null>, timeoutMs: number, everyMs = 250): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await probe().catch(() => null);
    if (value !== null) {
      return value;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await sleep(everyMs);
  }
}

type Engine = { label: string; url: string; dataDir: string; process: ChildProcess; output: string[] };

/** Env of this process without credentials or storage settings that would reach real services. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /_API_KEY$|^OPENAI_|^ANTHROPIC_|^CESIUM_|^OPENCURSOR_|^GITHUB_TOKEN$|^GH_TOKEN$|^REDIS_URL$|^DATABASE_URL$|^PORT$|^HOST$/.test(key)
    ) {
      delete env[key];
    }
  }
  return env;
}

async function startEngine(input: {
  label: string;
  args: Args;
  env: Record<string, string>;
  login?: { username: string; password: string };
}): Promise<Engine> {
  const port = await freePort();
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `cesium-latency-${input.label}-`)));
  const env: NodeJS.ProcessEnv = {
    ...cleanEnv(),
    ...input.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    OPENCURSOR_DATA_DIR: dataDir,
    WORKSPACE_ALLOWED_ROOTS: dataDir,
    CESIUM_PROJECTS_ENABLED: "1",
    CESIUM_ENGINE_LABEL: input.label,
    CESIUM_CHROMIUM_INSTALL: "skip",
    ...(input.login
      ? { OPENCURSOR_AUTH_USERNAME: input.login.username, OPENCURSOR_AUTH_PASSWORD: input.login.password }
      : {}),
  };
  const [command, commandArgs] =
    input.args.runtime === "bun"
      ? [process.env.BUN_BIN ?? (process.versions.bun ? process.execPath : "bun"), ["src/runtime/bun-server.ts"]]
      : ["node", ["--import", "tsx", "src/index.ts"]];
  const child = spawn(command, commandArgs, { cwd: input.args.serverDir, env, stdio: ["ignore", "pipe", "pipe"] });
  const output: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  const url = `http://127.0.0.1:${port}`;
  await until(
    `${input.label} to answer /health`,
    async () => {
      if (child.exitCode != null) {
        throw new Error(`${input.label} exited early:\n${output.join("").slice(-4000)}`);
      }
      const response = await fetch(`${url}/health`);
      return response.ok ? true : null;
    },
    90_000
  );
  return { label: input.label, url, dataDir, process: child, output };
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url}: HTTP ${response.status} ${body.slice(0, 500)}`);
  }
  return JSON.parse(body) as T;
}

function send(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function summarize(values: number[]): { samples: number; min: number; median: number; p90: number; max: number; mean: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
  return {
    samples: sorted.length,
    min: sorted[0]!,
    median: sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : Math.round((sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2),
    p90: at(0.9),
    max: sorted[sorted.length - 1]!,
    mean: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: args.serverDir, encoding: "utf8" }).trim();
  const log = (line: string) => console.log(`[${args.label}] ${line}`);
  log(`engines from ${args.serverDir} at ${commit} on ${args.runtime}; ${args.samples} writes each way, up to ${args.jitterMs} ms apart`);

  const model = await startFakeChatModel();
  model.script("scout", text(["Ready."]));
  const modelEnv = {
    CESIUM_BASE_URL: model.baseUrl,
    CESIUM_API_KEY: "sk-latency-probe",
    CESIUM_PROVIDER_ID: "projhost",
    CESIUM_DEFAULT_MODEL: "kimi-k3",
  };
  const login = { username: "peer-admin", password: "peer-password-for-latency" };
  const engines: Engine[] = [];
  try {
    const peer = await startEngine({ label: "build-box", args, env: modelEnv, login });
    engines.push(peer);
    const home = await startEngine({ label: "home", args, env: modelEnv });
    engines.push(home);

    const { token: session } = await json<{ token: string }>(`${peer.url}/api/auth/login`, send("POST", login));
    const minted = await json<{ token: { id: string }; secret: string }>(`${peer.url}/api/projects/peer-tokens`, {
      ...send("POST", { label: "home" }),
      headers: { "content-type": "application/json", "x-opencursor-session-token": session },
    });
    const { engine } = await json<{ engine: { id: string } }>(
      `${home.url}/api/projects/engines`,
      send("POST", { baseUrl: peer.url, token: minted.secret })
    );
    const project = await json<ProjectSnapshot>(
      `${home.url}/api/projects`,
      send("POST", { name: "Latency probe", modelId: "projhost/kimi-k3" })
    );
    await json(
      `${home.url}/api/projects/${project.id}/agents`,
      send("POST", { name: "scout", engine: engine.id, instructions: "Wait for instructions." })
    );
    await until(
      "the scout's first turn to be reported",
      async () => {
        const { agents } = await json<{ agents: ProjectChildSummary[] }>(`${home.url}/api/projects/${project.id}/agents`);
        return agents.find((agent) => agent.name === "scout" && agent.turnsCompleted >= 1) ?? null;
      },
      120_000
    );
    const mirror = path.join(peer.dataDir, "projects-mirror", minted.token.id, project.id, "context");
    await fs.access(path.join(mirror, "notes.md"));
    log(`Project ${project.id} with agent scout on build-box (engine ${engine.id}); peer copy at ${mirror}`);
    await sleep(3_000);

    const timings: Record<Direction, number[]> = { "home → peer": [], "peer → home": [] };
    const nonce = Date.now().toString(36);
    const measure = async (direction: Direction, index: number): Promise<void> => {
      await sleep(Math.round(Math.random() * args.jitterMs));
      const relative = direction === "home → peer" ? `docs/latency/home-${index}.md` : `internal/latency/peer-${index}.md`;
      const content = `${direction} #${index} ${nonce}\n`;
      const startedAt = Date.now();
      if (direction === "home → peer") {
        await json(`${home.url}/api/projects/${project.id}/context/file`, send("PUT", { path: relative, content }));
      } else {
        await fs.mkdir(path.dirname(path.join(mirror, relative)), { recursive: true });
        await fs.writeFile(path.join(mirror, relative), content);
      }
      const visible = async () =>
        direction === "home → peer"
          ? (await fs.readFile(path.join(mirror, relative), "utf8").catch(() => null)) === content
          : (await fetch(`${home.url}/api/projects/${project.id}/context/file?path=${encodeURIComponent(relative)}`)
              .then((response) => (response.ok ? (response.json() as Promise<{ content?: string }>) : null))
              .catch(() => null))?.content === content;
      while (!(await visible())) {
        if (Date.now() - startedAt > args.timeoutMs) {
          throw new Error(`${relative} (${direction}) was not visible after ${args.timeoutMs} ms`);
        }
        await sleep(20);
      }
      const ms = Date.now() - startedAt;
      timings[direction].push(ms);
      log(`${direction.padEnd(12)} #${String(index).padStart(2)}  ${String(ms).padStart(6)} ms  ${relative}`);
    };
    for (let index = 1; index <= args.samples; index += 1) {
      await measure("home → peer", index);
      await measure("peer → home", index);
    }

    const summary = {
      label: args.label,
      commit,
      runtime: args.runtime,
      jitterMs: args.jitterMs,
      measuredAt: new Date().toISOString(),
      "home → peer": { ...summarize(timings["home → peer"]), values: timings["home → peer"] },
      "peer → home": { ...summarize(timings["peer → home"]), values: timings["peer → home"] },
    };
    for (const direction of ["home → peer", "peer → home"] as const) {
      const stats = summary[direction];
      log(`${direction}: median ${stats.median} ms, p90 ${stats.p90} ms, min ${stats.min} ms, max ${stats.max} ms (${stats.samples} writes)`);
    }
    await fs.mkdir(path.dirname(args.out), { recursive: true });
    await fs.writeFile(args.out, `${JSON.stringify(summary, null, 2)}\n`);
    log(`summary: ${args.out}`);
  } finally {
    for (const engine of engines) {
      engine.process.kill("SIGTERM");
    }
    await Promise.all(
      engines.map((engine) =>
        engine.process.exitCode == null ? new Promise((resolve) => engine.process.once("exit", resolve)) : null
      )
    );
    await model.close();
    await Promise.all(engines.map((engine) => fs.rm(engine.dataDir, { recursive: true, force: true })));
  }
}

await main();
