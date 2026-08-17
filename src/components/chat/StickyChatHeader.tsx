"use client";

import {
  useRef,
  useState,
  useLayoutEffect,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import {
  CHAT_STICKY_RAIL_INSET_PX,
  getChatStickyRailInsetPx,
} from "./chat-sticky-rail";

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
  /** Scrollport; sizes the sticky allowance and anchors pinned-state detection. */
  scrollRootRef?: RefObject<HTMLElement | null>;
  /** Chat surface behind the thread; the veil paints it while the header is pinned. */
  surface?: "panel" | "editor";
  children: ReactNode;
}

/**
 * Each user prompt (+ optional melded todo row) uses `position: sticky` with `top` driven by
 * `pushUpPx` so the previous turn slides out progressively instead of being covered by z-index.
 *
 * While (and only while) the header is actually pinned, a `.chat-sticky-veil` layer masks the
 * rows scrolling beneath it; at flow position nothing extra is painted, so the thread stays
 * untouched over flat and aurora surfaces alike. Pinned-state detection uses a zero-net-height
 * sentinel at the header's flow top + IntersectionObserver (no scroll listeners).
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
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [allowSticky, setAllowSticky] = useState(true);
  const [stuck, setStuck] = useState(false);

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

  useLayoutEffect(() => {
    if (!enabled) {
      setStuck((current) => (current ? false : current));
      return;
    }
    const sentinel = sentinelRef.current;
    const root = scrollRootRef?.current ?? null;
    if (!sentinel || !root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        // Pinned = the flow-top sentinel has crossed above the rail line (not merely
        // scrolled out below the viewport).
        const rootTop = entry.rootBounds?.top ?? 0;
        const next = !entry.isIntersecting && entry.boundingClientRect.top < rootTop;
        setStuck((current) => (current === next ? current : next));
      },
      {
        root,
        rootMargin: `-${getChatStickyRailInsetPx() + 1}px 0px 0px 0px`,
        threshold: 0,
      }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
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

  return (
    <>
      {/* Flow-top marker for pinned detection. The negative margin cancels the 1px box plus
          the segment's 10px column gap, so the header's layout is byte-identical with or
          without the sentinel. */}
      <div
        ref={sentinelRef}
        aria-hidden
        className="h-[1px] w-full shrink-0 -mb-[11px]"
      />
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
        {allowSticky && stuck ? (
          <div
            aria-hidden
            className="chat-sticky-veil pointer-events-none absolute inset-x-0 bottom-0 z-[-1]"
            style={
              {
                // Reach the scrollport's top edge so nothing peeks through the rail gap
                // above the pinned bubble.
                top: `calc(-1 * (var(--opencursor-mobile-safe-area-top, 0px) + ${CHAT_STICKY_RAIL_INSET_PX}px))`,
                "--chat-sticky-surface":
                  surface === "editor" ? "var(--bg-main)" : "var(--bg-panel)",
              } as CSSProperties
            }
          />
        ) : null}
        {children}
      </div>
    </>
  );
}
