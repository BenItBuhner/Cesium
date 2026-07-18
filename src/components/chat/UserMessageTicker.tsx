"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  AtSign,
  FileText,
  Image as ImageIcon,
  LayoutTemplate,
  MousePointerSquareDashed,
} from "lucide-react";
import { getChatStickyRailInsetPx } from "@/components/chat/chat-sticky-rail";
import {
  buildUserMessageTickerItems,
  findActiveTickerMessageId,
  shouldShowUserMessageTicker,
  type UserMessageTickerAttachmentChip,
  type UserMessageTickerItem,
} from "@/lib/user-message-ticker";
import type { ChatMessage } from "@/lib/types";

const HOVER_OPEN_DELAY_MS = 70;
const HOVER_CLOSE_DELAY_MS = 120;

type PreviewPos = {
  top: number;
  right: number;
  maxHeight: number;
};

function AttachmentChipIcon({
  kind,
  className,
}: {
  kind: UserMessageTickerAttachmentChip["kind"];
  className?: string;
}) {
  const props = { className, strokeWidth: 1.75, "aria-hidden": true as const };
  switch (kind) {
    case "image":
      return <ImageIcon {...props} />;
    case "file":
      return <FileText {...props} />;
    case "context":
      return <AtSign {...props} />;
    case "design":
      return <MousePointerSquareDashed {...props} />;
    case "text-reference":
      return <FileText {...props} />;
    default:
      return <LayoutTemplate {...props} />;
  }
}

