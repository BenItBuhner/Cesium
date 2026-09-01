/**
 * Pure math for the full-screen settings view's Android predictive-back
 * motion. Kept framework-free so it can be unit tested without a React/DOM
 * environment; the imperative style writes live in
 * `@/components/layout/WorkbenchApp`.
 *
 * The motion is a single "departure" scalar in [0, 1]:
 *
 * - 0   = the settings surface is at rest, fully covering the shell.
 * - 1   = the surface has fully slid off-screen (a committed back).
 *
 * While the finger drags, gesture progress maps onto the leading
 * `SETTINGS_BACK_GESTURE_MAX_DEPARTURE` slice of that range - the surface
 * slides with the finger, picks up a slight scale-down / corner radius /
 * shadow for depth, and the agent view is revealed beneath it (scaling up
 * from `UNDERLAY_MIN_SCALE` behind a clearing scrim). A committed gesture
 * springs departure to 1 so the surface flings the rest of the way off; a
 * cancelled gesture springs it back to 0.
 */

/** Fraction of the shell width the surface departs at full gesture pull. */
export const SETTINGS_BACK_GESTURE_MAX_DEPARTURE = 0.3;

/** Scale of the departing surface once the depth ramp completes. */
const SURFACE_MIN_SCALE = 0.96;
/** Corner radius (px) of the departing surface once the depth ramp completes. */
const SURFACE_MAX_RADIUS_PX = 24;
/** Elevation shadow alpha of the departing surface. */
const SURFACE_SHADOW_MAX_ALPHA = 0.45;
/** Departure by which the shadow is fully faded in (it leads the motion). */
const SURFACE_SHADOW_RAMP = 0.08;
/** Resting scale of the revealed agent view when the gesture begins. */
const UNDERLAY_MIN_SCALE = 0.96;
/**
 * Departure at which the revealed view has fully "arrived" (scale 1, scrim
 * clear) - slightly before the surface finishes leaving, so the destination
 * settles while the old page clears the screen.
 */
const UNDERLAY_ARRIVAL_DEPARTURE = 0.85;

/** +1 slides the surface rightward (left-edge swipe), -1 leftward. */
export type SettingsBackDirection = 1 | -1;

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
  /** Scale of the revealed agent view beneath. */
  underlayScale: number;
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

/** Computes one frame of the motion for a departure in [0, 1]. */
export function settingsBackFrame(
  departure: number,
  direction: SettingsBackDirection
): SettingsBackFrame {
  const d = clamp01(departure);
  // Depth (scale / radius) completes within the gesture range and then holds
  // while the commit spring carries the surface the rest of the way off.
  const depth = clamp01(d / SETTINGS_BACK_GESTURE_MAX_DEPARTURE);
  const reveal = easeOutQuad(clamp01(d / UNDERLAY_ARRIVAL_DEPARTURE));
  return {
    surfaceTranslateXPct: direction * d * 100,
    surfaceScale: 1 - (1 - SURFACE_MIN_SCALE) * depth,
    surfaceRadiusPx: SURFACE_MAX_RADIUS_PX * depth,
    surfaceShadowAlpha:
      d <= 0 ? 0 : SURFACE_SHADOW_MAX_ALPHA * clamp01(d / SURFACE_SHADOW_RAMP),
    underlayScale: UNDERLAY_MIN_SCALE + (1 - UNDERLAY_MIN_SCALE) * reveal,
    scrimOpacity: 1 - reveal,
  };
}
