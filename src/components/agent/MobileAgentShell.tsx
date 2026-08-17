"use client";

/**
 * Mobile agent shell: the workspace rail (left) and workbench pane (right)
 * are overlay drawers driven by a shared spring engine.
 *
 * Motion model
 * - Each drawer has a `progress` in [0, 1] (0 = fully off-screen, 1 = open).
 * - Programmatic opens/closes (buttons, back gestures) run a critically
 *   damped spring toward the target, so movement is snappy but has weight.
 * - Swipe gestures pin the drawer to the finger 1:1 while dragging; on
 *   release the spring finishes the motion, seeded with the flick velocity.
 *   Touching mid-animation grabs the drawer wherever it currently is —
 *   everything is interruptible.
 * - Frames are written imperatively (transform / opacity on refs), so no
 *   React re-render happens per frame. Transforms use percentages of the
 *   drawer's own width, which keeps the math viewport-independent.
 *
 * Gesture rules (deliberately conservative so content interactions never
 * fight the shell):
 * - Right pane open: no swipe gestures at all — it hosts web pages, files and
 *   terminals the user is actively touching.
 * - Left rail open: swipe left anywhere closes it.
 * - Main chat with nothing open: swipe right opens the rail; swipe left opens
 *   the workbench pane (when a real conversation is selected).
 * - Swipes never start from text inputs, the composer, or horizontally
 *   scrollable content that can still consume the swipe direction.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import {
  BACK_INTENT_PRIORITY,
  useBackHandler,
} from "@/components/mobile/BackIntentContext";

const SPRING_STIFFNESS = 420;
const SPRING_DAMPING = 2 * Math.sqrt(SPRING_STIFFNESS);
/** Progress-per-second flick speed that overrides the halfway-point rule. */
const FLICK_VELOCITY_THRESHOLD = 1.1;
const MAX_SPRING_VELOCITY = 9;
/** Horizontal movement (px) before a swipe engages. */
const ENGAGE_DISTANCE_PX = 14;
/** Horizontal dominance required to engage (vs vertical travel). */
const ENGAGE_DOMINANCE = 1.35;
/** Vertical movement that hands the touch to native scrolling. */
const SCROLL_CLAIM_PX = 16;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
  );
}

type DrawerSide = "left" | "right";

/**
 * Imperative spring for one drawer. `apply` receives the current progress and
 * writes styles; `onSettle` fires once motion reaches an endpoint.
 */
