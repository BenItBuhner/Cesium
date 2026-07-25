/**
 * Pure helpers behind the draggable voice orb and its transient bubbles.
 * DOM-free so drag/click discrimination and bubble lifecycles are
 * unit-tested.
 */

export type OrbPosition = { x: number; y: number };

export const ORB_SIZE = 88;
const ORB_MARGIN = 8;

/** Keeps the orb fully on screen (with a small margin). */
export function clampOrbPosition(
  position: OrbPosition,
  viewport: { width: number; height: number },
  orbSize: number = ORB_SIZE
): OrbPosition {
  const maxX = Math.max(ORB_MARGIN, viewport.width - orbSize - ORB_MARGIN);
  const maxY = Math.max(ORB_MARGIN, viewport.height - orbSize - ORB_MARGIN);
  return {
    x: Math.min(Math.max(position.x, ORB_MARGIN), maxX),
    y: Math.min(Math.max(position.y, ORB_MARGIN), maxY),
  };
}

export function defaultOrbPosition(viewport: {
  width: number;
  height: number;
}): OrbPosition {
  return clampOrbPosition(
    {
      x: viewport.width - ORB_SIZE - 24,
      y: viewport.height - ORB_SIZE - 24,
    },
    viewport
  );
}

const CLICK_MAX_DISTANCE_PX = 6;
const CLICK_MAX_DURATION_MS = 400;

/** A pointer gesture is a click when it barely moved and ended quickly. */
export function isClickGesture(gesture: {
  downX: number;
  downY: number;
  upX: number;
  upY: number;
  durationMs: number;
}): boolean {
  const distance = Math.hypot(
    gesture.upX - gesture.downX,
    gesture.upY - gesture.downY
  );
  return (
    distance <= CLICK_MAX_DISTANCE_PX &&
    gesture.durationMs <= CLICK_MAX_DURATION_MS
  );
}

/**
 * Which side of the orb the bubble stack should grow toward, based on the
 * orb's quadrant: bubbles always expand toward the viewport center.
 */
export function bubbleAnchor(
  position: OrbPosition,
  viewport: { width: number; height: number },
  orbSize: number = ORB_SIZE
): { horizontal: "left" | "right"; vertical: "up" | "down" } {
  const centerX = position.x + orbSize / 2;
  const centerY = position.y + orbSize / 2;
  return {
    horizontal: centerX > viewport.width / 2 ? "left" : "right",
    vertical: centerY > viewport.height / 2 ? "up" : "down",
  };
}

export type VoiceBubbleKind =
  | "heard"
  | "assistant"
  | "event"
  | "system"
  | "error";

export type VoiceBubble = {
  id: string;
  kind: VoiceBubbleKind;
  text: string;
  meta?: string;
  at: number;
  expiresAt: number;
};

export const BUBBLE_TTL_MS: Record<VoiceBubbleKind, number> = {
  heard: 5000,
  assistant: 9000,
  event: 8000,
  system: 6000,
  error: 9000,
};

const MAX_VISIBLE_BUBBLES = 4;

/** Drops expired bubbles and caps the stack to the newest few. */
export function pruneBubbles(
  bubbles: VoiceBubble[],
  now: number
): VoiceBubble[] {
  const alive = bubbles.filter((bubble) => bubble.expiresAt > now);
  return alive.length > MAX_VISIBLE_BUBBLES
    ? alive.slice(alive.length - MAX_VISIBLE_BUBBLES)
    : alive;
}
