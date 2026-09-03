import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  SETTINGS_BACK_GESTURE_MAX_DEPARTURE,
  SETTINGS_BACK_MIN_COMMIT_VELOCITY,
  estimateGestureVelocity,
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
  test("tracks the finger nearly 1:1 across the gesture slice", () => {
    assert.equal(gestureProgressToDeparture(0), 0);
    assert.equal(gestureProgressToDeparture(1), SETTINGS_BACK_GESTURE_MAX_DEPARTURE);
    assert.equal(
      gestureProgressToDeparture(0.5),
      SETTINGS_BACK_GESTURE_MAX_DEPARTURE / 2
    );
    // A full pull moves most of the way off-screen - strong tracking.
    assert.ok(SETTINGS_BACK_GESTURE_MAX_DEPARTURE >= 0.8);
    // ... but not all the way: an uncommitted pull keeps a sliver visible.
    assert.ok(SETTINGS_BACK_GESTURE_MAX_DEPARTURE < 1);
  });

  test("clamps out-of-range progress", () => {
    assert.equal(gestureProgressToDeparture(-0.4), 0);
    assert.equal(gestureProgressToDeparture(1.7), SETTINGS_BACK_GESTURE_MAX_DEPARTURE);
  });
});

describe("estimateGestureVelocity", () => {
  test("computes departure/sec from the first and last samples", () => {
    const velocity = estimateGestureVelocity([
      { timeMs: 1000, departure: 0.1 },
      { timeMs: 1050, departure: 0.2 },
      { timeMs: 1100, departure: 0.4 },
    ]);
    assert.ok(Math.abs(velocity - 3) < 1e-9);
  });

  test("a retreating finger yields negative velocity", () => {
    const velocity = estimateGestureVelocity([
      { timeMs: 0, departure: 0.5 },
      { timeMs: 100, departure: 0.3 },
    ]);
    assert.ok(velocity < 0);
  });

  test("returns 0 without enough signal", () => {
    assert.equal(estimateGestureVelocity([]), 0);
    assert.equal(estimateGestureVelocity([{ timeMs: 0, departure: 0.4 }]), 0);
    assert.equal(
      estimateGestureVelocity([
        { timeMs: 5, departure: 0 },
        { timeMs: 5, departure: 0.4 },
      ]),
      0
    );
  });

  test("the commit velocity floor keeps flings decisive", () => {
    assert.ok(SETTINGS_BACK_MIN_COMMIT_VELOCITY >= 2);
  });
});

