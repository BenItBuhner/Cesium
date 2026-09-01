/**
 * Pure math for the full-screen settings view's Android predictive-back
 * motion. Kept framework-free so it can be unit tested without a React/DOM
 * environment; the imperative style writes live in
 * `@/components/layout/WorkbenchApp`.
 *
 * The motion is a single "departure" scalar in [0, 1]:
 *
 * - 0   = the settings surface is at rest, fully covering the shell.
 * - 1   = the surface has finished leaving (a committed back).
 *
 * While the finger drags, gesture progress maps near 1:1 onto the leading
 * `SETTINGS_BACK_GESTURE_MAX_DEPARTURE` slice of that range - the surface
 * genuinely travels with the finger (picking up a slight scale-down, corner
 * radius, and shadow for depth) while the agent view is revealed beneath it,
 * sliding in with a parallax offset and scaling up behind a clearing scrim.
 *
 * A committed gesture springs departure to 1 seeded with the finger's own
 * velocity. Critically, the surface's translation at departure 1 overshoots
 * the viewport (`SURFACE_EXIT_TRAVEL_PCT` > 100), so the visible exit -
 * shadow included - completes while the spring still carries real speed; the
 * spring's asymptotic settling tail happens entirely off-screen instead of
 * visibly stalling at the edge. A cancelled gesture springs back to 0.
 */

/**
 * Departure at a full gesture pull (progress 1). Kept just shy of 1 so a
 * maximal uncommitted pull still leaves a sliver of the surface on-screen -
 * the "not released yet" cue - while tracking the finger nearly 1:1.
 */
export const SETTINGS_BACK_GESTURE_MAX_DEPARTURE = 0.85;

/**
 * Floor for the committed exit's spring velocity (departure/sec). Slow lifts
 * and the discrete back paths still get a decisive fling instead of a crawl.
 */
export const SETTINGS_BACK_MIN_COMMIT_VELOCITY = 3;

/**
 * Horizontal travel (% of the surface's own width) at departure 1. Over 100
 * so the surface - including its scale inset and elevation shadow - fully
 * clears the viewport before the spring settles.
 */
const SURFACE_EXIT_TRAVEL_PCT = 115;
/**
 * Departure by which the motion's cross-fades complete: the aurora-mode
 * settings surface is a translucent window, so an opaque backdrop fades in
 * behind its content (the surface lifts off as a solid card) while the
 * reveal layers beneath fade in from nothing. Without this window the reveal
 * would pop into view through the surface's translucency the instant the
 * gesture starts.
 */
const MOTION_FADE_RAMP_DEPARTURE = 0.1;
/** Scale of the departing surface once the depth ramp completes. */
const SURFACE_MIN_SCALE = 0.96;
/** Corner radius (px) of the departing surface once the depth ramp completes. */
const SURFACE_MAX_RADIUS_PX = 24;
/** Departure by which scale / radius reach their peak (depth engages early). */
const SURFACE_DEPTH_RAMP_DEPARTURE = 0.25;
/** Elevation shadow alpha of the departing surface. */
const SURFACE_SHADOW_MAX_ALPHA = 0.45;
/** Departure by which the shadow is fully faded in (it leads the motion). */
const SURFACE_SHADOW_RAMP = 0.08;
/** Resting scale of the revealed agent view when the gesture begins. */
const UNDERLAY_MIN_SCALE = 0.96;
/** Parallax offset (% of width) the revealed view slides in from. */
const UNDERLAY_PARALLAX_PCT = 8;
/**
 * Departure at which the revealed view has fully "arrived" (scale 1, parallax
 * 0, scrim clear) - as the surface clears the viewport, the destination is
 * already settled.
 */
const UNDERLAY_ARRIVAL_DEPARTURE = 0.85;

/** +1 slides the surface rightward (left-edge swipe), -1 leftward. */
export type SettingsBackDirection = 1 | -1;

/** One (time, departure) gesture sample for velocity estimation. */
export type SettingsBackGestureSample = {
  timeMs: number;
  departure: number;
};

