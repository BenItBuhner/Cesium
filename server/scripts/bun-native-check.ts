import "../src/env-bootstrap.js";

type CheckResult = {
  name: string;
  ok: boolean;
  detail?: string;
};

async function check(name: string, run: () => Promise<string | undefined>): Promise<CheckResult> {
  try {
    const detail = await run();
    return { name, ok: true, ...(detail ? { detail } : {}) };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

const results = await Promise.all([
  check("bun-terminal-pty", async () => {
    const { getPtyBackendName, spawnPty } = await import("../src/lib/pty.js");
    if (getPtyBackendName() !== "bun-terminal") {
      return `backend=${getPtyBackendName()} (skipped live I/O)`;
    }
    const chunks: string[] = [];
    const marker = `__NATIVE_PTY_${Date.now()}__`;
    const expected = `OUT:${marker}`;
    const proc = spawnPty({
      file: process.env.SHELL || "/bin/bash",
      args: [],
      cols: 80,
      rows: 24,
      cwd: "/tmp",
      env: process.env,
    });
    proc.onData((data) => chunks.push(data));
    await new Promise((resolve) => setTimeout(resolve, 100));
    proc.write(`printf 'OUT:%s\\n' '${marker}'\n`);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !chunks.join("").includes(expected)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    proc.kill();
    if (!chunks.join("").includes(expected)) {
      throw new Error(`Bun.Terminal PTY produced no output for ${expected}`);
    }
    return "Bun.Terminal I/O ok";
  }),
  check("node-pty", async () => {
    const mod = await import("node-pty");
    const pty = mod.default ?? mod;
    return typeof pty.spawn === "function" ? "spawn available (Node fallback only)" : "spawn missing";
  }),
  check("@cursor/sdk", async () => {
    const mod = await import("@cursor/sdk");
    return typeof mod.Agent?.create === "function" ? "Agent.create available" : "Agent.create missing";
  }),
  check("sqlite3", async () => {
    const mod = await import("sqlite3");
    return typeof mod.default?.Database === "function" || typeof mod.Database === "function"
      ? "Database available"
      : "Database missing";
  }),
  check("postgres", async () => {
    const mod = await import("postgres");
    return typeof mod.default === "function" ? "factory available" : "factory missing";
  }),
  check("ioredis", async () => {
    const mod = await import("ioredis");
    return typeof mod.default === "function" || typeof mod.Redis === "function"
      ? "Redis constructor available"
      : "Redis constructor missing";
  }),
  check("playwright", async () => {
    const mod = await import("playwright");
    return typeof mod.chromium?.launch === "function" ? "chromium launcher available" : "launcher missing";
  }),
]);

console.log(JSON.stringify({ runtime: "bun", bunVersion: Bun.version, results }, null, 2));

if (results.some((result) => !result.ok)) {
  process.exitCode = 1;
}
