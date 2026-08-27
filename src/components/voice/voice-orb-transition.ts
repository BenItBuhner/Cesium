/**
 * FLIP transitions for the voice-agent session orb between its two homes:
 * the full-screen session view and the minimized dock pill above the
 * composer.
 *
 * Mirrors the composer split animation's philosophy: nothing is cloned or
 * faked. The rect of the orb canvas is captured at the moment a view change
 * is requested (while the source element is still laid out), and the *real*
 * destination orb canvas is translated+scaled from that rect to its natural
 * spot once the destination view renders. Minimizing therefore reads as the
 * big orb shrinking down into the dock; expanding as the docked orb flying
 * back up to center stage.
 *
 * Usage: `captureVoiceOrbRect("full" | "dock")` synchronously inside the
 * provider's minimize()/expand() (before the view state flips), then
 * `consumeVoiceOrbRect()` + `flipOrbFromRect()` from a layout effect in the
 * destination component.
 */

export type VoiceOrbVariant = "full" | "dock";

type OrbSource = {
  rect: DOMRect;
  capturedAt: number;
};

/** Generous TTL: destination views mount within a frame or two. */
const SOURCE_TTL_MS = 1200;
export const ORB_FLIP_DURATION_MS = 380;
export const ORB_FLIP_EASING = "cubic-bezier(0.24, 0.9, 0.3, 1)";

const pendingByVariant: Partial<Record<VoiceOrbVariant, OrbSource>> = {};

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
  );
}

/**
 * Captures the current rect of the orb canvas rendered with the given
 * variant, keyed by that variant. No-op when the element is not in the DOM
 * or the user prefers reduced motion.
 */
export function captureVoiceOrbRect(variant: VoiceOrbVariant): void {
  if (typeof document === "undefined" || prefersReducedMotion()) {
    return;
  }
  const el = document.querySelector<HTMLElement>(
    `[data-voice-orb="${variant}"]`
  );
  if (!el) {
    delete pendingByVariant[variant];
    return;
  }
  pendingByVariant[variant] = {
    rect: el.getBoundingClientRect(),
    capturedAt: performance.now(),
  };
}

/** Returns and clears the captured source rect for a variant, if still fresh. */
export function consumeVoiceOrbRect(variant: VoiceOrbVariant): DOMRect | null {
  const source = pendingByVariant[variant];
  delete pendingByVariant[variant];
  if (!source) return null;
  if (performance.now() - source.capturedAt > SOURCE_TTL_MS) return null;
  if (prefersReducedMotion()) return null;
  return source.rect;
}

/**
 * FLIP-translate+scale `el` from `sourceRect` to its natural position.
 * Center-anchored so a circular orb scales cleanly in place.
 */
export function flipOrbFromRect(
  el: HTMLElement,
  sourceRect: DOMRect,
  options?: { durationMs?: number }
): Animation | null {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const dx =
    sourceRect.left + sourceRect.width / 2 - (rect.left + rect.width / 2);
  const dy =
    sourceRect.top + sourceRect.height / 2 - (rect.top + rect.height / 2);
  const scale = sourceRect.width / rect.width;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(scale - 1) < 0.02) {
    return null;
  }
  return el.animate(
    [
      {
        transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
        transformOrigin: "center center",
      },
      { transform: "translate(0px, 0px) scale(1)", transformOrigin: "center center" },
    ],
    {
      duration: options?.durationMs ?? ORB_FLIP_DURATION_MS,
      easing: ORB_FLIP_EASING,
      // Keep the first keyframe applied before the animation's start delay
      // resolves, so the orb never flashes at its resting spot.
      fill: "backwards",
    }
  );
}
