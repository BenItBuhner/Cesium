import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-harness-diag-"));
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;

const {
  createHarnessLogger,
  flushHarnessDiagnostics,
  harnessDiagnosticsFilePaths,
  harnessLog,
  readHarnessDiagnostics,
  resetHarnessDiagnosticsForTests,
} = await import("../src/lib/agents/harness-diagnostics.js");

test("harnessLog entries are readable with filters and limits", async () => {
  resetHarnessDiagnosticsForTests();
  const { current, rotated } = harnessDiagnosticsFilePaths();
  await fs.rm(current, { force: true });
  await fs.rm(rotated, { force: true });
  harnessLog({ event: "one", conversationId: "conv-a", backendId: "opencode-server" });
  harnessLog({ event: "two", conversationId: "conv-b", level: "debug" });
  harnessLog({ event: "three", conversationId: "conv-a", level: "error", detail: "boom" });
  harnessLog({ event: "four" });

  const all = await readHarnessDiagnostics();
  assert.equal(all.length, 4);
  assert.deepEqual(all.map((entry) => entry.event), ["one", "two", "three", "four"]);
  assert.ok(all.every((entry, index) => index === 0 || entry.seq > all[index - 1]!.seq));

  const convA = await readHarnessDiagnostics({ conversationId: "conv-a" });
  assert.deepEqual(convA.map((entry) => entry.event), ["one", "three"]);

  const errorsOnly = await readHarnessDiagnostics({ minLevel: "error" });
  assert.deepEqual(errorsOnly.map((entry) => entry.event), ["three"]);
  assert.equal(errorsOnly[0]?.detail, "boom");

  const limited = await readHarnessDiagnostics({ limit: 2 });
  assert.deepEqual(limited.map((entry) => entry.event), ["three", "four"]);

  const incremental = await readHarnessDiagnostics({ afterSeq: all[1]!.seq });
  assert.deepEqual(incremental.map((entry) => entry.event), ["three", "four"]);

  const byBackend = await readHarnessDiagnostics({ backendId: "opencode-server" });
  assert.deepEqual(byBackend.map((entry) => entry.event), ["one"]);
});

test("bound logger tags backend and conversation on every entry", async () => {
  resetHarnessDiagnosticsForTests();
  const log = createHarnessLogger({ backendId: "opencode-server", conversationId: "conv-x" });
  log.info("prompt.start", "starting");
  log.warning("sse.error", "stream hiccup", { consecutive: 1 });

  const entries = await readHarnessDiagnostics({ conversationId: "conv-x" });
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.backendId, "opencode-server");
  assert.equal(entries[1]?.level, "warning");
  assert.deepEqual(entries[1]?.data, { consecutive: 1 });
});

test("entries persist to JSONL and survive an in-memory reset (restart)", async () => {
  resetHarnessDiagnosticsForTests();
  harnessLog({ event: "persisted.a", conversationId: "conv-p" });
  harnessLog({ event: "persisted.b", conversationId: "conv-p", level: "warning" });
  await flushHarnessDiagnostics();

  const { current } = harnessDiagnosticsFilePaths();
  const raw = await fs.readFile(current, "utf8");
  assert.ok(raw.includes("persisted.a"));
  assert.ok(raw.includes("persisted.b"));

  // Simulate a server restart: ring buffer is empty, file backfills reads.
  resetHarnessDiagnosticsForTests();
  const entries = await readHarnessDiagnostics({ conversationId: "conv-p" });
  const events = entries.map((entry) => entry.event);
  assert.ok(events.includes("persisted.a"));
  assert.ok(events.includes("persisted.b"));
});

test("log file rotates once it exceeds the size cap", async () => {
  resetHarnessDiagnosticsForTests();
  const { current, rotated } = harnessDiagnosticsFilePaths();
  await fs.rm(current, { force: true });
  await fs.rm(rotated, { force: true });
  const previous = process.env.OPENCURSOR_HARNESS_LOG_MAX_BYTES;
  process.env.OPENCURSOR_HARNESS_LOG_MAX_BYTES = "5000";
  try {
    for (let batch = 0; batch < 8; batch += 1) {
      for (let i = 0; i < 20; i += 1) {
        harnessLog({
          event: `rotation.batch${batch}.${i}`,
          detail: "x".repeat(120),
        });
      }
      await flushHarnessDiagnostics();
    }
    const rotatedStat = await fs.stat(rotated).catch(() => null);
    assert.ok(rotatedStat, "expected a rotated harness log file to exist");
    const currentStat = await fs.stat(current);
    assert.ok(currentStat.size < 8 * 20 * 200, "current file should not hold every entry");
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCURSOR_HARNESS_LOG_MAX_BYTES;
    } else {
      process.env.OPENCURSOR_HARNESS_LOG_MAX_BYTES = previous;
    }
  }
});

test("oversized data payloads are truncated instead of dropped", async () => {
  resetHarnessDiagnosticsForTests();
  harnessLog({
    event: "big.payload",
    conversationId: "conv-trunc",
    data: { blob: "y".repeat(10_000) },
  });
  const entries = await readHarnessDiagnostics({ conversationId: "conv-trunc" });
  assert.equal(entries.length, 1);
  const data = entries[0]?.data as { truncated?: string } | undefined;
  assert.ok(data?.truncated, "expected payload to be replaced with truncated marker");
  assert.ok((data.truncated ?? "").length <= 4_000);
});
