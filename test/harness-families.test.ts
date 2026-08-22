import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyHarnessFamilyEnabled,
  applyHarnessFamilyTransport,
  composerVisibleHarnesses,
  HARNESS_FAMILIES,
  harnessFamilyForBackend,
  isHarnessFamilyEnabled,
  resolvePreferredHarnessBackendId,
} from "../packages/core/src/harness-families.ts";

test("Cursor and Codex families expose two transports with server/SDK defaults", () => {
  const cursor = harnessFamilyForBackend("cursor-acp");
  const codex = harnessFamilyForBackend("codex-acp");
  assert.equal(cursor?.id, "cursor");
  assert.equal(codex?.id, "codex");
  assert.equal(cursor?.transports.length, 2);
  assert.equal(codex?.transports.length, 2);
  assert.equal(resolvePreferredHarnessBackendId(cursor!), "cursor-sdk");
  assert.equal(resolvePreferredHarnessBackendId(codex!), "codex-app-server");
  assert.ok(HARNESS_FAMILIES.every((family) => family.transports.length >= 1));
});

test("family enable writes every sibling and transport preference selects ACP", () => {
  const cursor = harnessFamilyForBackend("cursor-sdk")!;
  const disabled = applyHarnessFamilyEnabled({}, cursor, false);
  assert.equal(disabled["cursor-sdk"], false);
  assert.equal(disabled["cursor-acp"], false);
  assert.equal(isHarnessFamilyEnabled(disabled, cursor), false);

  const switched = applyHarnessFamilyTransport(
    { enabledHarnesses: applyHarnessFamilyEnabled({}, cursor, true) },
    cursor,
    "acp"
  );
  assert.equal(switched.harnessTransports.cursor, "acp");
  assert.equal(switched.enabledHarnesses["cursor-acp"], true);
  assert.equal(resolvePreferredHarnessBackendId(cursor, switched), "cursor-acp");
});

test("composerVisibleHarnesses keeps one Codex row and prefers the app server", () => {
  const backends = [
    { id: "codex-app-server", label: "Codex App Server", enabled: true },
    { id: "codex-acp", label: "Codex ACP", enabled: true },
    { id: "cursor-sdk", label: "Cursor SDK", enabled: true },
    { id: "cursor-acp", label: "Cursor ACP", enabled: true },
  ];
  assert.deepEqual(
    composerVisibleHarnesses(backends).map((entry) => ({ id: entry.id, label: entry.label })),
    [
      { id: "cursor-sdk", label: "Cursor" },
      { id: "codex-app-server", label: "Codex" },
    ]
  );
  assert.deepEqual(
    composerVisibleHarnesses(backends, { harnessTransports: { codex: "acp" } }).map((entry) => ({
      id: entry.id,
      label: entry.label,
    })),
    [
      { id: "cursor-sdk", label: "Cursor" },
      { id: "codex-acp", label: "Codex" },
    ]
  );
});
