import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

/**
 * Harness auth sync engine pieces:
 * - snapshot export from vendor CLI credential files (allowlisted paths,
 *   binary/base64 handling, config files excluded, size caps)
 * - snapshot import (path allowlist enforcement, restrictive modes,
 *   payload validation)
 * - shared snapshot normalization from @cesium/core
 */

const TEST_HOME = path.join(
  os.tmpdir(),
  `cesium-harness-auth-sync-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);
const TEST_DATA_DIR = path.join(TEST_HOME, "data");

// The sync module scans OPENCURSOR_REAL_HOME first, so every read and write
// in this file stays inside the temp home.
process.env.OPENCURSOR_REAL_HOME = TEST_HOME;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
process.env.OPENCURSOR_HARNESS_DETECT_TTL_MS = "0";

const {
  exportHarnessAuthSnapshotForSync,
  importHarnessAuthSnapshotForSync,
  listHarnessAuthSyncStates,
} = await import("../src/lib/harness-auth-sync.js");
const { normalizeHarnessAuthSnapshot, HARNESS_AUTH_MAX_FILE_CHARS } = await import(
  "@cesium/core"
);

after(async () => {
  await fs.rm(TEST_HOME, { recursive: true, force: true });
});

async function writeHomeFile(relSegments: string[], content: string | Buffer) {
  const target = path.join(TEST_HOME, ...relSegments);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}

test("export captures codex auth.json but never config.toml", async () => {
  await writeHomeFile([".codex", "auth.json"], '{"id_token":"jwt-here"}');
  await writeHomeFile([".codex", "config.toml"], "model = 'gpt-5'\n");

  const snapshot = await exportHarnessAuthSnapshotForSync("codex");
  assert.ok(snapshot, "expected a codex snapshot");
  assert.equal(snapshot.kind, "cli-files");
  assert.equal(snapshot.syncId, "codex");
  const relPaths = (snapshot.files ?? []).map((file) => file.relPath);
  assert.deepEqual(relPaths, [".codex/auth.json"]);
  assert.equal(snapshot.files?.[0]?.content, '{"id_token":"jwt-here"}');
  assert.equal(snapshot.files?.[0]?.encoding, "utf8");
});

test("export returns null when no credentials exist", async () => {
  const snapshot = await exportHarnessAuthSnapshotForSync("devin");
  assert.equal(snapshot, null);
});

test("export base64-encodes binary credential files", async () => {
  const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x42]);
  await writeHomeFile([".grok", "auth.json"], binary);
  const snapshot = await exportHarnessAuthSnapshotForSync("grok");
  assert.ok(snapshot);
  assert.equal(snapshot.files?.[0]?.encoding, "base64");
  assert.equal(
    Buffer.from(snapshot.files?.[0]?.content ?? "", "base64").equals(binary),
    true
  );
});

test("export skips oversized credential files", async () => {
  await writeHomeFile(
    [".local", "share", "opencode", "auth.json"],
    "x".repeat(HARNESS_AUTH_MAX_FILE_CHARS + 1)
  );
  const snapshot = await exportHarnessAuthSnapshotForSync("opencode");
  assert.equal(snapshot, null);
});

test("import writes allowlisted files with restrictive modes", async () => {
  const result = await importHarnessAuthSnapshotForSync("claude", {
    version: 1,
    syncId: "claude",
    kind: "cli-files",
    files: [
      {
        relPath: ".claude/.credentials.json",
        content: '{"token":"synced"}',
        encoding: "utf8",
      },
    ],
    capturedAt: Date.now(),
  });
  assert.equal(result.applied, 1);
  assert.deepEqual(result.errors, []);

  const target = path.join(TEST_HOME, ".claude", ".credentials.json");
  assert.equal(await fs.readFile(target, "utf8"), '{"token":"synced"}');
  if (process.platform !== "win32") {
    const fileMode = (await fs.stat(target)).mode & 0o777;
    assert.equal(fileMode, 0o600);
  }
});

test("import rejects non-allowlisted paths outright", async () => {
  await assert.rejects(
    importHarnessAuthSnapshotForSync("codex", {
      version: 1,
      syncId: "codex",
      kind: "cli-files",
      files: [
        { relPath: ".ssh/authorized_keys", content: "ssh-ed25519 pwned", encoding: "utf8" },
      ],
      capturedAt: Date.now(),
    }),
    /allowlisted/i
  );
  // And the config allowlist exclusion also applies to imports.
  await assert.rejects(
    importHarnessAuthSnapshotForSync("codex", {
      version: 1,
      syncId: "codex",
      kind: "cli-files",
      files: [
        { relPath: ".codex/config.toml", content: "model = 'evil'", encoding: "utf8" },
      ],
      capturedAt: Date.now(),
    }),
    /allowlisted/i
  );
});

test("import rejects malformed and mismatched snapshots", async () => {
  await assert.rejects(
    importHarnessAuthSnapshotForSync("codex", { version: 2 }),
    /invalid/i
  );
  await assert.rejects(
    // syncId mismatch between route param and payload.
    importHarnessAuthSnapshotForSync("codex", {
      version: 1,
      syncId: "claude",
      kind: "cli-files",
      files: [
        { relPath: ".claude/auth.json", content: "{}", encoding: "utf8" },
      ],
      capturedAt: Date.now(),
    }),
    /invalid/i
  );
});

test("roundtrip: exported snapshot imports cleanly on a fresh home", async () => {
  await writeHomeFile([".cursor", "cli-config.json"], '{"accessToken":"cursor-tok"}');
  const snapshot = await exportHarnessAuthSnapshotForSync("cursor");
  assert.ok(snapshot);

  // Wipe and re-import as if this were another machine.
  await fs.rm(path.join(TEST_HOME, ".cursor"), { recursive: true, force: true });
  const result = await importHarnessAuthSnapshotForSync("cursor", snapshot);
  assert.equal(result.applied, 1);
  assert.equal(
    await fs.readFile(path.join(TEST_HOME, ".cursor", "cli-config.json"), "utf8"),
    '{"accessToken":"cursor-tok"}'
  );
});

test("sync states cover every sync id and report sign-in presence", async () => {
  const states = await listHarnessAuthSyncStates();
  const bySyncId = new Map(states.map((state) => [state.syncId, state]));
  assert.equal(bySyncId.size, 8);
  assert.ok(bySyncId.has("google-antigravity-acp"), "official ACP server has its own sync unit");
  assert.ok(!bySyncId.has("google-antigravity"), "retired agy CLI sync unit is gone");
  assert.equal(bySyncId.get("codex")?.signedIn, true);
  assert.equal(bySyncId.get("codex")?.exportable, true);
  assert.equal(bySyncId.get("devin")?.signedIn, false);
  // Cesium Agent always reports installed (it is built in).
  assert.equal(bySyncId.get("cesium-agent")?.installed, true);
});

test("normalizeHarnessAuthSnapshot enforces traversal and size rules", () => {
  const base = {
    version: 1,
    syncId: "codex",
    kind: "cli-files",
    capturedAt: 1,
  };
  assert.equal(
    normalizeHarnessAuthSnapshot({
      ...base,
      files: [{ relPath: "../escape.json", content: "{}", encoding: "utf8" }],
    }),
    null
  );
  assert.equal(
    normalizeHarnessAuthSnapshot({
      ...base,
      files: [{ relPath: "/etc/passwd", content: "{}", encoding: "utf8" }],
    }),
    null
  );
  assert.equal(
    normalizeHarnessAuthSnapshot({
      ...base,
      files: [
        {
          relPath: ".codex/auth.json",
          content: "x".repeat(HARNESS_AUTH_MAX_FILE_CHARS + 1),
          encoding: "utf8",
        },
      ],
    }),
    null
  );
  // provider-keys is only valid for cesium-agent.
  assert.equal(
    normalizeHarnessAuthSnapshot({
      version: 1,
      syncId: "codex",
      kind: "provider-keys",
      providerKeysJson: "[]",
      capturedAt: 1,
    }),
    null
  );
  const valid = normalizeHarnessAuthSnapshot({
    ...base,
    files: [{ relPath: ".codex/auth.json", content: "{}", encoding: "utf8" }],
    sourceLabel: "  host-a  ",
  });
  assert.ok(valid);
  assert.equal(valid.sourceLabel, "host-a");
});
