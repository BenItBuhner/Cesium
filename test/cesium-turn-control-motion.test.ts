import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CESIUM_TURN_PILL_TRANSITION_MS,
  planCesiumTurnPillMotion,
} from "../src/components/chat/cesium-turn-control-motion.ts";

const hidden = { mounted: false, expanded: false } as const;
const collapsed = { mounted: true, expanded: false } as const;
const expanded = { mounted: true, expanded: true } as const;

describe("Cesium turn-control pill motion", () => {
  test("send mounts collapsed then expands on the next frame", () => {
    const plan = planCesiumTurnPillMotion(true, true, hidden);
    assert.deepEqual(plan.next, collapsed);
    assert.equal(plan.expandOnNextFrame, true);
    assert.equal(plan.unmountAfterMs, null);
  });

  test("already-mounted send expands without remounting", () => {
    const plan = planCesiumTurnPillMotion(true, true, collapsed);
    assert.deepEqual(plan.next, collapsed);
    assert.equal(plan.expandOnNextFrame, true);
    assert.equal(plan.unmountAfterMs, null);
  });

  test("draft collapses the live pill and keeps it mounted as send", () => {
    const plan = planCesiumTurnPillMotion(true, false, expanded);
    assert.deepEqual(plan.next, collapsed);
    assert.equal(plan.expandOnNextFrame, false);
    assert.equal(plan.unmountAfterMs, null);
  });

  test("clearing a draft expands the same pill again", () => {
    const plan = planCesiumTurnPillMotion(true, true, collapsed);
    assert.equal(plan.expandOnNextFrame, true);
    assert.equal(plan.unmountAfterMs, null);
  });

  test("stop collapses first, then unmounts after the width transition", () => {
    const plan = planCesiumTurnPillMotion(false, false, expanded);
    assert.deepEqual(plan.next, collapsed);
    assert.equal(plan.expandOnNextFrame, false);
    assert.equal(plan.unmountAfterMs, CESIUM_TURN_PILL_TRANSITION_MS);
  });

  test("stop can reverse mid-collapse if the turn becomes active again", () => {
    const plan = planCesiumTurnPillMotion(true, true, collapsed);
    assert.equal(plan.expandOnNextFrame, true);
    assert.equal(plan.unmountAfterMs, null);
  });

  test("hidden stays hidden", () => {
    const plan = planCesiumTurnPillMotion(false, false, hidden);
    assert.deepEqual(plan.next, hidden);
    assert.equal(plan.expandOnNextFrame, false);
    assert.equal(plan.unmountAfterMs, null);
  });

  test("expanded no-op when the turn is still live", () => {
    const plan = planCesiumTurnPillMotion(true, true, expanded);
    assert.deepEqual(plan.next, expanded);
    assert.equal(plan.expandOnNextFrame, false);
    assert.equal(plan.unmountAfterMs, null);
  });
});
