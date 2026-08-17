"use client";

/**
 * Shared motion engine for the mobile overlay drawers (agent shell rail /
 * workbench pane and the settings nav drawer).
 *
 * - Each drawer has a `progress` in [0, 1] (0 = fully off-screen, 1 = open).
 * - Programmatic opens/closes run a critically damped spring toward the
 *   target, so movement is snappy but has weight.
 * - Swipe gestures pin the drawer to the finger 1:1 while dragging; on
 *   release the spring finishes the motion, seeded with the flick velocity.
 *   Touching mid-animation grabs the drawer wherever it currently is —
 *   everything is interruptible.
 * - Frames are written imperatively (transform / opacity on refs), so no
 *   React re-render happens per frame.
 */

import { useEffect, type RefObject } from "react";

const SPRING_STIFFNESS = 420;
const SPRING_DAMPING = 2 * Math.sqrt(SPRING_STIFFNESS);
/** Progress-per-second flick speed that overrides the halfway-point rule. */
export const FLICK_VELOCITY_THRESHOLD = 1.1;
const MAX_SPRING_VELOCITY = 9;
/** Horizontal movement (px) before a swipe engages. */
export const ENGAGE_DISTANCE_PX = 14;
/** Horizontal dominance required to engage (vs vertical travel). */
export const ENGAGE_DOMINANCE = 1.35;
/** Vertical movement that hands the touch to native scrolling. */
export const SCROLL_CLAIM_PX = 16;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
  );
}

export type DrawerSide = "left" | "right";

/**
 * Imperative spring for one drawer. `apply` receives the current progress and
 * writes styles; `onSettle` fires once motion reaches an endpoint.
 */
export class DrawerMotion {
  progress: number;
  velocity = 0;
  target: number | null = null;
  dragging = false;
  private raf: number | null = null;
  private lastFrameTime = 0;

  constructor(
    initialProgress: number,
    private readonly apply: (progress: number) => void,
    private readonly onSettle: (progress: number) => void
  ) {
    this.progress = initialProgress;
  }

  snapTo(progress: number) {
    this.cancel();
    this.progress = progress;
    this.velocity = 0;
    this.apply(progress);
    this.onSettle(progress);
  }

  beginDrag() {
    this.cancel();
    this.dragging = true;
  }

  dragTo(progress: number, velocity: number) {
    this.progress = Math.min(1, Math.max(0, progress));
    this.velocity = velocity;
    this.apply(this.progress);
  }

  springTo(target: 0 | 1, initialVelocity?: number) {
    this.dragging = false;
    if (prefersReducedMotion()) {
      this.snapTo(target);
      return;
    }
    if (initialVelocity !== undefined) {
      this.velocity = Math.min(
        MAX_SPRING_VELOCITY,
        Math.max(-MAX_SPRING_VELOCITY, initialVelocity)
      );
    }
    if (this.target === target && this.raf != null) {
      return;
    }
    this.target = target;
    if (this.raf == null) {
      if (Math.abs(this.progress - target) < 0.001 && Math.abs(this.velocity) < 0.01) {
        this.snapTo(target);
        return;
      }
      this.lastFrameTime = performance.now();
      this.raf = requestAnimationFrame(this.step);
    }
  }

  cancel() {
    if (this.raf != null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    this.target = null;
    this.dragging = false;
  }

  private step = (now: number) => {
    this.raf = null;
    if (this.target == null) {
      return;
    }
    // Clamp dt so background-tab pauses do not explode the integrator.
    const dt = Math.min(0.032, Math.max(0.001, (now - this.lastFrameTime) / 1000));
    this.lastFrameTime = now;

    const displacement = this.progress - this.target;
    const acceleration = -SPRING_STIFFNESS * displacement - SPRING_DAMPING * this.velocity;
    this.velocity += acceleration * dt;
    this.progress += this.velocity * dt;

    // The drawers must never detach from their screen edge, so overshoot is
    // clipped at the endpoints instead of bouncing past them.
    if (this.progress <= 0) {
      this.progress = 0;
      if (this.target === 0) {
        this.finish();
        return;
      }
      this.velocity = Math.max(0, this.velocity);
    } else if (this.progress >= 1) {
      this.progress = 1;
      if (this.target === 1) {
        this.finish();
        return;
      }
      this.velocity = Math.min(0, this.velocity);
    }

    if (
      Math.abs(this.progress - this.target) < 0.001 &&
      Math.abs(this.velocity) < 0.02
    ) {
      this.finish();
      return;
    }

    this.apply(this.progress);
    this.raf = requestAnimationFrame(this.step);
  };

  private finish() {
    const target = this.target ?? this.progress;
    this.progress = target;
    this.velocity = 0;
    this.target = null;
    this.apply(target);
    this.onSettle(target);
  }
}

/** True when the swipe should be left to the touched content instead of the shell. */
export function gestureBlockedByTarget(
  start: EventTarget | null,
  direction: DrawerSide,
  root: HTMLElement
): boolean {
  let el: Element | null = start instanceof Element ? start : null;
  while (el && el !== root) {
    if (el instanceof HTMLElement) {
      if (
        el.hasAttribute("data-ide-input-sink") ||
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el.isContentEditable
      ) {
        return true;
      }
      const overflowX = getComputedStyle(el).overflowX;
      if (
        (overflowX === "auto" || overflowX === "scroll") &&
        el.scrollWidth > el.clientWidth + 1
      ) {
        const maxScroll = el.scrollWidth - el.clientWidth;
        // A rightward finger travel scrolls content left (needs scrollLeft > 0);
        // leftward travel needs room on the right.
        if (direction === "right" ? el.scrollLeft > 0 : el.scrollLeft < maxScroll - 1) {
          return true;
        }
      }
    }
    el = el.parentElement;
  }
  return false;
}

/**
 * Legacy WebViews (Chromium < 90, e.g. Android 11) do not implement
 * `overflow: clip`, so the class on the shell falls back to `visible` and
 * the parked drawers' overflow propagates to the outer `overflow-hidden`
 * app shell — which IS programmatically scrollable, letting focus/scroll
 * heuristics drag the whole UI sideways off-screen. Fall back to
 * `overflow: hidden` on the shell and pin any scroll back to the origin.
 */
export function useLegacyOverflowClipGuard(shellRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (typeof CSS !== "undefined" && CSS.supports?.("overflow", "clip")) {
      return;
    }
    const shell = shellRef.current;
    if (!shell) {
      return;
    }
    shell.style.overflow = "hidden";
    const guarded = [shell, shell.parentElement].filter(
      (el): el is HTMLElement => el != null
    );
    const pin = (el: HTMLElement) => {
      if (el.scrollLeft !== 0) el.scrollLeft = 0;
      if (el.scrollTop !== 0) el.scrollTop = 0;
    };
    const listeners = guarded.map((el) => {
      const onScroll = () => pin(el);
      el.addEventListener("scroll", onScroll, { passive: true });
      pin(el);
      return () => el.removeEventListener("scroll", onScroll);
    });
    return () => {
      for (const remove of listeners) {
        remove();
      }
      shell.style.overflow = "";
    };
  }, [shellRef]);
}
