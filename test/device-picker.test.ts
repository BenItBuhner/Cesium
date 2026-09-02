import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createDefaultDevicePickerState,
  devicePickerCodespaceEntryId,
  devicePickerSectionHiddenId,
  devicePickerServerEntryId,
  isDevicePickerEntryHidden,
  isDevicePickerSectionHidden,
  moveDevicePickerEntry,
  moveDevicePickerSection,
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
  test("entry ids are namespaced per kind", () => {
    assert.equal(devicePickerServerEntryId("x"), "server:x");
    assert.equal(devicePickerCodespaceEntryId("k"), "codespace:k");
    assert.equal(devicePickerSectionHiddenId("cloud"), "section:cloud");
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

  test("section hiding uses the section:* id", () => {
    const state = toggleDevicePickerHidden(
      createDefaultDevicePickerState(),
      devicePickerSectionHiddenId("codespaces")
    );
    assert.equal(isDevicePickerSectionHidden(state, "codespaces"), true);
    assert.equal(isDevicePickerSectionHidden(state, "cloud"), false);
  });

  test("moveDevicePickerEntry writes the full displayed order and round-trips through sort", () => {
    const base = createDefaultDevicePickerState();
    const moved = moveDevicePickerEntry(base, ids, "server:c", -1);
    assert.deepEqual(moved.order, ["server:a", "server:c", "server:b"]);
    const sorted = sortByDevicePickerOrder(servers, moved.order, (server) =>
      devicePickerServerEntryId(server.id)
    );
    assert.deepEqual(sorted.map((server) => server.id), ["a", "c", "b"]);
    const movedUpAgain = moveDevicePickerEntry(moved, ["server:a", "server:c", "server:b"], "server:c", -1);
    assert.deepEqual(movedUpAgain.order, ["server:c", "server:a", "server:b"]);
  });

  test("moveDevicePickerEntry preserves other sections' rankings", () => {
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

  test("moveDevicePickerSection reorders sections within bounds", () => {
    const base = createDefaultDevicePickerState();
    const moved = moveDevicePickerSection(base, "cloud", -1);
    assert.deepEqual(moved.sectionOrder, ["servers", "cloud", "codespaces"]);
    assert.equal(moveDevicePickerSection(base, "servers", -1), base);
    assert.equal(moveDevicePickerSection(base, "cloud", 1), base);
  });
});