describe("settingsBackFrame", () => {
  test("rest frame leaves the surface untouched and every motion layer faded out", () => {
    const frame = settingsBackFrame(0, 1);
    assert.equal(frame.surfaceTranslateXPct, 0);
    assert.equal(frame.surfaceScale, 1);
    assert.equal(frame.surfaceRadiusPx, 0);
    assert.equal(frame.surfaceShadowAlpha, 0);
    // At rest nothing may alter the surface's translucent look or show
    // behind it: the opaque backdrop, the reveal layer, and the scrim all
    // start fully transparent and fade in with the pull.
    assert.equal(frame.surfaceBackdropAlpha, 0);
    assert.equal(frame.previewOpacity, 0);
    assert.equal(frame.scrimOpacity, 0);
    assert.ok(frame.underlayScale < 1, "underlay starts pushed back");
    assert.ok(frame.underlayTranslateXPct < 0, "underlay starts offset opposite the exit");
  });

  test("the cross-fades ramp in smoothly and complete early in the pull", () => {
    const early = settingsBackFrame(0.05, 1);
    assert.ok(early.surfaceBackdropAlpha > 0 && early.surfaceBackdropAlpha < 1);
    assert.ok(early.previewOpacity > 0 && early.previewOpacity < 1);
    assert.ok(early.scrimOpacity > 0 && early.scrimOpacity < 1);
    const faded = settingsBackFrame(0.12, 1);
    assert.equal(faded.surfaceBackdropAlpha, 1);
    assert.equal(faded.previewOpacity, 1);
    const committed = settingsBackFrame(1, 1);
    assert.equal(committed.surfaceBackdropAlpha, 1);
    assert.equal(committed.previewOpacity, 1);
  });

  test("the surface slides with the gesture in the swipe direction", () => {
    const half = gestureProgressToDeparture(0.5);
    const rightward = settingsBackFrame(half, 1);
    const leftward = settingsBackFrame(half, -1);
    assert.ok(rightward.surfaceTranslateXPct > 0);
    assert.equal(leftward.surfaceTranslateXPct, -rightward.surfaceTranslateXPct);
  });

  test("translation grows monotonically and overshoots the viewport at departure 1", () => {
    let previous = -1;
    for (const departure of [0, 0.1, 0.3, 0.6, 1]) {
      const { surfaceTranslateXPct } = settingsBackFrame(departure, 1);
      assert.ok(surfaceTranslateXPct > previous);
      previous = surfaceTranslateXPct;
    }
    // The exit travel exceeds the viewport so the surface - scale inset and
    // elevation shadow included - fully clears the screen while the spring
    // still carries speed; the settling tail happens off-screen.
    assert.ok(settingsBackFrame(1, 1).surfaceTranslateXPct > 110);
  });

  test("a full gesture pull travels most of the width but stays on-screen", () => {
    const fullPull = settingsBackFrame(gestureProgressToDeparture(1), 1);
    assert.ok(fullPull.surfaceTranslateXPct > 80, "tracks the finger nearly 1:1");
    assert.ok(fullPull.surfaceTranslateXPct < 100, "a sliver remains until commit");
  });

  test("depth (scale / radius) engages early, then holds through the exit", () => {
    const early = settingsBackFrame(0.25, 1);
    const midCommit = settingsBackFrame(0.6, 1);
    const committed = settingsBackFrame(1, 1);
    assert.ok(early.surfaceScale < 1);
    assert.ok(early.surfaceRadiusPx > 0);
    assert.equal(midCommit.surfaceScale, early.surfaceScale);
    assert.equal(committed.surfaceScale, early.surfaceScale);
    assert.equal(midCommit.surfaceRadiusPx, early.surfaceRadiusPx);
    assert.equal(committed.surfaceRadiusPx, early.surfaceRadiusPx);
  });

  test("the elevation shadow leads the motion and never overshoots", () => {
    const early = settingsBackFrame(0.04, 1);
    const settled = settingsBackFrame(0.2, 1);
    const committed = settingsBackFrame(1, 1);
    assert.ok(early.surfaceShadowAlpha > 0);
    assert.ok(early.surfaceShadowAlpha < settled.surfaceShadowAlpha);
    assert.equal(settled.surfaceShadowAlpha, committed.surfaceShadowAlpha);
  });

  test("the revealed view slides in with parallax while its scrim clears", () => {
    const start = settingsBackFrame(0, 1);
    const shallow = settingsBackFrame(0.15, 1);
    const mid = settingsBackFrame(gestureProgressToDeparture(0.5), 1);
    const committed = settingsBackFrame(1, 1);
    assert.ok(mid.underlayScale > start.underlayScale);
    assert.ok(mid.underlayTranslateXPct > start.underlayTranslateXPct);
    // Past the fade ramp the dim is strong, then clears as the pull deepens.
    assert.ok(shallow.scrimOpacity > mid.scrimOpacity);
    assert.equal(committed.underlayScale, 1);
    assert.equal(committed.underlayTranslateXPct, 0);
    assert.equal(committed.scrimOpacity, 0);
  });

  test("the parallax offset mirrors with the exit direction", () => {
    const rightExit = settingsBackFrame(0, 1);
    const leftExit = settingsBackFrame(0, -1);
    assert.equal(leftExit.underlayTranslateXPct, -rightExit.underlayTranslateXPct);
    assert.ok(rightExit.underlayTranslateXPct < 0, "arrives from the left on a rightward exit");
  });

  test("the revealed view fully arrives slightly before the surface finishes leaving", () => {
    const nearEnd = settingsBackFrame(0.9, 1);
    assert.equal(nearEnd.underlayScale, 1);
    assert.equal(nearEnd.underlayTranslateXPct, 0);
    assert.equal(nearEnd.scrimOpacity, 0);
  });

  test("clamps out-of-range departures", () => {
    assert.deepEqual(settingsBackFrame(-1, 1), settingsBackFrame(0, 1));
    assert.deepEqual(settingsBackFrame(2, 1), settingsBackFrame(1, 1));
  });
});
