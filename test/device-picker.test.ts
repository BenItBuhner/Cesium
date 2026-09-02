import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createDefaultDevicePickerState,
  devicePickerKindHiddenId,
  devicePickerServerEntryId,
  isDevicePickerEntryHidden,
  isDevicePickerKindHidden,
  moveDevicePickerEntry,
  sortByDevicePickerOrder,
  toggleDevicePickerHidden,
} from "../src/lib/global-settings.ts";

const servers = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta" },
  { id: "c", label: "Gamma" },
];
const ids = servers.map((server) => devicePickerServerEntryId(server.id));

describe("device picker customization", () => {
  test("ids are namespaced per kind", () => {
    assert.equal(devicePickerServerEntryId("x"), "server:x");
    assert.equal(devicePickerKindHiddenId("codespace"), "kind:codespace");
    assert.equal(devicePickerKindHiddenId("cloud"), "kind:cloud");
  });

  test("sortByDevicePickerOrder keeps natural order when nothing is ranked", () => {
    const sorted = sortByDevicePickerOrder(servers, [], (server) =>
      devicePickerServerEntryId(server.id)
    );
    assert.deepEqual(sorted.map((server) => server.id), ["a", "b", "c"]);
    assert.notEqual(sorted, servers);
  });

  test("ranked entries come first in rank order; unranked keep incoming order", () => {
    const sorted = sortByDevicePickerOrder(
      servers,
      ["server:c", "unknown:z", "server:a"],
      (server) => devicePickerServerEntryId(server.id)
    );
    assert.deepEqual(sorted.map((server) => server.id), ["c", "a", "b"]);
  });

  test("a single ranking interleaves servers, codespaces, and cloud devices", () => {
    const mixed = [
      { id: "server:a" },
      { id: "server:b" },
      { id: "codespace:owner/repo" },
      { id: "cloud:cursor-sdk" },
    ];
    const sorted = sortByDevicePickerOrder(
      mixed,
      ["codespace:owner/repo", "server:b"],
      (item) => item.id
    );
    assert.deepEqual(
      sorted.map((item) => item.id),
      ["codespace:owner/repo", "server:b", "server:a", "cloud:cursor-sdk"]
    );
  });

  test("toggleDevicePickerHidden flips and is idempotent for explicit values", () => {
    const base = createDefaultDevicePickerState();
    const hidden = toggleDevicePickerHidden(base, "server:a");
    assert.deepEqual(hidden.hidden, ["server:a"]);
    assert.equal(isDevicePickerEntryHidden(hidden, "server:a"), true);
    assert.equal(toggleDevicePickerHidden(hidden, "server:a", true), hidden);
    const shown = toggleDevicePickerHidden(hidden, "server:a", false);
    assert.deepEqual(shown.hidden, []);
    assert.equal(toggleDevicePickerHidden(base, "server:a", false), base);
  });

  test("kind hiding uses the kind:* id", () => {
    const state = toggleDevicePickerHidden(
      createDefaultDevicePickerState(),
      devicePickerKindHiddenId("codespace")
    );
    assert.equal(isDevicePickerKindHidden(state, "codespace"), true);
    assert.equal(isDevicePickerKindHidden(state, "cloud"), false);
  });

  test("moveDevicePickerEntry writes the full displayed order and round-trips through sort", () => {
    const base = createDefaultDevicePickerState();
    const moved = moveDevicePickerEntry(base, ids, "server:c", -1);
    assert.deepEqual(moved.order, ["server:a", "server:c", "server:b"]);
    const sorted = sortByDevicePickerOrder(servers, moved.order, (server) =>
      devicePickerServerEntryId(server.id)
    );
    assert.deepEqual(sorted.map((server) => server.id), ["a", "c", "b"]);
    const movedUpAgain = moveDevicePickerEntry(
      moved,
      ["server:a", "server:c", "server:b"],
      "server:c",
      -1
    );
    assert.deepEqual(movedUpAgain.order, ["server:c", "server:a", "server:b"]);
  });

  test("moveDevicePickerEntry keeps ranked ids that are not currently displayed", () => {
    const base = {
      ...createDefaultDevicePickerState(),
      order: ["cloud:cursor-sdk", "codespace:k1"],
    };
    const moved = moveDevicePickerEntry(base, ids, "server:b", 1);
    assert.deepEqual(moved.order, [
      "server:a",
      "server:c",
      "server:b",
      "cloud:cursor-sdk",
      "codespace:k1",
    ]);
  });

  test("moveDevicePickerEntry is a no-op at the edges or for unknown ids", () => {
    const base = createDefaultDevicePickerState();
    assert.equal(moveDevicePickerEntry(base, ids, "server:a", -1), base);
    assert.equal(moveDevicePickerEntry(base, ids, "server:c", 1), base);
    assert.equal(moveDevicePickerEntry(base, ids, "server:zzz", 1), base);
  });
});
