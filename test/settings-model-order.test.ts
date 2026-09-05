import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  appendEnabledModelIds,
  applyEnabledCompactOrder,
  applyIdOrder,
  compactModelRowsForBackend,
  moveItem,
} from "../src/lib/settings-model-order.ts";
import { mergeCatalogPreservingOrder } from "../server/src/lib/model-toggle-order.ts";

describe("settings model order", () => {
  test("compacts variants without alphabetizing first-seen order", () => {
    const rows = compactModelRowsForBackend([
      { id: "zeta", name: "Zeta", on: true },
      { id: "alpha [high]", name: "Alpha High", on: true },
      { id: "alpha [low]", name: "Alpha Low", on: false },
    ]);
    assert.deepEqual(
      rows.map((row) => row.name),
      ["Zeta", "Alpha"]
    );
    assert.equal(rows[1]?.on, true);
    assert.deepEqual(rows[1]?.modelIds, ["alpha [high]", "alpha [low]"]);
  });

  test("reordering enabled compact rows keeps disabled models after them", () => {
    const models = [
      { id: "a", name: "A", on: true },
      { id: "b", name: "B", on: false },
      { id: "c", name: "C", on: true },
    ];
    const enabled = compactModelRowsForBackend(models).filter((row) => row.on);
    const nextEnabled = moveItem(enabled, 0, 1);
    const next = applyEnabledCompactOrder(models, nextEnabled);
    assert.deepEqual(
      next.map((model) => model.id),
      ["c", "a", "b"]
    );
  });

  test("newly enabled models append after the last already-enabled entry", () => {
    const next = appendEnabledModelIds(
      [
        { id: "a", name: "A", on: true },
        { id: "b", name: "B", on: false },
        { id: "c", name: "C", on: false },
      ],
      ["c"]
    );
    assert.deepEqual(
      next.map((model) => `${model.id}:${model.on}`),
      ["a:true", "c:true", "b:false"]
    );
  });

  test("applyIdOrder keeps unknown leftover items after the requested prefix", () => {
    const next = applyIdOrder(
      [
        { id: "a" },
        { id: "b" },
        { id: "c" },
      ],
      ["c", "missing", "a"]
    );
    assert.deepEqual(
      next.map((item) => item.id),
      ["c", "a", "b"]
    );
  });

  test("catalog merge preserves persisted order and appends new models", () => {
    const merged = mergeCatalogPreservingOrder(
      [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
        { id: "c", name: "C" },
      ],
      [
        { id: "c", name: "Old C", on: true, backendId: "cesium-agent" },
        { id: "a", name: "Old A", on: false, backendId: "cesium-agent" },
        { id: "gone", name: "Gone", on: true, backendId: "cesium-agent" },
      ],
      "cesium-agent"
    );
    assert.deepEqual(
      merged.map((entry) => `${entry.id}:${entry.on}:${entry.name}`),
      ["c:true:C", "a:false:A", "b:true:B"]
    );
  });
});
