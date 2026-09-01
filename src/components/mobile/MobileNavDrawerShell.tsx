"use client";

/**
 * Single left nav drawer over full-screen content (the mobile settings view),
 * sharing the agent shell's drawer physics via the DrawerMotion engine:
 *
 * - Swipe right anywhere opens the drawer, pinned to the finger 1:1; the
 *   spring finishes the motion on release, seeded with the flick velocity.
 *   Touching mid-animation grabs the drawer wherever it currently is.
 * - Drawer open: swipe left anywhere closes it; tapping the scrim closes it.
 * - Android predictive back drags the drawer shut frame by frame.
 * - Swipes never start from text inputs or horizontally scrollable content
 *   that can still consume the swipe direction.
 *
 * The drawer + scrim portal to `#cesium-overlay-drawer-root` (the aurora
 * host). Settings lives inside a predictive-back surface that makes
 * in-tree `backdrop-filter` sample an empty layer; portaling as a sibling
 * of that surface puts the frost on the same overlay plane as the agent
 * conversation rail. `document.body` is the fallback if the host is gone.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { useBackHandler } from "@/components/mobile/BackIntentContext";
import {
  DrawerMotion,
  ENGAGE_DISTANCE_PX,
  ENGAGE_DOMINANCE,
  FLICK_VELOCITY_THRESHOLD,
  SCROLL_CLAIM_PX,
  applyOverlayDrawerSurfaceFrame,
  gestureBlockedByTarget,
  useLegacyOverflowClipGuard,
  type DrawerSide,
} from "@/components/mobile/drawer-motion";

type SwipeAction = "open" | "close";

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

export function MobileNavDrawerShell({
  open,
  setOpen,
  backPriority,
  drawerWidth,
  drawerClassName,
  drawer,
  children,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** BACK_INTENT_PRIORITY tier for the drawer's predictive-back layer. */
  backPriority: number;
  drawerWidth: number;
  /** Extra drawer chrome (border, shadow). Frost lives on `.mobile-left-drawer-surface`. */
  drawerClassName: string;
  drawer: ReactNode;
  children: ReactNode;
}) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  // The drawer mounts only while visible, mirroring the agent shell rail.
  const [mounted, setMounted] = useState(open);
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;

  const openRef = useRef(open);
  openRef.current = open;

  const applyFrame = useCallback((progress: number) => {
    applyOverlayDrawerSurfaceFrame(drawerRef.current, progress, "left");
    const scrim = scrimRef.current;
    if (scrim) {
      scrim.style.opacity = String(progress);
      scrim.style.pointerEvents = progress > 0.05 ? "auto" : "none";
    }
  }, []);

  const motionRef = useRef<DrawerMotion | null>(null);
  if (motionRef.current == null) {
    motionRef.current = new DrawerMotion(open ? 1 : 0, applyFrame, (progress) => {
      if (progress === 0 && mountedRef.current && !openRef.current) {
        setMounted(false);
      }
    });
  }

  // Apply resting styles whenever the drawer node (re)mounts / portals.
  useLayoutEffect(() => {
    applyFrame(motionRef.current?.progress ?? 0);
  }, [applyFrame, mounted, portalTarget]);

  // Android predictive back drags the drawer shut 1:1 with the gesture;
  // commit pops it, cancel springs it back open.
  useBackHandler(
    open,
    backPriority,
    () => {
      setOpen(false);
      motionRef.current?.springTo(0);
    },
    {
      onStart: () => motionRef.current?.beginDrag(),
      onProgress: (event) => motionRef.current?.dragTo(1 - event.progress, 0),
      onCancel: () => motionRef.current?.springTo(1),
    }
  );

  // Programmatic open/close (buttons, back gestures, external state).
  useEffect(() => {
    const motion = motionRef.current;
    if (!motion || motion.dragging) {
      return;
    }
    if (open) {
      if (!mounted) {
        setMounted(true);
        return;
      }
      if (motion.progress < 1 || motion.target != null) {
        motion.springTo(1);
      }
    } else if (motion.progress > 0 || motion.target != null) {
      motion.springTo(0);
    } else if (mounted) {
      setMounted(false);
    }
  }, [mounted, open]);

  // ---- Swipe gestures -----------------------------------------------------

  const gestureRef = useRef<ActiveGesture | null>(null);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }
    const overlayNodes = [drawerRef.current, scrimRef.current].filter(
      (el): el is HTMLDivElement => el != null
    );
    const gestureRoots = [shell, ...overlayNodes];

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
      const progress = motionRef.current?.progress ?? 0;
      if (progress > 0.01) {
        return direction === "left" ? "close" : null;
      }
      return direction === "right" ? "open" : null;
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
        const motion = motionRef.current;
        if (!motion) {
          gesture.rejected = true;
          return;
        }
        // Enter drag mode before mounting: the mount-management effect bails
        // on `dragging`, otherwise it would see "drawer closed, motion at
        // rest" and unmount the drawer inside the same flush.
        motion.beginDrag();
        if (action === "open" && !mountedRef.current) {
          // The drawer must exist before the first drag frame lands on it.
          flushSync(() => setMounted(true));
        }
        const drawerEl = drawerRef.current;
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

      const motion = motionRef.current;
      if (!motion) {
        return;
      }
      const progress = gesture.baseProgress + dx / gesture.drawerWidth;
      motion.dragTo(progress, 0);
    };

    const settleGesture = (gesture: ActiveGesture, cancelled: boolean) => {
      if (!gesture.engaged || !gesture.action) {
        return;
      }
      const motion = motionRef.current;
      if (!motion) {
        return;
      }

      // Flick velocity from the recent samples, converted to progress/sec.
      const first = gesture.samples[0];
      const last = gesture.samples[gesture.samples.length - 1];
      const dtMs = Math.max(1, last.t - first.t);
      const pxPerSec = ((last.x - first.x) / dtMs) * 1000;
      const progressVelocity = pxPerSec / gesture.drawerWidth;

      let shouldOpen: boolean;
      if (cancelled) {
        shouldOpen = openRef.current;
      } else if (Math.abs(progressVelocity) > FLICK_VELOCITY_THRESHOLD) {
        shouldOpen = progressVelocity > 0;
      } else {
        shouldOpen = motion.progress > 0.5;
      }

      if (openRef.current !== shouldOpen) {
        setOpen(shouldOpen);
      }
      motion.springTo(shouldOpen ? 1 : 0, progressVelocity);
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

    for (const root of gestureRoots) {
      root.addEventListener("touchstart", onTouchStart, { passive: true });
      root.addEventListener("touchmove", onTouchMove, { passive: false });
      root.addEventListener("touchend", onTouchEnd, { passive: true });
      root.addEventListener("touchcancel", onTouchCancel, { passive: true });
    }
    return () => {
      for (const root of gestureRoots) {
        root.removeEventListener("touchstart", onTouchStart);
        root.removeEventListener("touchmove", onTouchMove);
        root.removeEventListener("touchend", onTouchEnd);
        root.removeEventListener("touchcancel", onTouchCancel);
      }
    };
  }, [mounted, portalTarget, setOpen]);

  // Legacy WebViews (Chromium < 90): see useLegacyOverflowClipGuard.
  useLegacyOverflowClipGuard(shellRef);

  useLayoutEffect(() => {
    setPortalTarget(
      document.getElementById("cesium-overlay-drawer-root") ?? document.body
    );
  }, []);

  const overlay =
    mounted && portalTarget
      ? createPortal(
          <>
            <div
              ref={scrimRef}
              className="absolute inset-0 z-30 bg-[var(--palette-backdrop)]"
              style={{ opacity: 0, pointerEvents: "none" }}
              onClick={() => setOpen(false)}
            />
            <div
              ref={drawerRef}
              data-mobile-drawer="left"
              className={`mobile-left-drawer-surface absolute inset-y-0 left-0 z-40 overflow-hidden ${drawerClassName}`}
              style={{
                width: `${drawerWidth}px`,
                transform: open ? "none" : "translate3d(-100%, 0, 0)",
                willChange: open ? "auto" : "transform",
              }}
            >
              {drawer}
            </div>
          </>,
          portalTarget
        )
      : null;

  return (
    // `overflow-clip` so in-tree leftovers can never become scrollable area
    // that focus/scroll heuristics drag into view. The drawer itself is
    // portaled out of this clip so its frost can sample the page.
    <div ref={shellRef} className="relative h-full min-h-0 w-full overflow-clip">
      {children}
      {overlay}
    </div>
  );
}