class DrawerMotion {
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
function gestureBlockedByTarget(
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

type SwipeAction = "open-left" | "close-left" | "open-right";

type ActiveGesture = {
  touchId: number;
  startX: number;
  startY: number;
  startTarget: EventTarget | null;
  engaged: boolean;
  rejected: boolean;
  action: SwipeAction | null;
  baseProgress: number;
  drawerWidth: number;
  samples: Array<{ t: number; x: number }>;
};

export function MobileAgentShell({
  railOpen,
  rightOpen,
  setRailOpen,
  setRightOpen,
  rightGestureEnabled,
  railWidth,
  rightPaneWidthCss,
  rail,
  rightPane,
  children,
}: {
  railOpen: boolean;
  rightOpen: boolean;
  setRailOpen: (open: boolean) => void;
  setRightOpen: (open: boolean) => void;
  /** Swipe-to-open for the right pane (disabled on the new-chat landing). */
  rightGestureEnabled: boolean;
  railWidth: number;
  rightPaneWidthCss: string;
  rail: ReactNode;
  rightPane: ReactNode;
  children: ReactNode;
}) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const leftDrawerRef = useRef<HTMLDivElement | null>(null);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const rightPaneRef = useRef<HTMLDivElement | null>(null);

  // The rail is heavy, so it mounts only while visible (parity with the old
  // shell); the right pane stays permanently mounted exactly as before.
  const [leftMounted, setLeftMounted] = useState(railOpen);
  const leftMountedRef = useRef(leftMounted);
  leftMountedRef.current = leftMounted;

  const railOpenRef = useRef(railOpen);
  railOpenRef.current = railOpen;
  const rightOpenRef = useRef(rightOpen);
  rightOpenRef.current = rightOpen;
  const rightGestureEnabledRef = useRef(rightGestureEnabled);
  rightGestureEnabledRef.current = rightGestureEnabled;

  const applyLeftFrame = useCallback((progress: number) => {
    const drawer = leftDrawerRef.current;
    if (drawer) {
      drawer.style.transform = `translate3d(${(progress - 1) * 100}%, 0, 0)`;
    }
    const scrim = scrimRef.current;
    if (scrim) {
      scrim.style.opacity = String(progress);
      scrim.style.pointerEvents = progress > 0.05 ? "auto" : "none";
    }
  }, []);

  const applyRightFrame = useCallback((progress: number) => {
    const pane = rightPaneRef.current;
    if (pane) {
      pane.style.transform = `translate3d(${(1 - progress) * 100}%, 0, 0)`;
      pane.style.visibility = progress <= 0.001 ? "hidden" : "visible";
      pane.style.pointerEvents = progress >= 0.999 ? "auto" : "none";
    }
  }, []);

  const leftMotionRef = useRef<DrawerMotion | null>(null);
  const rightMotionRef = useRef<DrawerMotion | null>(null);
  if (leftMotionRef.current == null) {
    leftMotionRef.current = new DrawerMotion(railOpen ? 1 : 0, applyLeftFrame, (progress) => {
      if (progress === 0 && leftMountedRef.current && !railOpenRef.current) {
        setLeftMounted(false);
      }
    });
  }
  if (rightMotionRef.current == null) {
    rightMotionRef.current = new DrawerMotion(rightOpen ? 1 : 0, applyRightFrame, () => undefined);
  }

  // Apply resting styles whenever the drawer nodes (re)mount.
  useLayoutEffect(() => {
    applyLeftFrame(leftMotionRef.current?.progress ?? 0);
  }, [applyLeftFrame, leftMounted]);
  useLayoutEffect(() => {
    applyRightFrame(rightMotionRef.current?.progress ?? 0);
  }, [applyRightFrame]);

  // ---- Android predictive back --------------------------------------------
  //
  // While an Android back gesture is in flight the drawer is pinned to the
  // gesture's progress (1 → 0), exactly like a finger drag on the drawer
  // itself. A committed gesture pops the drawer (spring finishes from wherever
  // the finger left off); a cancelled gesture springs it back open. The rail
  // (a full-backdrop modal drawer) outranks the right pane, matching their
  // visual stacking. Outside the Android shell no gesture stream ever arrives,
  // so only the discrete pop handlers are reachable there.
  useBackHandler(
    railOpen,
    BACK_INTENT_PRIORITY.leftRail,
    () => {
      setRailOpen(false);
      leftMotionRef.current?.springTo(0);
    },
    {
      onStart: () => leftMotionRef.current?.beginDrag(),
      onProgress: (event) => leftMotionRef.current?.dragTo(1 - event.progress, 0),
      onCancel: () => leftMotionRef.current?.springTo(1),
    }
  );
  useBackHandler(
    rightOpen,
    BACK_INTENT_PRIORITY.rightPane,
    () => {
      setRightOpen(false);
      rightMotionRef.current?.springTo(0);
    },
    {
      onStart: () => rightMotionRef.current?.beginDrag(),
      onProgress: (event) => rightMotionRef.current?.dragTo(1 - event.progress, 0),
      onCancel: () => rightMotionRef.current?.springTo(1),
    }
  );

  // Programmatic open/close (buttons, back gestures, external state).
  useEffect(() => {
    const motion = leftMotionRef.current;
    if (!motion || motion.dragging) {
      return;
    }
    if (railOpen) {
      if (!leftMounted) {
        setLeftMounted(true);
        return;
      }
      if (motion.progress < 1 || motion.target != null) {
        motion.springTo(1);
      }
    } else if (motion.progress > 0 || motion.target != null) {
      motion.springTo(0);
    } else if (leftMounted) {
      setLeftMounted(false);
    }
  }, [leftMounted, railOpen]);

  useEffect(() => {
    const motion = rightMotionRef.current;
    if (!motion || motion.dragging) {
      return;
    }
    if (rightOpen) {
      if (motion.progress < 1 || motion.target != null) {
        motion.springTo(1);
      }
    } else if (motion.progress > 0 || motion.target != null) {
      motion.springTo(0);
    }
  }, [rightOpen]);

  // ---- Swipe gestures -----------------------------------------------------

  const gestureRef = useRef<ActiveGesture | null>(null);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }

