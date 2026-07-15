import "../src/env-bootstrap.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { getPiAgentAuthDir, applyPiRuntimeApiKeys } from "../src/lib/pi-agent-settings.js";

type ProbeArgs = {
  cwd: string;
  out: string;
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
    }
  }
  const cwd = out.cwd ?? path.join(os.tmpdir(), "cesium-pi-agent-probe");
  return {
    cwd,
    out: out.out ?? path.join(cwd, "pi-agent-probe-events.jsonl"),
  };
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function ensureProbeWorkspace(cwd: string): Promise<void> {
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(
    path.join(cwd, "README.md"),
    "# Pi Agent Probe\n\nDisposable workspace for Pi SDK smoke tests.\n",
    "utf8"
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await ensureProbeWorkspace(args.cwd);
  await fs.rm(args.out, { force: true }).catch(() => undefined);

  const authDir = getPiAgentAuthDir();
  await applyPiRuntimeApiKeys(AuthStorage.create(authDir));
  const authStorage = AuthStorage.create(authDir);
  const modelRegistry = ModelRegistry.create(authStorage);
  const available = await modelRegistry.getAvailable();
  if (available.length === 0) {
    throw new Error(
      "No Pi models available. Configure provider keys or OAuth in Settings -> Agents -> Pi Agent."
    );
  }

  await appendJsonLine(args.out, {
    type: "probe_start",
    cwd: args.cwd,
    models: available.map((model) => `${model.provider}/${model.id}`),
  });

  const { session } = await createAgentSession({
    cwd: args.cwd,
    authStorage,
    modelRegistry,
    model: available[0],
    tools: ["read", "grep", "bash"],
    sessionManager: SessionManager.inMemory(args.cwd),
  });

  session.subscribe((event) => {
    void appendJsonLine(args.out, { type: "event", event });
  });

  await session.prompt("List files in the current directory using read or bash.");
  await session.agent.waitForIdle();
  session.dispose();

  await appendJsonLine(args.out, { type: "probe_end", out: args.out });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
