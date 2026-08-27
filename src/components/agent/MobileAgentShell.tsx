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
 *   Touching mid-animation grabs the drawer wherever it currently is -
 *   everything is interruptible.
 * - Frames are written imperatively (transform / opacity on refs), so no
 *   React re-render happens per frame. Transforms use percentages of the
 *   drawer's own width, which keeps the math viewport-independent.
 *
 * Gesture rules (deliberately conservative so content interactions never
 * fight the shell):
 * - Right pane open with tabs: no swipe gestures - it hosts web pages, files
 *   and terminals the user is actively touching.
 * - Right pane open with zero tabs: swipe right closes it, same physics as
 *   the other overlays.
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
import {
  DrawerMotion,
  ENGAGE_DISTANCE_PX,
  ENGAGE_DOMINANCE,
  FLICK_VELOCITY_THRESHOLD,
  SCROLL_CLAIM_PX,
  gestureBlockedByTarget,
  isRightPaneSwipeAction,
  resolveAgentShellSwipeAction,
  useLegacyOverflowClipGuard,
  type AgentShellSwipeAction,
  type DrawerSide,
} from "@/components/mobile/drawer-motion";

type SwipeAction = AgentShellSwipeAction;

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
  rightCloseGestureEnabled,
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
  /** Swipe-right-to-close the right pane when it has zero tabs/files open. */
  rightCloseGestureEnabled: boolean;
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
  const rightScrimRef = useRef<HTMLDivElement | null>(null);

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
  const rightCloseGestureEnabledRef = useRef(rightCloseGestureEnabled);
  rightCloseGestureEnabledRef.current = rightCloseGestureEnabled;

  const applyLeftFrame = useCallback((progress: number) => {
    const drawer = leftDrawerRef.current;
    if (drawer) {
      // Drop the resting transform so backdrop-filter can sample the chat
      // instead of the drawer's own empty compositor layer.
      if (progress >= 0.999) {
        drawer.style.transform = "none";
        drawer.style.willChange = "auto";
      } else {
        drawer.style.transform = `translate3d(${(progress - 1) * 100}%, 0, 0)`;
        drawer.style.willChange = "transform";
      }
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
      if (progress >= 0.999) {
        pane.style.transform = "none";
        pane.style.willChange = "auto";
      } else {
        pane.style.transform = `translate3d(${(1 - progress) * 100}%, 0, 0)`;
        pane.style.willChange = "transform";
      }
      pane.style.visibility = progress <= 0.001 ? "hidden" : "visible";
      pane.style.pointerEvents = progress >= 0.999 ? "auto" : "none";
    }
    // Same backdrop treatment as the left rail: a dimming scrim fades in
    // behind the pane, and the pane's own backdrop-filter frost (shared
    // `.mobile-*-drawer-surface` material) samples that dimmed chat.
    const scrim = rightScrimRef.current;
    if (scrim) {
      scrim.style.opacity = String(progress);
      scrim.style.pointerEvents = progress > 0.05 ? "auto" : "none";
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

    const resolveAction = (direction: DrawerSide): SwipeAction | null =>
      resolveAgentShellSwipeAction({
        direction,
        leftProgress: leftMotionRef.current?.progress ?? 0,
        rightProgress: rightMotionRef.current?.progress ?? 0,
        rightOpenGestureEnabled: rightGestureEnabledRef.current,
        rightCloseGestureEnabled: rightCloseGestureEnabledRef.current,
      });

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
        const motion = isRightPaneSwipeAction(action)
          ? rightMotionRef.current
          : leftMotionRef.current;
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
        const drawerEl = isRightPaneSwipeAction(action)
          ? rightPaneRef.current
          : leftDrawerRef.current;
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

      const motion = isRightPaneSwipeAction(gesture.action)
        ? rightMotionRef.current
        : leftMotionRef.current;
      if (!motion) {
        return;
      }
      const sign = isRightPaneSwipeAction(gesture.action) ? -1 : 1;
      const progress = gesture.baseProgress + (sign * dx) / gesture.drawerWidth;
      motion.dragTo(progress, 0);
    };

    const settleGesture = (gesture: ActiveGesture, cancelled: boolean) => {
      if (!gesture.engaged || !gesture.action) {
        return;
      }
      const isRight = isRightPaneSwipeAction(gesture.action);
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

  // Legacy WebViews (Chromium < 90): see useLegacyOverflowClipGuard.
  useLegacyOverflowClipGuard(shellRef);

  return (
    // `overflow-clip` (not `hidden`): the parked right pane translated +100%
    // would otherwise create horizontal scrollable overflow that focus/scroll
    // heuristics can drag the whole shell sideways into.
    <div ref={shellRef} className="absolute inset-0 overflow-clip">
      <div className="absolute inset-0">{children}</div>

      {leftMounted ? (
        <>
          <div
            ref={scrimRef}
            className="absolute inset-0 z-30 bg-[var(--palette-backdrop)]"
            style={{ opacity: 0, pointerEvents: "none" }}
            onClick={() => setRailOpen(false)}
          />
          <div
            ref={leftDrawerRef}
            data-mobile-drawer="left"
            className="mobile-left-drawer-surface absolute inset-y-0 left-0 z-40 overflow-hidden border-r border-[var(--border-subtle)] shadow-[var(--palette-shadow)]"
            style={{
              width: `${railWidth}px`,
              transform: railOpen ? "none" : "translate3d(-100%, 0, 0)",
              willChange: railOpen ? "auto" : "transform",
            }}
          >
            {rail}
          </div>
        </>
      ) : null}

      <div
        ref={rightScrimRef}
        className="absolute inset-0 z-30 bg-[var(--palette-backdrop)]"
        style={{
          opacity: rightOpen ? 1 : 0,
          pointerEvents: rightOpen ? "auto" : "none",
        }}
        onClick={() => setRightOpen(false)}
      />
      <div
        ref={rightPaneRef}
        data-mobile-drawer="right"
        className="mobile-right-drawer-surface absolute inset-y-0 right-0 z-40 border-l border-[var(--border-subtle)] shadow-[-12px_0_36px_rgba(0,0,0,0.28)]"
        style={{
          width: rightPaneWidthCss,
          transform: rightOpen ? "none" : "translate3d(100%, 0, 0)",
          visibility: rightOpen ? "visible" : "hidden",
          pointerEvents: rightOpen ? "auto" : "none",
          willChange: rightOpen ? "auto" : "transform",
        }}
        aria-hidden={!rightOpen}
      >
        <div className="h-full overflow-hidden">{rightPane}</div>
      </div>
    </div>
  );
}