    const onTouchStart = (event: TouchEvent) => {
      if (gestureRef.current || event.touches.length !== 1) {
        return;
      }
      const touch = event.changedTouches[0];
      gestureRef.current = {
        touchId: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        startTarget: event.target,
        engaged: false,
        rejected: false,
        action: null,
        baseProgress: 0,
        drawerWidth: 1,
        samples: [{ t: performance.now(), x: touch.clientX }],
      };
    };

    const findTouch = (event: TouchEvent, id: number): Touch | null => {
      for (let i = 0; i < event.changedTouches.length; i += 1) {
        if (event.changedTouches[i].identifier === id) {
          return event.changedTouches[i];
        }
      }
      return null;
    };

    const resolveAction = (direction: DrawerSide): SwipeAction | null => {
      const leftProgress = leftMotionRef.current?.progress ?? 0;
      const rightProgress = rightMotionRef.current?.progress ?? 0;
      if (rightProgress > 0.01) {
        // The workbench pane owns the screen: swipes must keep interacting
        // with its content (web pages, files), never close it.
        return null;
      }
      if (leftProgress > 0.01) {
        return direction === "left" ? "close-left" : null;
      }
      if (direction === "right") {
        return "open-left";
      }
      return rightGestureEnabledRef.current ? "open-right" : null;
    };

    const onTouchMove = (event: TouchEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.rejected) {
        return;
      }
      const touch = findTouch(event, gesture.touchId);
      if (!touch) {
        return;
      }
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;
      gesture.samples.push({ t: performance.now(), x: touch.clientX });
      if (gesture.samples.length > 6) {
        gesture.samples.shift();
      }

      if (!gesture.engaged) {
        if (Math.abs(dy) > SCROLL_CLAIM_PX && Math.abs(dy) > Math.abs(dx) * 1.2) {
          gesture.rejected = true;
          return;
        }
        if (
          Math.abs(dx) < ENGAGE_DISTANCE_PX ||
          Math.abs(dx) < Math.abs(dy) * ENGAGE_DOMINANCE
        ) {
          return;
        }
        const direction: DrawerSide = dx > 0 ? "right" : "left";
        const action = resolveAction(direction);
        if (!action || gestureBlockedByTarget(gesture.startTarget, direction, shell)) {
          gesture.rejected = true;
          return;
        }
        const motion =
          action === "open-right" ? rightMotionRef.current : leftMotionRef.current;
        if (!motion) {
          gesture.rejected = true;
          return;
        }
        // Enter drag mode before mounting: the mount-management effect bails
        // on `dragging`, otherwise it would see "rail closed, motion at rest"
        // and unmount the drawer inside the same flush.
        motion.beginDrag();
        if (action === "open-left" && !leftMountedRef.current) {
          // The drawer must exist before the first drag frame lands on it.
          flushSync(() => setLeftMounted(true));
        }
        const drawerEl =
          action === "open-right" ? rightPaneRef.current : leftDrawerRef.current;
        if (!drawerEl) {
          motion.cancel();
          gesture.rejected = true;
          return;
        }
        gesture.engaged = true;
        gesture.action = action;
        gesture.baseProgress = motion.progress;
        gesture.drawerWidth = Math.max(1, drawerEl.getBoundingClientRect().width);
      }

      if (!gesture.engaged || !gesture.action) {
        return;
      }
      event.preventDefault();

