import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BACK_INTENT_PRIORITY,
  selectTopBackHandler,
  type BackHandlerEntry,
} from "../src/lib/back-intent.ts";

const noop = () => true;

function entry(id: number, priority: number): BackHandlerEntry {
  return { id, priority, handler: noop };
}

describe("selectTopBackHandler", () => {
  test("returns null when nothing is registered", () => {
    assert.equal(selectTopBackHandler([]), null);
  });

  test("picks the highest priority handler", () => {
    const rightPane = entry(1, BACK_INTENT_PRIORITY.rightPane);
    const overlay = entry(2, BACK_INTENT_PRIORITY.overlay);
    const settings = entry(3, BACK_INTENT_PRIORITY.settings);
    assert.equal(selectTopBackHandler([rightPane, overlay, settings]), overlay);
  });

  test("breaks ties by most recently registered (largest id)", () => {
    const first = entry(1, BACK_INTENT_PRIORITY.overlay);
    const second = entry(5, BACK_INTENT_PRIORITY.overlay);
    assert.equal(selectTopBackHandler([first, second]), second);
    // Registration order in the array must not matter.
    assert.equal(selectTopBackHandler([second, first]), second);
  });

  test("mobile rail drawer outranks the right pane when both are open", () => {
    const rail = entry(1, BACK_INTENT_PRIORITY.leftRail);
    const rightPane = entry(2, BACK_INTENT_PRIORITY.rightPane);
    assert.equal(selectTopBackHandler([rail, rightPane]), rail);
  });

  test("settings outranks mobile overlays but not top-level overlays", () => {
    const settings = entry(1, BACK_INTENT_PRIORITY.settings);
    const rail = entry(2, BACK_INTENT_PRIORITY.leftRail);
    assert.equal(selectTopBackHandler([settings, rail]), settings);

    const overlay = entry(3, BACK_INTENT_PRIORITY.overlay);
    assert.equal(selectTopBackHandler([settings, overlay]), overlay);
  });

  test("invokes only the selected handler", () => {
    const calls: string[] = [];
    const entries: BackHandlerEntry[] = [
      { id: 1, priority: BACK_INTENT_PRIORITY.rightPane, handler: () => (calls.push("rightPane"), true) },
      { id: 2, priority: BACK_INTENT_PRIORITY.overlay, handler: () => (calls.push("overlay"), true) },
    ];
    const top = selectTopBackHandler(entries);
    assert.ok(top);
    top.handler();
    assert.deepEqual(calls, ["overlay"]);
  });
});
