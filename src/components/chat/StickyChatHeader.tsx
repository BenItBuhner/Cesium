"use client";

import {
  useRef,
  useState,
  useLayoutEffect,
  type ReactNode,
  type RefObject,
} from "react";
import { CHAT_STICKY_RAIL_INSET_PX } from "./chat-sticky-rail";

/** Hard ceiling (px) for user + melded todo to stay sticky. */
const MAX_STICKY_HEIGHT_PX = 560;
/**
 * A pinned header must never cover more than this fraction of the scrollport;
 * beyond it the block scrolls normally instead of overlaying the reply
 * (tool dropdowns, assistant text) that streams in below it.
 */
const MAX_STICKY_VIEWPORT_FRACTION = 0.4;
/** Floor for the viewport-derived cap so compact headers stay sticky in short panes. */
const MIN_STICKY_ALLOWANCE_PX = 200;

function stickyAllowancePx(scrollportHeight: number): number {
  if (scrollportHeight <= 0) {
    return MAX_STICKY_HEIGHT_PX;
  }
  return Math.min(
    MAX_STICKY_HEIGHT_PX,
    Math.max(
      MIN_STICKY_ALLOWANCE_PX,
      Math.round(scrollportHeight * MAX_STICKY_VIEWPORT_FRACTION)
    )
  );
}

interface StickyChatHeaderProps {
  /** Main chat: each user turn participates in sticky stacking; transcript tabs: off. */
  enabled: boolean;
  stackOrder: number;
  /** Pixels to shift this sticky block upward while the next user turn approaches (scroll-driven). */
  pushUpPx?: number;
  registerStickyEl?: (order: number, el: HTMLDivElement | null) => void;
  /** User `ChatMessage.id` for scroll restore / anchor queries on the sticky root. */
  dataChatMessageId?: string;
  /** Scrollport; sizes the sticky allowance so the pinned block cannot eat the whole pane. */
  scrollRootRef?: RefObject<HTMLElement | null>;
  /** Chat surface behind the thread; the pinned block paints it to cleanly mask rows scrolling beneath. */
  surface?: "panel" | "editor";
  children: ReactNode;
}

/**
 * Each user prompt (+ optional melded todo row) uses `position: sticky` with `top` driven by
 * `pushUpPx` so the previous turn slides out progressively instead of being covered by z-index.
 */
export function StickyChatHeader({
  enabled,
  stackOrder,
  pushUpPx = 0,
  registerStickyEl,
  dataChatMessageId,
  scrollRootRef,
  surface = "panel",
  children,
}: StickyChatHeaderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [allowSticky, setAllowSticky] = useState(true);

  useLayoutEffect(() => {
    if (!enabled) {
      setAllowSticky((current) => (current ? current : true));
      return;
    }
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const allowance = stickyAllowancePx(scrollRootRef?.current?.clientHeight ?? 0);
      const nextAllowSticky = el.scrollHeight <= allowance;
      setAllowSticky((current) =>
        current === nextAllowSticky ? current : nextAllowSticky
      );
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const root = scrollRootRef?.current;
    if (root) {
      ro.observe(root);
    }
    return () => ro.disconnect();
  }, [enabled, scrollRootRef]);

  function setRefs(el: HTMLDivElement | null) {
    ref.current = el;
    registerStickyEl?.(stackOrder, el);
  }

  if (!enabled) {
    return (
      <div
        className="shrink-0"
        data-chat-message-id={dataChatMessageId}
        data-electron-no-drag
      >
        {children}
      </div>
    );
  }

  const surfaceColor = surface === "editor" ? "var(--bg-main)" : "var(--bg-panel)";

  return (
    <div
      ref={setRefs}
      data-chat-message-id={dataChatMessageId}
      // While stuck, this element's rect reports the pinned position, not the flow position;
      // scroll anchor/navigation math uses this marker to resolve the true flow top instead.
      data-chat-sticky-header=""
      data-electron-no-drag
      style={
        allowSticky
          ? {
              top: `calc(var(--opencursor-mobile-safe-area-top, 0px) + ${CHAT_STICKY_RAIL_INSET_PX}px - ${pushUpPx}px)`,
            }
          : undefined
      }
      className={
        allowSticky
          ? "sticky z-10 shrink-0 bg-transparent pb-[10px] transition-[top] duration-75"
          : // pb-[10px] must match the sticky branch: measure() reads this
            // element's scrollHeight against the sticky allowance, so a
            // state-dependent padding makes heights near the cap bistable.
            "relative z-10 shrink-0 bg-transparent pb-[10px]"
      }
    >
      {allowSticky ? (
        // Opaque backdrop across the full sticky footprint (rail gap above, todo side
        // gutters, pb strip). Without it, rows sliding under the pinned block bleed
        // through the transparent slivers as clipped text fragments. z-[-1] keeps it
        // under the bubble/todo (this element is a stacking context via z-10) while
        // the whole block still paints above the scrolling tail.
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-[10px] z-[-1]"
            style={{
              top: -CHAT_STICKY_RAIL_INSET_PX,
              backgroundColor: surfaceColor,
            }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 z-[-1] h-[10px]"
            style={{
              backgroundImage: `linear-gradient(to bottom, ${surfaceColor}, transparent)`,
            }}
          />
        </>
      ) : null}
      {children}
    </div>
  );
}
