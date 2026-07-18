"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { ChevronUp } from "lucide-react";
import { findChatMessageElement } from "@/lib/chat-scroll-anchor";
import type { ChatMessage } from "@/lib/types";
import {
  buildUserMessageTickerItems,
  nearestUserMessageTickerIndex,
  userMessageTickerHoverHeight,
  userMessageTickerHoverProgress,
  userMessageTickerHoverWidth,
  userMessageTickerMarkerCenter,
  userMessageTickerRailHeight,
} from "./user-message-ticker";

interface UserMessageTickerProps {
  messages: ChatMessage[];
  scrollRootRef: RefObject<HTMLDivElement | null>;
  onNavigate: (messageId: string) => void;
  hasOlderHistory?: boolean;
  loadingOlderHistory?: boolean;
  onRequestOlderHistory?: () => void;
}

function findActiveMessageId(
  root: HTMLElement,
  messageIds: string[]
): string | null {
  const rootRect = root.getBoundingClientRect();
  const anchorY = rootRect.top + 18;
  let closestBefore: { id: string; top: number } | null = null;
  let closestAfter: { id: string; top: number } | null = null;

  for (const id of messageIds) {
    const element = findChatMessageElement(root, id);
    if (!element) {
      continue;
    }
    const top = element.getBoundingClientRect().top;
    if (top <= anchorY) {
      if (!closestBefore || top > closestBefore.top) {
        closestBefore = { id, top };
      }
    } else if (!closestAfter || top < closestAfter.top) {
      closestAfter = { id, top };
    }
  }

  return closestBefore?.id ?? closestAfter?.id ?? null;
}