function TickerPreviewCard({
  item,
  position,
  ready,
  cardRef,
  labelledBy,
}: {
  item: UserMessageTickerItem;
  position: PreviewPos;
  ready: boolean;
  cardRef: RefObject<HTMLDivElement | null>;
  labelledBy: string;
}) {
  return (
    <div
      ref={cardRef}
      id={labelledBy}
      role="tooltip"
      className="pointer-events-none fixed z-[10040] w-[min(320px,calc(100vw-24px))] overflow-hidden rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-lg"
      style={{
        top: position.top,
        right: position.right,
        maxHeight: position.maxHeight,
        opacity: ready ? 1 : 0,
        visibility: ready ? "visible" : "hidden",
      }}
    >
      <div className="flex max-h-[inherit] flex-col gap-[6px] overflow-hidden px-[12px] py-[10px]">
        <p className="line-clamp-2 font-sans text-[12.5px] font-medium leading-[1.35] text-[var(--text-primary)]">
          {item.userPreview}
        </p>
        {item.assistantPreview ? (
          <p className="line-clamp-3 font-sans text-[12px] font-normal leading-[1.4] text-[var(--text-secondary)]">
            {item.assistantPreview}
          </p>
        ) : null}
        {item.attachments.length > 0 ? (
          <div className="mt-[2px] flex flex-col gap-[4px]">
            {item.attachments.map((chip) => (
              <div
                key={`${chip.kind}:${chip.label}`}
                className="flex min-w-0 items-center gap-[6px] font-sans text-[11.5px] text-[var(--text-secondary)]"
              >
                <AttachmentChipIcon
                  kind={chip.kind}
                  className="size-[12px] shrink-0 text-[var(--text-secondary)]"
                />
                <span className="truncate">{chip.label}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function UserMessageTicker({
  messages,
  scrollRootRef,
  onScrollToMessage,
  bottomDockVisible = true,
}: {
  messages: ChatMessage[];
  scrollRootRef: RefObject<HTMLDivElement | null>;
  onScrollToMessage: (messageId: string) => void;
  bottomDockVisible?: boolean;
}) {
  const items = useMemo(() => buildUserMessageTickerItems(messages), [messages]);
  const visible = shouldShowUserMessageTicker(items.length);
  const tooltipId = useId();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [previewPos, setPreviewPos] = useState<PreviewPos>({
    top: 0,
    right: 8,
    maxHeight: 220,
  });
  const [previewReady, setPreviewReady] = useState(false);
  const [mounted, setMounted] = useState(false);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const tickRefs = useRef(new Map<string, HTMLButtonElement>());
  const cardRef = useRef<HTMLDivElement | null>(null);
  const orderedIds = useMemo(() => items.map((item) => item.messageId), [items]);

  useEffect(() => {
    setMounted(true);
  }, []);

  const clearTimers = useCallback(() => {
    if (openTimerRef.current != null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const repositionPreview = useCallback((messageId: string) => {
    const tick = tickRefs.current.get(messageId);
    if (!tick) {
      return;
    }
    const rect = tick.getBoundingClientRect();
    const gap = 10;
    const edge = 8;
    const spaceAbove = Math.max(120, rect.top - edge);
    const spaceBelow = Math.max(120, window.innerHeight - rect.bottom - edge);
    const preferBelow = spaceBelow >= spaceAbove;
    const maxHeight = Math.min(260, preferBelow ? spaceBelow : spaceAbove);
    const top = preferBelow
      ? Math.min(rect.top, window.innerHeight - maxHeight - edge)
      : Math.max(edge, rect.bottom - maxHeight);
    const right = Math.max(edge, window.innerWidth - rect.left + gap);
    setPreviewPos({ top, right, maxHeight });
    setPreviewReady(true);
  }, []);

  const openPreview = useCallback(
    (messageId: string) => {
      clearTimers();
      openTimerRef.current = window.setTimeout(() => {
        setHoveredId(messageId);
        setPreviewReady(false);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => repositionPreview(messageId));
        });
      }, HOVER_OPEN_DELAY_MS);
    },
    [clearTimers, repositionPreview]
  );

  const closePreview = useCallback(() => {
    clearTimers();
    closeTimerRef.current = window.setTimeout(() => {
      setHoveredId(null);
      setPreviewReady(false);
    }, HOVER_CLOSE_DELAY_MS);
  }, [clearTimers]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  useEffect(() => {
    if (!hoveredId) {
      return;
    }
    const onReposition = () => repositionPreview(hoveredId);
    window.addEventListener("resize", onReposition);
    return () => window.removeEventListener("resize", onReposition);
  }, [hoveredId, repositionPreview]);

  useEffect(() => {
    if (!visible) {
      setActiveId(null);
      return;
    }
    const root = scrollRootRef.current;
    if (!root) {
      return;
    }

    const syncActive = () => {
      const next = findActiveTickerMessageId(
        root,
        orderedIds,
        getChatStickyRailInsetPx()
      );
      setActiveId((current) => (current === next ? current : next));
    };

    syncActive();
    root.addEventListener("scroll", syncActive, { passive: true });
    return () => root.removeEventListener("scroll", syncActive);
  }, [orderedIds, scrollRootRef, visible, messages.length]);

  useEffect(() => {
    if (!hoveredId) {
      return;
    }
    const onScroll = () => {
      setHoveredId(null);
      setPreviewReady(false);
    };
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, [hoveredId]);

  const hoveredItem = useMemo(
    () => (hoveredId ? items.find((item) => item.messageId === hoveredId) ?? null : null),
    [hoveredId, items]
  );

  if (!visible) {
    return null;
  }

  const bottomPad = bottomDockVisible ? "clamp(160px, 24vh, 240px)" : "14px";
  const topPad =
    "calc(var(--opencursor-mobile-safe-area-top, 0px) + 14px)";

  return (
    <>
      <div
        className="pointer-events-none absolute inset-y-0 right-0 z-[4] w-[18px]"
        style={{
          paddingTop: topPad,
          paddingBottom: bottomPad,
        }}
      >
        <div
          className="relative h-full w-full"
          role="navigation"
          aria-label="Jump to user messages"
        >
          {items.map((item, index) => {
            const isActive = activeId === item.messageId;
            const isHovered = hoveredId === item.messageId;
            const topPercent =
              items.length <= 1 ? 0 : (index / (items.length - 1)) * 100;
            const tickWidth = isActive || isHovered ? 11 : 7;
            return (
              <button
                key={item.messageId}
                type="button"
                ref={(el) => {
                  if (el) {
                    tickRefs.current.set(item.messageId, el);
                  } else {
                    tickRefs.current.delete(item.messageId);
                  }
                }}
                className={`pointer-events-auto absolute right-0 flex w-full items-center justify-center rounded-[2px] border-0 bg-transparent p-0 outline-none transition-opacity duration-100 focus-visible:ring-1 focus-visible:ring-[var(--accent)] ${
                  isActive || isHovered ? "opacity-100" : "opacity-55 hover:opacity-90"
                }`}
                style={{
                  top: `${topPercent}%`,
                  height: 16,
                  transform: "translateY(-50%)",
                }}
                aria-label={`Jump to message ${index + 1}: ${item.userPreview}`}
                aria-describedby={isHovered ? tooltipId : undefined}
                onMouseEnter={() => openPreview(item.messageId)}
                onMouseLeave={closePreview}
                onFocus={() => openPreview(item.messageId)}
                onBlur={closePreview}
                onClick={() => {
                  setHoveredId(null);
                  setPreviewReady(false);
                  onScrollToMessage(item.messageId);
                }}
              >
                <span
                  className="block rounded-full"
                  style={{
                    width: tickWidth,
                    height: 2,
                    backgroundColor:
                      isActive || isHovered
                        ? "var(--text-primary)"
                        : "var(--text-secondary)",
                  }}
                />
              </button>
            );
          })}
        </div>
      </div>
      {mounted && hoveredItem
        ? createPortal(
            <TickerPreviewCard
              item={hoveredItem}
              position={previewPos}
              ready={previewReady}
              cardRef={cardRef}
              labelledBy={tooltipId}
            />,
            document.body
          )
        : null}
    </>
  );
}
