import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BACK_INTENT_PRIORITY,
  BackGestureCoordinator,
  selectTopBackHandler,
  type BackGestureEvent,
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

function gestureFrame(progress: number): BackGestureEvent {
  return { progress, swipeEdge: "left" };
}

describe("BackGestureCoordinator", () => {
  test("streams start/progress/cancel to the top handler's gesture hooks", () => {
    const calls: Array<[string, number]> = [];
    const entries: BackHandlerEntry[] = [
      {
        id: 1,
        priority: BACK_INTENT_PRIORITY.leftRail,
        handler: () => true,
        gesture: {
          onStart: (event) => calls.push(["start", event.progress]),
          onProgress: (event) => calls.push(["progress", event.progress]),
          onCancel: () => calls.push(["cancel", -1]),
        },
      },
    ];
    const coordinator = new BackGestureCoordinator(() => entries);

    assert.equal(coordinator.start(gestureFrame(0)), true);
    coordinator.progress(gestureFrame(0.3));
    coordinator.progress(gestureFrame(0.6));
    coordinator.cancel();
    assert.deepEqual(calls, [
      ["start", 0],
      ["progress", 0.3],
      ["progress", 0.6],
      ["cancel", -1],
    ]);
  });

  test("commit pops the handler stashed at gesture start, even if the registry changed", () => {
    const popped: string[] = [];
    let entries: BackHandlerEntry[] = [
      {
        id: 1,
        priority: BACK_INTENT_PRIORITY.rightPane,
        handler: () => (popped.push("rightPane"), true),
      },
    ];
    const coordinator = new BackGestureCoordinator(() => entries);

    assert.equal(coordinator.start(gestureFrame(0)), true);
    // A higher-priority overlay opens mid-gesture; the in-flight gesture must
    // still pop the layer it started on.
    entries = [
      ...entries,
      {
        id: 2,
        priority: BACK_INTENT_PRIORITY.overlay,
        handler: () => (popped.push("overlay"), true),
      },
    ];
    assert.equal(coordinator.commit(), true);
    assert.deepEqual(popped, ["rightPane"]);
  });

  test("commit without a preceding start resolves the top handler discretely", () => {
    const popped: string[] = [];
    const entries: BackHandlerEntry[] = [
      {
        id: 1,
        priority: BACK_INTENT_PRIORITY.settings,
        handler: () => (popped.push("settings"), true),
      },
    ];
    const coordinator = new BackGestureCoordinator(() => entries);
    assert.equal(coordinator.commit(), true);
    assert.deepEqual(popped, ["settings"]);
  });

  test("start reports false and commit falls back when nothing is registered", () => {
    const coordinator = new BackGestureCoordinator(() => []);
    assert.equal(coordinator.start(gestureFrame(0)), false);
    assert.equal(coordinator.commit(), false);
  });

  test("handlers without gesture hooks still pop on commit after a gesture", () => {
    const popped: string[] = [];
    const entries: BackHandlerEntry[] = [
      {
        id: 1,
        priority: BACK_INTENT_PRIORITY.overlay,
        handler: () => (popped.push("overlay"), true),
      },
    ];
    const coordinator = new BackGestureCoordinator(() => entries);
    assert.equal(coordinator.start(gestureFrame(0)), true);
    coordinator.progress(gestureFrame(0.5));
    assert.equal(coordinator.commit(), true);
    assert.deepEqual(popped, ["overlay"]);
  });

  test("a cancelled gesture leaves the next commit to resolve fresh", () => {
    const popped: string[] = [];
    let entries: BackHandlerEntry[] = [
      {
        id: 1,
        priority: BACK_INTENT_PRIORITY.leftRail,
        handler: () => (popped.push("rail"), true),
      },
    ];
    const coordinator = new BackGestureCoordinator(() => entries);
    coordinator.start(gestureFrame(0));
    coordinator.cancel();
    entries = [
      {
        id: 2,
        priority: BACK_INTENT_PRIORITY.overlay,
        handler: () => (popped.push("overlay"), true),
      },
    ];
    assert.equal(coordinator.commit(), true);
    assert.deepEqual(popped, ["overlay"]);
  });

  test("each gesture commits at most once", () => {
    const popped: string[] = [];
    const entries: BackHandlerEntry[] = [
      {
        id: 1,
        priority: BACK_INTENT_PRIORITY.leftRail,
        handler: () => (popped.push("rail"), true),
      },
    ];
    const coordinator = new BackGestureCoordinator(() => entries);
    coordinator.start(gestureFrame(0));
    assert.equal(coordinator.commit(), true);
    // A stray second commit resolves fresh (the rail handler is still
    // registered in this synthetic registry, so it pops again) — but the
    // stash must be cleared so nothing double-fires from stale state.
    assert.equal(coordinator.commit(), true);
    assert.deepEqual(popped, ["rail", "rail"]);
  });
});