/**
 * One rendered frame of the motion. Numeric values only, so tests can assert
 * exact math; the component composes the actual CSS strings.
 */
export type SettingsBackFrame = {
  /** Horizontal translation of the settings surface, % of its own width. */
  surfaceTranslateXPct: number;
  surfaceScale: number;
  surfaceRadiusPx: number;
  /** 0 = no shadow. */
  surfaceShadowAlpha: number;
  /** Opacity of the opaque backdrop that solidifies the translucent surface. */
  surfaceBackdropAlpha: number;
  /** Scale of the revealed agent view beneath. */
  underlayScale: number;
  /** Parallax translation of the revealed view, % of its own width. */
  underlayTranslateXPct: number;
  /** Opacity of the revealed view (fades in over the fade ramp). */
  previewOpacity: number;
  /** Multiplier against the scrim's own backdrop color (1 = fully dimmed). */
  scrimOpacity: number;
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Ease-out so the revealed view moves perceptibly during the gesture range. */
function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/**
 * Maps the swipe edge reported by Android onto the slide direction: the
 * surface always travels the way the finger does. The discrete back paths
 * (3-button navigation, pre-Android-14) have no edge and use the default
 * rightward slide, matching the system's own back transition.
 */
export function settingsBackDirection(
  swipeEdge: "left" | "right" | undefined
): SettingsBackDirection {
  return swipeEdge === "right" ? -1 : 1;
}

/**
 * Maps the Android gesture progress (0..1 across the full committed pull)
 * onto the gesture's slice of the departure range.
 */
export function gestureProgressToDeparture(progress: number): number {
  return clamp01(progress) * SETTINGS_BACK_GESTURE_MAX_DEPARTURE;
}

/**
 * Departure velocity (units/sec) estimated from the most recent gesture
 * samples, used to seed the commit/cancel springs with the finger's real
 * speed. Returns 0 when there is not enough signal.
 */
export function estimateGestureVelocity(
  samples: readonly SettingsBackGestureSample[]
): number {
  if (samples.length < 2) {
    return 0;
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dtMs = last.timeMs - first.timeMs;
  if (dtMs <= 0) {
    return 0;
  }
  return ((last.departure - first.departure) / dtMs) * 1000;
}

/** Computes one frame of the motion for a departure in [0, 1]. */
export function settingsBackFrame(
  departure: number,
  direction: SettingsBackDirection
): SettingsBackFrame {
  const d = clamp01(departure);
  // Depth (scale / radius) engages within the first stretch of the pull and
  // then holds while the surface travels the rest of the way off.
  const depth = clamp01(d / SURFACE_DEPTH_RAMP_DEPARTURE);
  const reveal = easeOutQuad(clamp01(d / UNDERLAY_ARRIVAL_DEPARTURE));
  const fade = clamp01(d / MOTION_FADE_RAMP_DEPARTURE);
  return {
    surfaceTranslateXPct: direction * d * SURFACE_EXIT_TRAVEL_PCT,
    surfaceScale: 1 - (1 - SURFACE_MIN_SCALE) * depth,
    surfaceRadiusPx: SURFACE_MAX_RADIUS_PX * depth,
    surfaceShadowAlpha:
      d <= 0 ? 0 : SURFACE_SHADOW_MAX_ALPHA * clamp01(d / SURFACE_SHADOW_RAMP),
    surfaceBackdropAlpha: fade,
    underlayScale: UNDERLAY_MIN_SCALE + (1 - UNDERLAY_MIN_SCALE) * reveal,
    // `+ 0` normalizes the -0 produced at full reveal.
    underlayTranslateXPct: -direction * UNDERLAY_PARALLAX_PCT * (1 - reveal) + 0,
    previewOpacity: fade,
    // The dim clears with the reveal; the fade keeps its appearance gradual
    // during the first frames so nothing snaps in behind the surface.
    scrimOpacity: (1 - reveal) * fade,
  };
}
