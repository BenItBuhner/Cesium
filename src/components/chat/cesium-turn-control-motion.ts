"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Bidirectional show/hide motion for the Cesium pause/stop composer pill.
 *
 * Send already looked right because the pill mounted collapsed (send-button
 * sized) and expanded. Stop and draft unmounted it immediately, so the
 * reverse snapped. This planner keeps the pill mounted through collapse and
 * only unmounts after the width transition finishes, and it can reverse
 * mid-flight if the user sends again or clears a draft.
 */

export const CESIUM_TURN_PILL_TRANSITION_MS = 300;

export type CesiumTurnPillMotion = {
  mounted: boolean;
  expanded: boolean;
};

export type CesiumTurnPillMotionPlan = {
  next: CesiumTurnPillMotion;
  expandOnNextFrame: boolean;
  unmountAfterMs: number | null;
};

export function prefersCesiumTurnPillReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
  );
}

export function planCesiumTurnPillMotion(
  wantMounted: boolean,
  wantExpanded: boolean,
  current: CesiumTurnPillMotion
): CesiumTurnPillMotionPlan {
  if (wantMounted) {
    if (!current.mounted) {
      return {
        next: { mounted: true, expanded: false },
        expandOnNextFrame: wantExpanded,
        unmountAfterMs: null,
      };
    }
    if (wantExpanded && !current.expanded) {
      return {
        next: { mounted: true, expanded: current.expanded },
        expandOnNextFrame: true,
        unmountAfterMs: null,
      };
    }
    if (!wantExpanded && current.expanded) {
      return {
        next: { mounted: true, expanded: false },
        expandOnNextFrame: false,
        unmountAfterMs: null,
      };
    }
    return {
      next: current,
      expandOnNextFrame: false,
      unmountAfterMs: null,
    };
  }

  if (!current.mounted) {
    return {
      next: { mounted: false, expanded: false },
      expandOnNextFrame: false,
      unmountAfterMs: null,
    };
  }

  return {
    next: { mounted: true, expanded: false },
    expandOnNextFrame: false,
    unmountAfterMs: CESIUM_TURN_PILL_TRANSITION_MS,
  };
}

export function useCesiumTurnPillMotion(
  wantMounted: boolean,
  wantExpanded: boolean
): CesiumTurnPillMotion {
  const [mounted, setMounted] = useState(wantMounted);
  const [expanded, setExpanded] = useState(false);
  const mountedRef = useRef(mounted);
  const expandedRef = useRef(expanded);
  mountedRef.current = mounted;
  expandedRef.current = expanded;

  useEffect(() => {
    const reduced = prefersCesiumTurnPillReducedMotion();
    const current = {
      mounted: mountedRef.current,
      expanded: expandedRef.current,
    };
    const plan = planCesiumTurnPillMotion(wantMounted, wantExpanded, current);

    if (plan.next.mounted !== current.mounted) {
      setMounted(plan.next.mounted);
    }
    if (!plan.expandOnNextFrame && plan.next.expanded !== current.expanded) {
      setExpanded(plan.next.expanded);
    }

    if (plan.expandOnNextFrame) {
      if (reduced) {
        setExpanded(true);
        return;
      }
      const frame = requestAnimationFrame(() => setExpanded(true));
      return () => cancelAnimationFrame(frame);
    }

    if (plan.unmountAfterMs != null) {
      const delay = reduced ? 0 : plan.unmountAfterMs;
      const timeout = window.setTimeout(() => {
        setMounted(false);
        setExpanded(false);
      }, delay);
      return () => window.clearTimeout(timeout);
    }
  }, [wantMounted, wantExpanded]);

  return { mounted, expanded };
}