export function UserMessageTicker({
  messages,
  scrollRootRef,
  onNavigate,
  hasOlderHistory = false,
  loadingOlderHistory = false,
  onRequestOlderHistory,
}: UserMessageTickerProps) {
  const items = useMemo(() => buildUserMessageTickerItems(messages), [messages]);
  const messageIds = useMemo(() => items.map((item) => item.id), [items]);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [pointerY, setPointerY] = useState<number | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const activeRafRef = useRef<number | null>(null);
  const hoverRafRef = useRef<number | null>(null);
  const pendingPointerYRef = useRef<number | null>(null);

  const syncActiveMessage = useCallback(() => {
    const root = scrollRootRef.current;
    if (!root) {
      return;
    }
    const next = findActiveMessageId(root, messageIds);
    setActiveMessageId((current) => (current === next ? current : next));
  }, [messageIds, scrollRootRef]);

  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root) {
      return;
    }
    const scheduleSync = () => {
      if (activeRafRef.current != null) {
        return;
      }
      activeRafRef.current = window.requestAnimationFrame(() => {
        activeRafRef.current = null;
        syncActiveMessage();
      });
    };

    scheduleSync();
    root.addEventListener("scroll", scheduleSync, { passive: true });
    window.addEventListener("resize", scheduleSync);
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleSync);
    resizeObserver?.observe(root);

    return () => {
      root.removeEventListener("scroll", scheduleSync);
      window.removeEventListener("resize", scheduleSync);
      resizeObserver?.disconnect();
      if (activeRafRef.current != null) {
        window.cancelAnimationFrame(activeRafRef.current);
        activeRafRef.current = null;
      }
    };
  }, [scrollRootRef, syncActiveMessage]);

  useEffect(
    () => () => {
      if (hoverRafRef.current != null) {
        window.cancelAnimationFrame(hoverRafRef.current);
      }
    },
    []
  );

  if (items.length === 0 && !hasOlderHistory) {
    return null;
  }

  const historyControlHeight = hasOlderHistory ? 18 : 0;
  const railHeight = userMessageTickerRailHeight(items.length);
  const effectivePointerY =
    pointerY ??
    (focusedIndex == null
      ? null
      : userMessageTickerMarkerCenter(focusedIndex, items.length, railHeight));
  const previewIndex =
    pointerY == null
      ? focusedIndex
      : nearestUserMessageTickerIndex(pointerY, items.length, railHeight);
  const previewItem = previewIndex == null ? null : items[previewIndex] ?? null;
  const previewTop =
    previewIndex == null
      ? 0
      : historyControlHeight +
        userMessageTickerMarkerCenter(previewIndex, items.length, railHeight);

  const updatePointerY = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const nextPointerY = Math.max(
      0,
      Math.min(rect.height, event.clientY - rect.top)
    );
    pendingPointerYRef.current = nextPointerY;
    if (hoverRafRef.current != null) {
      return;
    }
    hoverRafRef.current = window.requestAnimationFrame(() => {
      hoverRafRef.current = null;
      setPointerY(pendingPointerYRef.current);
    });
  };

  const clearPointerY = () => {
    pendingPointerYRef.current = null;
    if (hoverRafRef.current != null) {
      window.cancelAnimationFrame(hoverRafRef.current);
      hoverRafRef.current = null;
    }
    setPointerY(null);
  };

  const totalHeight = historyControlHeight + railHeight;

  return (
    <nav
      aria-label="User message navigation"
      data-user-message-ticker
      data-electron-no-drag
      className="pointer-events-none absolute right-[2px] top-1/2 z-40 w-[30px] -translate-y-1/2"
      style={{ height: totalHeight }}
    >
      {hasOlderHistory ? (
        <button
          type="button"
          className="pointer-events-auto absolute right-0 top-0 flex size-[18px] items-center justify-center rounded-[5px] text-[var(--text-disabled)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)] focus-visible:bg-[var(--bg-card-hover)] focus-visible:text-[var(--text-primary)] focus-visible:outline-none"
          onClick={onRequestOlderHistory}
          disabled={loadingOlderHistory || !onRequestOlderHistory}
          aria-label={loadingOlderHistory ? "Loading earlier messages" : "Load earlier messages"}
          title={loadingOlderHistory ? "Loading earlier messages" : "Load earlier messages"}
        >
          <ChevronUp
            className={`size-[12px] ${loadingOlderHistory ? "animate-pulse" : ""}`}
            strokeWidth={1.75}
            aria-hidden
          />
        </button>
      ) : null}

      <div
        className="pointer-events-auto absolute inset-x-0 bottom-0 cursor-pointer touch-none"
        style={{ height: railHeight }}
        onPointerMove={updatePointerY}
        onPointerLeave={clearPointerY}
      >
        {items.map((item, index) => {
          const active = activeMessageId === item.id;
          const previewOpen = previewIndex === index;
          const cellHeight = 100 / items.length;
          const markerCenter = userMessageTickerMarkerCenter(
            index,
            items.length,
            railHeight
          );
          const markerWidth = userMessageTickerHoverWidth(
            markerCenter,
            effectivePointerY
          );
          const markerHeight = userMessageTickerHoverHeight(
            markerCenter,
            effectivePointerY
          );
          const markerProximity = userMessageTickerHoverProgress(
            markerCenter,
            effectivePointerY
          );
          const markerProminent = active || previewOpen;
          return (
            <button
              key={item.id}
              type="button"
              className="group absolute right-0 flex w-[28px] items-center justify-end pr-[2px] focus-visible:outline-none"
              style={{
                top: `${index * cellHeight}%`,
                height: `${cellHeight}%`,
              }}
              onPointerDown={() => setFocusedIndex(null)}
              onFocus={(event) => {
                if (event.currentTarget.matches(":focus-visible")) {
                  setFocusedIndex(index);
                }
              }}
              onBlur={() => setFocusedIndex((current) =>
                current === index ? null : current
              )}
              onClick={() => onNavigate(item.id)}
              aria-label={`Go to user message ${item.ordinal}: ${item.preview}`}
              aria-current={active ? "location" : undefined}
              aria-describedby={previewOpen ? `user-message-preview-${item.id}` : undefined}
            >
              <span
                aria-hidden
                className={`block rounded-full transition-[width,height,background-color,opacity] duration-75 ease-out ${
                  markerProminent
                    ? "bg-[var(--text-primary)] opacity-90"
                    : "bg-[var(--text-secondary)] opacity-45 group-focus-visible:bg-[var(--text-primary)] group-focus-visible:opacity-90"
                }`}
                style={{
                  width: markerWidth,
                  height: markerHeight,
                  opacity: markerProminent ? 0.92 : 0.45 + markerProximity * 0.35,
                }}
              />
            </button>
          );
        })}
      </div>

      {previewItem && previewIndex != null ? (
        <span
          id={`user-message-preview-${previewItem.id}`}
          role="tooltip"
          className="pointer-events-none absolute right-[32px] w-[min(320px,calc(100vw-68px))] -translate-y-1/2 rounded-[var(--agent-card-radius)] border border-[var(--agent-border)] bg-[var(--agent-card-bg)] px-[11px] py-[9px] text-left shadow-[0_8px_28px_rgba(0,0,0,0.22)] transition-[top] duration-75 ease-out"
          style={{ top: previewTop }}
        >
          <span className="mb-[4px] block font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-disabled)]">
            Message {previewItem.ordinal} of {items.length}
          </span>
          <span className="line-clamp-4 block font-sans text-[12px] font-medium leading-[1.45] text-[var(--text-primary)]">
            {previewItem.preview}
          </span>
        </span>
      ) : null}
    </nav>
  );
}
