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
  check("node-pty", async () => {
    const mod = await import("node-pty");
    const pty = mod.default ?? mod;
    return typeof pty.spawn === "function" ? "spawn available" : "spawn missing";
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
