"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { ChevronUp } from "lucide-react";
import { findChatMessageElement } from "@/lib/chat-scroll-anchor";
import type { ChatMessage } from "@/lib/types";
import {
  buildUserMessageTickerItems,
  userMessageTickerMarkerWidth,
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
  const [previewMessageId, setPreviewMessageId] = useState<string | null>(null);
  const rafRef = useRef<number | null>(null);

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
      if (rafRef.current != null) {
        return;
      }
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
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
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [scrollRootRef, syncActiveMessage]);

  if (items.length === 0 && !hasOlderHistory) {
    return null;
  }

  const historyControlHeight = hasOlderHistory ? 18 : 0;
  const railHeight = Math.min(
    420,
    Math.max(30, items.length * 10 + historyControlHeight)
  );

  return (
    <nav
      aria-label="User message navigation"
      data-user-message-ticker
      data-electron-no-drag
      className="pointer-events-none absolute right-[2px] top-1/2 z-40 w-[26px] -translate-y-1/2"
      style={{ height: railHeight }}
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
        className="absolute inset-x-0 bottom-0"
        style={{ top: historyControlHeight }}
      >
        {items.map((item, index) => {
          const active = activeMessageId === item.id;
          const previewOpen = previewMessageId === item.id;
          const cellHeight = 100 / items.length;
          return (
            <button
              key={item.id}
              type="button"
              className="group pointer-events-auto absolute right-0 flex w-[24px] items-center justify-end pr-[2px] focus-visible:outline-none"
              style={{
                top: `${index * cellHeight}%`,
                height: `${cellHeight}%`,
              }}
              onMouseEnter={() => setPreviewMessageId(item.id)}
              onMouseLeave={() => setPreviewMessageId((current) =>
                current === item.id ? null : current
              )}
              onFocus={() => setPreviewMessageId(item.id)}
              onBlur={() => setPreviewMessageId((current) =>
                current === item.id ? null : current
              )}
              onClick={() => onNavigate(item.id)}
              aria-label={`Go to user message ${item.ordinal}: ${item.preview}`}
              aria-current={active ? "location" : undefined}
              aria-describedby={previewOpen ? `user-message-preview-${item.id}` : undefined}
            >
              <span
                aria-hidden
                className={`block h-[2px] rounded-full transition-[width,background-color,opacity] duration-150 ${
                  active
                    ? "bg-[var(--text-primary)] opacity-90"
                    : "bg-[var(--text-secondary)] opacity-45 group-hover:bg-[var(--text-primary)] group-hover:opacity-90 group-focus-visible:bg-[var(--text-primary)] group-focus-visible:opacity-90"
                }`}
                style={{
                  width: userMessageTickerMarkerWidth(item.preview) + (active ? 2 : 0),
                }}
              />

              {previewOpen ? (
                <span
                  id={`user-message-preview-${item.id}`}
                  role="tooltip"
                  className="pointer-events-none absolute right-[28px] top-1/2 w-[min(320px,calc(100vw-64px))] -translate-y-1/2 rounded-[var(--agent-card-radius)] border border-[var(--agent-border)] bg-[var(--agent-card-bg)] px-[11px] py-[9px] text-left shadow-[0_8px_28px_rgba(0,0,0,0.22)]"
                >
                  <span className="mb-[4px] block font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-disabled)]">
                    Message {item.ordinal} of {items.length}
                  </span>
                  <span className="line-clamp-4 block font-sans text-[12px] font-medium leading-[1.45] text-[var(--text-primary)]">
                    {item.preview}
                  </span>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
