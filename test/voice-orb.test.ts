import test from "node:test";
import assert from "node:assert/strict";
import {
  bubbleAnchor,
  BUBBLE_TTL_MS,
  clampOrbPosition,
  defaultOrbPosition,
  isClickGesture,
  ORB_SIZE,
  pruneBubbles,
  type VoiceBubble,
} from "../src/lib/voice/orb-utils.ts";

const VIEWPORT = { width: 1280, height: 800 };

test("orb position clamps fully on screen", () => {
  assert.deepEqual(clampOrbPosition({ x: -50, y: -50 }, VIEWPORT), {
    x: 8,
    y: 8,
  });
  const clamped = clampOrbPosition({ x: 5000, y: 5000 }, VIEWPORT);
  assert.equal(clamped.x, VIEWPORT.width - ORB_SIZE - 8);
  assert.equal(clamped.y, VIEWPORT.height - ORB_SIZE - 8);
  // In-bounds positions pass through untouched.
  assert.deepEqual(clampOrbPosition({ x: 300, y: 200 }, VIEWPORT), {
    x: 300,
    y: 200,
  });
});

test("default orb position sits in the bottom-right corner", () => {
  const position = defaultOrbPosition(VIEWPORT);
  assert.ok(position.x > VIEWPORT.width / 2);
  assert.ok(position.y > VIEWPORT.height / 2);
});

test("click gestures require small movement and short duration", () => {
  assert.equal(
    isClickGesture({ downX: 10, downY: 10, upX: 12, upY: 11, durationMs: 150 }),
    true
  );
  // Drag: too far.
  assert.equal(
    isClickGesture({ downX: 10, downY: 10, upX: 40, upY: 10, durationMs: 150 }),
    false
  );
  // Hold: too long (long-press opens the menu instead).
  assert.equal(
    isClickGesture({ downX: 10, downY: 10, upX: 10, upY: 10, durationMs: 900 }),
    false
  );
});

test("bubbles stack toward the viewport center from the orb's quadrant", () => {
  // Bottom-right orb: bubbles grow up and to the left.
  assert.deepEqual(bubbleAnchor({ x: 1100, y: 700 }, VIEWPORT), {
    horizontal: "left",
    vertical: "up",
  });
  // Top-left orb: bubbles grow down and to the right.
  assert.deepEqual(bubbleAnchor({ x: 20, y: 20 }, VIEWPORT), {
    horizontal: "right",
    vertical: "down",
  });
});

function bubble(id: string, expiresAt: number): VoiceBubble {
  return {
    id,
    kind: "assistant",
    text: id,
    at: 0,
    expiresAt,
  };
}

test("bubble pruning drops expired entries and caps the stack", () => {
  const now = 10_000;
  const pruned = pruneBubbles(
    [
      bubble("expired", now - 1),
      bubble("a", now + 1000),
      bubble("b", now + 1000),
      bubble("c", now + 1000),
      bubble("d", now + 1000),
      bubble("e", now + 1000),
    ],
    now
  );
  // Expired dropped, capped to the newest 4.
  assert.deepEqual(
    pruned.map((entry) => entry.id),
    ["b", "c", "d", "e"]
  );
});

test("bubble TTLs give speech captions the longest life", () => {
  assert.ok(BUBBLE_TTL_MS.assistant > BUBBLE_TTL_MS.heard);
  assert.ok(BUBBLE_TTL_MS.error >= BUBBLE_TTL_MS.system);
});
