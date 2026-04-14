/**
 * Temporary ACP traffic logger: spawns opencode/agent in ACP mode, logs every JSON-RPC line.
 * Usage: bun run scripts/acp-stream-capture.ts [opencode|cursor] [workspaceDir] [logPath]
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import * as readline from "node:readline";

function resolveRealHome(): string {
  const candidates = [
    process.env.OPENCURSOR_REAL_HOME,
    process.env.USER && `/home/${process.env.USER}`,
    "/home/bennett",
    os.homedir(),
  ].filter(Boolean) as string[];
  for (const h of candidates) {
    if (fs.existsSync(`${h}/.opencode/bin/opencode`)) {
      return h;
    }
  }
  for (const h of candidates) {
    if (fs.existsSync(`${h}/.local/bin/agent`)) {
      return h;
    }
  }
  return os.homedir();
}

const homedir = resolveRealHome();

const backend = (process.argv[2] || "opencode").toLowerCase();
const workspace = process.argv[3] || process.cwd();
const logPath =
  process.argv[4] || `/tmp/acp-dump-${backend}-${Date.now()}.jsonl`;

const runtimes: Record<string, { command: string; args: string[] }> = {
  opencode: {
    command:
      process.env.OPENCURSOR_OPENCODE_ACP_BIN ||
      `${homedir}/.opencode/bin/opencode`,
    args: ["acp"],
  },
  cursor: {
    command:
      process.env.OPENCURSOR_CURSOR_CLI_BIN ||
      `${homedir}/.local/bin/agent`,
    args: (() => {
      const extra = process.env.OPENCURSOR_CURSOR_AGENT_ARGS?.trim();
      if (extra) {
        try {
          const a = JSON.parse(extra) as unknown;
          if (Array.isArray(a) && a.every((x) => typeof x === "string")) {
            return [...a, "acp"];
          }
        } catch {
          /* ignore */
        }
      }
      return ["acp"];
    })(),
  },
};

const spec = runtimes[backend];
if (!spec) {
  console.error("backend must be opencode or cursor");
  process.exit(1);
}

function log(obj: unknown) {
  fs.appendFileSync(logPath, `${JSON.stringify(obj)}\n`);
}

const proc = spawn(spec.command, spec.args, {
  cwd: workspace,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

let nextId = 1;
const pending = new Map<number, (err: Error | null, result?: unknown) => void>();

function send(method: string, params?: unknown): Promise<unknown> {
  const id = nextId++;
  const payload = { jsonrpc: "2.0", id, method, params };
  log({ dir: "out", payload });
  proc.stdin.write(`${JSON.stringify(payload)}\n`);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, 180_000);
    pending.set(id, (err, result) => {
      clearTimeout(t);
      if (err) reject(err);
      else resolve(result);
    });
  });
}

const rl = readline.createInterface({ input: proc.stdout });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    log({ dir: "in", raw: trimmed, parseError: true });
    return;
  }
  log({ dir: "in", msg });

  if ("id" in msg && msg.id != null && "result" in msg) {
    const id = Number(msg.id);
    const cb = pending.get(id);
    if (cb) {
      pending.delete(id);
      cb(null, msg.result);
    }
    return;
  }

  if ("id" in msg && msg.id != null && "error" in msg) {
    const id = Number(msg.id);
    const cb = pending.get(id);
    if (cb) {
      pending.delete(id);
      const e = msg.error as { message?: string };
      cb(new Error(e?.message || "rpc error"));
    }
    return;
  }

  if ("method" in msg && "id" in msg && !("result" in msg)) {
    const id = msg.id as number | string;
    const method = String(msg.method);
    const params = msg.params;
    log({ dir: "server_request", method, id, params });
    if (method === "session/request_permission") {
      const rec = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
      const opts = (Array.isArray(rec.options) ? rec.options : []) as { id?: string }[];
      const first = opts[0]?.id;
      proc.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { outcome: { outcome: "selected", optionId: first ?? "allow" } },
        })}\n`
      );
    } else {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: {} })}\n`);
    }
  }
});

readline.createInterface({ input: proc.stderr }).on("line", (line) => {
  log({ dir: "stderr", line });
});

proc.on("exit", (code) => {
  log({ dir: "exit", code });
});

async function main() {
  fs.writeFileSync(logPath, "");
  console.error(`Logging ACP (${backend}) to ${logPath}`);

  const init = await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: "acp-capture", title: "capture", version: "0.0.1" },
  });
  log({ phase: "initialized", init });

  const opened = (await send("session/new", {
    cwd: workspace,
    mcpServers: [],
  })) as Record<string, unknown>;
  const sessionId = opened.sessionId as string;
  log({ phase: "session", sessionId });

  const msgId = crypto.randomUUID();
  await send("session/prompt", {
    sessionId,
    messageId: msgId,
    prompt: [
      {
        type: "text",
        text: 'Read exactly these files and reply with one word "done": package.json, README.md, src/lib/agent-chat.ts — use the project read tool only.',
      },
    ],
  });
  log({ phase: "prompt_sent" });

  await new Promise((r) => setTimeout(r, 45_000));
  proc.kill();
}

main().catch((e) => {
  console.error(e);
  proc.kill();
  process.exit(1);
});