      const motion =
        gesture.action === "open-right" ? rightMotionRef.current : leftMotionRef.current;
      if (!motion) {
        return;
      }
      const sign = gesture.action === "open-right" ? -1 : 1;
      const progress = gesture.baseProgress + (sign * dx) / gesture.drawerWidth;
      motion.dragTo(progress, 0);
    };

    const settleGesture = (gesture: ActiveGesture, cancelled: boolean) => {
      if (!gesture.engaged || !gesture.action) {
        return;
      }
      const isRight = gesture.action === "open-right";
      const motion = isRight ? rightMotionRef.current : leftMotionRef.current;
      if (!motion) {
        return;
      }

      // Flick velocity from the recent samples, converted to progress/sec.
      const first = gesture.samples[0];
      const last = gesture.samples[gesture.samples.length - 1];
      const dtMs = Math.max(1, last.t - first.t);
      const pxPerSec = ((last.x - first.x) / dtMs) * 1000;
      const sign = isRight ? -1 : 1;
      const progressVelocity = (sign * pxPerSec) / gesture.drawerWidth;

      let open: boolean;
      if (cancelled) {
        open = isRight ? rightOpenRef.current : railOpenRef.current;
      } else if (Math.abs(progressVelocity) > FLICK_VELOCITY_THRESHOLD) {
        open = progressVelocity > 0;
      } else {
        open = motion.progress > 0.5;
      }

      if (isRight) {
        if (rightOpenRef.current !== open) {
          setRightOpen(open);
        }
      } else if (railOpenRef.current !== open) {
        setRailOpen(open);
      }
      motion.springTo(open ? 1 : 0, progressVelocity);
    };

    // The tracked finger has lifted when it is absent from `touches`; some
    // environments do not reliably list it in `changedTouches`, so check the
    // live touch list instead of the delta list.
    const trackedTouchStillDown = (event: TouchEvent, id: number): boolean => {
      for (let i = 0; i < event.touches.length; i += 1) {
        if (event.touches[i].identifier === id) {
          return true;
        }
      }
      return false;
    };

    const onTouchEnd = (event: TouchEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || trackedTouchStillDown(event, gesture.touchId)) {
        return;
      }
      gestureRef.current = null;
      settleGesture(gesture, false);
    };

    const onTouchCancel = (event: TouchEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || trackedTouchStillDown(event, gesture.touchId)) {
        return;
      }
      gestureRef.current = null;
      settleGesture(gesture, true);
    };

    shell.addEventListener("touchstart", onTouchStart, { passive: true });
    shell.addEventListener("touchmove", onTouchMove, { passive: false });
    shell.addEventListener("touchend", onTouchEnd, { passive: true });
    shell.addEventListener("touchcancel", onTouchCancel, { passive: true });
    return () => {
      shell.removeEventListener("touchstart", onTouchStart);
      shell.removeEventListener("touchmove", onTouchMove);
      shell.removeEventListener("touchend", onTouchEnd);
      shell.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [setRailOpen, setRightOpen]);

  // Legacy WebViews (Chromium < 90, e.g. Android 11) do not implement
  // `overflow: clip`, so the class on the shell falls back to `visible` and
  // the parked drawers' overflow propagates to the outer `overflow-hidden`
  // app shell — which IS programmatically scrollable, letting focus/scroll
  // heuristics drag the whole UI sideways off-screen. Fall back to
  // `overflow: hidden` on the shell and pin any scroll back to the origin.
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
  }, []);

  return (
    // `overflow-clip` (not `hidden`): the parked right pane translated +100%
    // would otherwise create horizontal scrollable overflow that focus/scroll
    // heuristics can drag the whole shell sideways into.
    <div ref={shellRef} className="absolute inset-0 overflow-clip">
      {children}

      {leftMounted ? (
        <>
          <div
            ref={scrimRef}
            className="absolute inset-0 z-30 bg-black/40"
            style={{ opacity: 0, pointerEvents: "none" }}
            onClick={() => setRailOpen(false)}
          />
          <div
            ref={leftDrawerRef}
            data-mobile-drawer="left"
            className="mobile-left-drawer-surface absolute inset-y-0 left-0 z-40 overflow-hidden border-r border-[var(--border-subtle)] shadow-[0_0_40px_rgba(0,0,0,0.35)]"
            style={{
              width: `${railWidth}px`,
              transform: "translate3d(-100%, 0, 0)",
              willChange: "transform",
            }}
          >
            {rail}
          </div>
        </>
      ) : null}

      <div
        ref={rightPaneRef}
        data-mobile-drawer="right"
        className="absolute inset-y-0 right-0 z-40 overflow-hidden border-l border-[var(--border-subtle)] shadow-[-12px_0_36px_rgba(0,0,0,0.28)]"
        style={{
          width: rightPaneWidthCss,
          transform: rightOpen ? "translate3d(0, 0, 0)" : "translate3d(100%, 0, 0)",
          visibility: rightOpen ? "visible" : "hidden",
          pointerEvents: rightOpen ? "auto" : "none",
          willChange: "transform",
        }}
        aria-hidden={!rightOpen}
      >
        {rightPane}
      </div>
    </div>
  );
}
