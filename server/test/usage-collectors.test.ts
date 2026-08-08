import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * Cross-harness usage collectors (Settings → Usage): each collector reads the
 * session artifacts a coding-agent CLI leaves on disk and reduces them into a
 * normalized ProviderUsageReport. Fixtures here are synthetic but mirror the
 * real captured artifacts under ./fixtures/harness-home (Claude Code 2.1,
 * Codex 0.146, OpenCode 1.18, Pi 0.73, Gemini CLI).
 */

const HOME = path.join(
  os.tmpdir(),
  `cesium-usage-tests-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;

process.env.OPENCURSOR_DATA_DIR = path.join(HOME, "cesium-data");
process.env.CODEX_HOME = path.join(HOME, ".codex");
process.env.CLAUDE_CONFIG_DIR = path.join(HOME, ".claude");
process.env.GEMINI_CLI_HOME = path.join(HOME, ".gemini");
process.env.XDG_DATA_HOME = path.join(HOME, ".local", "share");
process.env.PI_CODING_AGENT_DIR = path.join(HOME, ".pi", "agent");

const [
  { collectCodexUsage },
  { collectClaudeCodeUsage },
  { collectGeminiUsage },
  { collectOpenCodeUsage },
  { collectPiUsage },
  { getUsageOverview },
] = await Promise.all([
  import("../src/lib/usage/codex.js"),
  import("../src/lib/usage/claude-code.js"),
  import("../src/lib/usage/gemini.js"),
  import("../src/lib/usage/opencode.js"),
  import("../src/lib/usage/pi.js"),
  import("../src/lib/usage/index.js"),
]);

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SINCE_30D = NOW - 30 * DAY;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

async function writeLines(file: string, lines: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

/* -------------------------------- Codex -------------------------------- */

test("codex collector aggregates token_count deltas, rate limits, and plan", async () => {
  const sessionsDir = path.join(HOME, ".codex", "sessions", "2026", "08");
  const tokenCount = (
    ts: number,
    last: { input: number; cached?: number; output: number; reasoning?: number },
    total: { input: number; cached?: number; output: number; reasoning?: number },
    rateLimits?: unknown
  ) => ({
    timestamp: iso(ts),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: total.input,
          cached_input_tokens: total.cached ?? 0,
          cache_write_input_tokens: 0,
          output_tokens: total.output,
          reasoning_output_tokens: total.reasoning ?? 0,
          total_tokens: total.input + total.output,
        },
        last_token_usage: {
          input_tokens: last.input,
          cached_input_tokens: last.cached ?? 0,
          cache_write_input_tokens: 0,
          output_tokens: last.output,
          reasoning_output_tokens: last.reasoning ?? 0,
          total_tokens: last.input + last.output,
        },
        model_context_window: 258400,
      },
      rate_limits: rateLimits ?? null,
    },
  });

  await writeLines(path.join(sessionsDir, "rollout-recent-aaaa.jsonl"), [
    {
      timestamp: iso(NOW - 2 * HOUR),
      type: "session_meta",
      payload: { id: "aaaa", cwd: "/tmp/x", timestamp: iso(NOW - 2 * HOUR) },
    },
    {
      timestamp: iso(NOW - 2 * HOUR),
      type: "turn_context",
      payload: { model: "gpt-5.3-codex" },
    },
    tokenCount(
      NOW - 2 * HOUR,
      { input: 1000, cached: 200, output: 50, reasoning: 10 },
      { input: 1000, cached: 200, output: 50, reasoning: 10 }
    ),
    tokenCount(
      NOW - 1 * HOUR,
      { input: 500, cached: 100, output: 25 },
      { input: 1500, cached: 300, output: 75, reasoning: 10 },
      {
        limit_id: "codex",
        plan_type: "plus",
        primary: { used_percent: 42.5, window_minutes: 300, resets_in_seconds: 3600 },
        secondary: { used_percent: 91.2, window_minutes: 10080, resets_in_seconds: 86400 },
      }
    ),
  ]);
  // A stale rollout outside the lookback window must be ignored even though
  // its file mtime is fresh.
  await writeLines(path.join(sessionsDir, "rollout-old-bbbb.jsonl"), [
    {
      timestamp: iso(NOW - 45 * DAY),
      type: "turn_context",
      payload: { model: "gpt-5.3-codex" },
    },
    tokenCount(
      NOW - 45 * DAY,
      { input: 999999, output: 999999 },
      { input: 999999, output: 999999 }
    ),
  ]);

  const report = await collectCodexUsage(SINCE_30D);
  assert.equal(report.available, true);
  assert.equal(report.plan, "Plus");
  assert.equal(report.totals.requests, 2);
  // input excludes cached: (1000-200) + (500-100)
  assert.equal(report.totals.inputTokens, 1200);
  assert.equal(report.totals.cacheReadTokens, 300);
  assert.equal(report.totals.outputTokens, 75);
  assert.equal(report.totals.reasoningTokens, 10);
  assert.equal(report.totals.totalTokens, 1050 + 525);
  assert.equal(report.totals.sessions, 1);
  assert.equal(report.models.length, 1);
  assert.equal(report.models[0]!.model, "gpt-5.3-codex");

  assert.equal(report.limitWindows.length, 2);
  const primary = report.limitWindows.find((w) => w.id === "primary")!;
  assert.equal(primary.usedPercent, 42.5);
  assert.equal(primary.label, "5h window");
  assert.ok(primary.resetsAt);
  const secondary = report.limitWindows.find((w) => w.id === "secondary")!;
  assert.equal(secondary.usedPercent, 91.2);
  assert.equal(secondary.label, "Weekly window");
});

/* ----------------------------- Claude Code ----------------------------- */

test("claude collector dedupes requests and reports the 5h session block", async () => {
  const projectDir = path.join(HOME, ".claude", "projects", "-tmp-demo");
  const assistantEntry = (
    ts: number,
    messageId: string,
    requestId: string,
    usage: Record<string, number>
  ) => ({
    type: "assistant",
    timestamp: iso(ts),
    sessionId: "sess-1",
    requestId,
    message: { id: messageId, role: "assistant", model: "claude-opus-4-6", usage },
  });

  await writeLines(path.join(projectDir, "sess-1.jsonl"), [
    assistantEntry(NOW - 30 * 60_000, "msg_1", "req_1", {
      input_tokens: 100,
      output_tokens: 40,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 2000,
    }),
    assistantEntry(NOW - 20 * 60_000, "msg_2", "req_2", {
      input_tokens: 60,
      output_tokens: 30,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 2500,
    }),
    // Synthetic local stand-in must never count.
    {
      type: "assistant",
      timestamp: iso(NOW - 10 * 60_000),
      message: { role: "assistant", model: "<synthetic>", usage: { input_tokens: 1 } },
    },
  ]);
  // Re-homed copy of the same session: identical request must dedupe away.
  await writeLines(
    path.join(HOME, ".claude", "projects", "-workspace", "sess-1.jsonl"),
    [
      assistantEntry(NOW - 30 * 60_000, "msg_1", "req_1", {
        input_tokens: 100,
        output_tokens: 40,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 2000,
      }),
    ]
  );

  const report = await collectClaudeCodeUsage(SINCE_30D, NOW);
  assert.equal(report.available, true);
  assert.equal(report.totals.requests, 2);
  assert.equal(report.totals.inputTokens, 160);
  assert.equal(report.totals.outputTokens, 70);
  assert.equal(report.totals.cacheWriteTokens, 500);
  assert.equal(report.totals.cacheReadTokens, 4500);
  assert.equal(report.totals.sessions, 1);
  assert.equal(report.models[0]!.model, "claude-opus-4-6");

  assert.equal(report.limitWindows.length, 1);
  const block = report.limitWindows[0]!;
  assert.equal(block.usedPercent, null);
  assert.ok(block.resetsAt && Date.parse(block.resetsAt) > NOW);
  assert.match(block.detail ?? "", /2 requests/);
});

/* -------------------------------- Gemini -------------------------------- */

test("gemini collector uses recorded tokens and falls back to estimation", async () => {
  const chatsDir = path.join(HOME, ".gemini", "tmp", "hash1", "chats");
  await writeLines(path.join(chatsDir, "session-recent-abcd1234.jsonl"), [
    {
      sessionId: "abcd1234-0000",
      projectHash: "hash1",
      startTime: iso(NOW - HOUR),
      lastUpdated: iso(NOW - HOUR + 60_000),
    },
    {
      id: "m1",
      timestamp: iso(NOW - HOUR),
      type: "user",
      content: [{ text: "hello" }],
    },
    {
      id: "m2",
      timestamp: iso(NOW - HOUR + 30_000),
      type: "gemini",
      model: "gemini-3-pro",
      content: "x".repeat(400),
    },
    {
      id: "m3",
      timestamp: iso(NOW - HOUR + 60_000),
      type: "gemini",
      model: "gemini-3-pro",
      content: "with tokens",
      tokens: { input: 1200, output: 80, cached: 300, thoughts: 40, tool: 10, total: 1630 },
    },
  ]);

  const report = await collectGeminiUsage(SINCE_30D);
  assert.equal(report.available, true);
  assert.equal(report.estimated, true);
  assert.equal(report.totals.requests, 2);
  // 400 chars / 4 = 100 estimated + 1630 recorded
  assert.equal(report.totals.totalTokens, 100 + 1630);
  assert.equal(report.totals.inputTokens, 1200);
  assert.equal(report.totals.reasoningTokens, 40);
  assert.equal(report.models[0]!.model, "gemini-3-pro");
});

/* ------------------------------- OpenCode ------------------------------- */

test("opencode collector reads legacy storage with cost", async () => {
  const messageDir = path.join(
    HOME,
    ".local",
    "share",
    "opencode",
    "storage",
    "message",
    "ses_demo"
  );
  await fs.mkdir(messageDir, { recursive: true });
  await fs.writeFile(
    path.join(messageDir, "msg_user.json"),
    JSON.stringify({
      id: "msg_user",
      sessionID: "ses_demo",
      role: "user",
      time: { created: NOW - HOUR },
    })
  );
  await fs.writeFile(
    path.join(messageDir, "msg_asst.json"),
    JSON.stringify({
      id: "msg_asst",
      sessionID: "ses_demo",
      role: "assistant",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6",
      cost: 0.42,
      tokens: { total: 7050, input: 5196, output: 11, reasoning: 0, cache: { write: 0, read: 1843 } },
      time: { created: NOW - HOUR, completed: NOW - HOUR + 5000 },
    })
  );

  const report = await collectOpenCodeUsage(SINCE_30D);
  assert.equal(report.available, true);
  assert.equal(report.totals.requests, 1);
  assert.equal(report.totals.totalTokens, 7050);
  assert.equal(report.totals.cacheReadTokens, 1843);
  assert.equal(report.totals.costUsd, 0.42);
  assert.equal(report.models[0]!.model, "anthropic/claude-sonnet-4-6");
  assert.equal(report.totals.sessions, 1);
});

/* ---------------------------------- Pi ---------------------------------- */

test("pi collector reads assistant usage with model and cost", async () => {
  const sessionDir = path.join(HOME, ".pi", "agent", "sessions", "--tmp-demo--");
  await writeLines(path.join(sessionDir, `${iso(NOW - HOUR)}_pi-session-1.jsonl`), [
    { type: "session", id: "pi-session-1", timestamp: iso(NOW - HOUR), cwd: "/tmp/demo" },
    { type: "model_change", timestamp: iso(NOW - HOUR), provider: "techlit", modelId: "kimi-k3" },
    {
      type: "message",
      timestamp: iso(NOW - HOUR + 10_000),
      message: {
        role: "assistant",
        model: "kimi-k3",
        content: [{ type: "text", text: "hello" }],
        usage: {
          input: 1344,
          output: 24,
          cacheRead: 128,
          cacheWrite: 0,
          totalTokens: 1496,
          cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
        },
      },
    },
  ]);

  const report = await collectPiUsage(SINCE_30D);
  assert.equal(report.available, true);
  assert.equal(report.estimated, false);
  assert.equal(report.totals.requests, 1);
  assert.equal(report.totals.inputTokens, 1344);
  assert.equal(report.totals.outputTokens, 24);
  assert.equal(report.totals.cacheReadTokens, 128);
  assert.equal(report.totals.costUsd, 0.03);
  assert.equal(report.models[0]!.model, "kimi-k3");
});

/* ------------------------------- Overview ------------------------------- */

test("overview merges collectors and lists cloud-only providers", async () => {
  const overview = await getUsageOverview({ days: 30, refresh: true });
  assert.equal(overview.lookbackDays, 30);
  const ids = overview.providers.map((provider) => provider.id);
  for (const id of [
    "codex",
    "claude-code",
    "gemini",
    "opencode",
    "pi",
    "cesium-agent",
    "cursor-sdk",
    "devin",
    "grok-build",
  ]) {
    assert.ok(ids.includes(id), `missing provider ${id}`);
  }
  const cursor = overview.providers.find((provider) => provider.id === "cursor-sdk")!;
  assert.equal(cursor.available, false);
  assert.ok(cursor.reason);
  const codex = overview.providers.find((provider) => provider.id === "codex")!;
  assert.equal(codex.available, true);
  assert.ok(codex.totals.totalTokens > 0);
});

test("collectors report unavailable when harness dirs do not exist", async () => {
  const originalCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(HOME, "does-not-exist");
  try {
    const report = await collectCodexUsage(SINCE_30D);
    assert.equal(report.available, false);
    assert.match(report.reason ?? "", /No Codex sessions/);
  } finally {
    process.env.CODEX_HOME = originalCodexHome;
  }
});
