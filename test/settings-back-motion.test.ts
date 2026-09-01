import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  SETTINGS_BACK_GESTURE_MAX_DEPARTURE,
  gestureProgressToDeparture,
  settingsBackDirection,
  settingsBackFrame,
} from "../src/lib/settings-back-motion.ts";

describe("settingsBackDirection", () => {
  test("a left-edge swipe slides the surface rightward", () => {
    assert.equal(settingsBackDirection("left"), 1);
  });

  test("a right-edge swipe slides the surface leftward", () => {
    assert.equal(settingsBackDirection("right"), -1);
  });

  test("the discrete back paths (no edge) default to the rightward slide", () => {
    assert.equal(settingsBackDirection(undefined), 1);
  });
});

describe("gestureProgressToDeparture", () => {
  test("maps the full gesture pull onto the gesture slice of the departure range", () => {
    assert.equal(gestureProgressToDeparture(0), 0);
    assert.equal(gestureProgressToDeparture(1), SETTINGS_BACK_GESTURE_MAX_DEPARTURE);
    assert.equal(
      gestureProgressToDeparture(0.5),
      SETTINGS_BACK_GESTURE_MAX_DEPARTURE / 2
    );
  });

  test("clamps out-of-range progress", () => {
    assert.equal(gestureProgressToDeparture(-0.4), 0);
    assert.equal(gestureProgressToDeparture(1.7), SETTINGS_BACK_GESTURE_MAX_DEPARTURE);
  });
});

describe("settingsBackFrame", () => {
  test("rest frame leaves the surface untouched and the reveal fully veiled", () => {
    const frame = settingsBackFrame(0, 1);
    assert.equal(frame.surfaceTranslateXPct, 0);
    assert.equal(frame.surfaceScale, 1);
    assert.equal(frame.surfaceRadiusPx, 0);
    assert.equal(frame.surfaceShadowAlpha, 0);
    assert.equal(frame.scrimOpacity, 1);
    assert.ok(frame.underlayScale < 1, "underlay starts pushed back");
  });

  test("the surface slides with the gesture in the swipe direction", () => {
    const half = gestureProgressToDeparture(0.5);
    const rightward = settingsBackFrame(half, 1);
    const leftward = settingsBackFrame(half, -1);
    assert.equal(rightward.surfaceTranslateXPct, half * 100);
    assert.equal(leftward.surfaceTranslateXPct, -half * 100);
  });

  test("translation grows monotonically toward fully off-screen", () => {
    let previous = -1;
    for (const departure of [0, 0.1, 0.3, 0.6, 1]) {
      const { surfaceTranslateXPct } = settingsBackFrame(departure, 1);
      assert.ok(surfaceTranslateXPct > previous);
      previous = surfaceTranslateXPct;
    }
    assert.equal(settingsBackFrame(1, 1).surfaceTranslateXPct, 100);
  });

  test("depth (scale / radius) completes within the gesture range, then holds", () => {
    const atGestureMax = settingsBackFrame(SETTINGS_BACK_GESTURE_MAX_DEPARTURE, 1);
    const midCommit = settingsBackFrame(0.6, 1);
    const committed = settingsBackFrame(1, 1);
    assert.ok(atGestureMax.surfaceScale < 1);
    assert.ok(atGestureMax.surfaceRadiusPx > 0);
    assert.equal(midCommit.surfaceScale, atGestureMax.surfaceScale);
    assert.equal(committed.surfaceScale, atGestureMax.surfaceScale);
    assert.equal(midCommit.surfaceRadiusPx, atGestureMax.surfaceRadiusPx);
    assert.equal(committed.surfaceRadiusPx, atGestureMax.surfaceRadiusPx);
  });

  test("the elevation shadow leads the motion and never overshoots", () => {
    const early = settingsBackFrame(0.04, 1);
    const settled = settingsBackFrame(0.2, 1);
    const committed = settingsBackFrame(1, 1);
    assert.ok(early.surfaceShadowAlpha > 0);
    assert.ok(early.surfaceShadowAlpha < settled.surfaceShadowAlpha);
    assert.equal(settled.surfaceShadowAlpha, committed.surfaceShadowAlpha);
  });

  test("the revealed view scales up while its scrim clears", () => {
    const start = settingsBackFrame(0, 1);
    const mid = settingsBackFrame(gestureProgressToDeparture(0.8), 1);
    const committed = settingsBackFrame(1, 1);
    assert.ok(mid.underlayScale > start.underlayScale);
    assert.ok(mid.scrimOpacity < start.scrimOpacity);
    assert.equal(committed.underlayScale, 1);
    assert.equal(committed.scrimOpacity, 0);
  });

  test("the revealed view fully arrives slightly before the surface finishes leaving", () => {
    const nearEnd = settingsBackFrame(0.9, 1);
    assert.equal(nearEnd.underlayScale, 1);
    assert.equal(nearEnd.scrimOpacity, 0);
    assert.ok(nearEnd.surfaceTranslateXPct < 100);
  });

  test("clamps out-of-range departures", () => {
    assert.deepEqual(settingsBackFrame(-1, 1), settingsBackFrame(0, 1));
    assert.deepEqual(settingsBackFrame(2, 1), settingsBackFrame(1, 1));
  });
});
