"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronDown,
  FolderOpen,
  ScrollText,
} from "lucide-react";
import { CollapsibleHeight } from "./CollapsibleHeight";
import type { WorkedSessionEntry } from "@/lib/types";

const iconWrap =
  "mt-[2px] flex size-[14px] shrink-0 items-center justify-center text-[var(--text-secondary)]";

const toolStatusClass: Record<
  NonNullable<Extract<WorkedSessionEntry, { kind: "tool" }>["status"]>,
  string
> = {
  pending:
    "border-[color-mix(in_srgb,var(--border-card)_80%,transparent)] bg-[color-mix(in_srgb,var(--bg-card)_82%,transparent)] text-[var(--text-secondary)]",
  running:
    "border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] text-[var(--accent-text)]",
  completed:
    "border-[color-mix(in_srgb,#4ade80_35%,transparent)] bg-[color-mix(in_srgb,#4ade80_12%,transparent)] text-[#86efac]",
  failed:
    "border-[color-mix(in_srgb,#fb7185_35%,transparent)] bg-[color-mix(in_srgb,#fb7185_12%,transparent)] text-[#fda4af]",
  cancelled:
    "border-[color-mix(in_srgb,#f59e0b_35%,transparent)] bg-[color-mix(in_srgb,#f59e0b_12%,transparent)] text-[#fcd34d]",
};

function isToolEntryActive(entry: WorkedSessionEntry): boolean {
  return (
    entry.kind === "tool" &&
    (entry.status === "pending" || entry.status === "running")
  );
}

interface WorkedSessionCardProps {
  label: string;
  entries: WorkedSessionEntry[];
  /** When set with `onOpenChange`, expansion is controlled by the parent (persisted). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** @deprecated Use `open` + `onOpenChange`; still seeds uncontrolled initial state. */
  defaultOpen?: boolean;
  loading?: boolean;
  surface?: "panel" | "editor";
  /**
   * When false, header/tool loading shimmer only reflects local `loading` / active tools,
   * not “superseded” sessions after permission or a newer worked block.
   */
  isLiveWorkedTail?: boolean;
}

const ENTRY_LIST_MAX_HEIGHT = 240;
const NEAR_BOTTOM_PX = 48;
const STICK_SETTLE_MS = 80;

function prefersScrollInstant(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function WorkedSessionCard({
  label,
  entries,
  open: controlledOpen,
  onOpenChange,
  defaultOpen = false,
  loading = false,
  surface = "panel",
  isLiveWorkedTail = true,
}: WorkedSessionCardProps) {
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = isControlled ? controlledOpen! : uncontrolledOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (isControlled) {
        onOpenChange?.(next);
      } else {
        setUncontrolledOpen(next);
      }
    },
    [isControlled, onOpenChange]
  );
  const hasActiveTool = entries.some((entry) => isToolEntryActive(entry));
  const showLoadingState = loading || hasActiveTool;
  const shimmerLoading = showLoadingState && isLiveWorkedTail;
  const isWorkingPlaceholder = showLoadingState && entries.length === 0;
  const collapsibleOpen = isWorkingPlaceholder ? true : open;
  const gradientVar = surface === "editor" ? "var(--bg-main)" : "var(--bg-panel)";
  const prevMessageLoadingRef = useRef(loading);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentMeasureRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const stickSettleTimerRef = useRef<number | null>(null);
  const touchLastYRef = useRef<number | null>(null);
  const [showTopGrad, setShowTopGrad] = useState(false);
  const [showBottomGrad, setShowBottomGrad] = useState(false);

  // Collapse only when the *message-level* working placeholder (`loading`) clears — not when an
  // individual tool flips running→completed (that falsely fired for file-edit and other fast tools).
  useEffect(() => {
    if (prevMessageLoadingRef.current && !loading) {
      setOpen(false);
    }
    prevMessageLoadingRef.current = loading;
  }, [loading, setOpen]);

  const updateGradients = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atTop = el.scrollTop > 2;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight > 2;
    setShowTopGrad(atTop);
    setShowBottomGrad(atBottom);
  }, []);

  const clearStickSettleTimer = useCallback(() => {
    if (stickSettleTimerRef.current != null) {
      window.clearTimeout(stickSettleTimerRef.current);
      stickSettleTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!collapsibleOpen) {
      clearStickSettleTimer();
    }
  }, [collapsibleOpen, clearStickSettleTimer]);

  const scheduleStickToBottomSettle = useCallback(
    (el: HTMLDivElement) => {
      if (stickSettleTimerRef.current != null) {
        window.clearTimeout(stickSettleTimerRef.current);
      }
      stickSettleTimerRef.current = window.setTimeout(() => {
        stickSettleTimerRef.current = null;
        const nearBottom =
          el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
        stickToBottomRef.current = nearBottom;
      }, STICK_SETTLE_MS);
    },
    []
  );

  const scrollListToBottomIfFollowing = useCallback(() => {
    const el = scrollRef.current;
    if (!collapsibleOpen || !el || !stickToBottomRef.current) {
      return;
    }
    const behavior = prefersScrollInstant() ? ("auto" as const) : ("smooth" as const);
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, [collapsibleOpen]);

  useLayoutEffect(() => {
    if (!collapsibleOpen) {
      return;
    }
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    stickToBottomRef.current = nearBottom;
  }, [collapsibleOpen]);

  useEffect(() => {
    if (!collapsibleOpen) return;
    updateGradients();
  }, [entries, collapsibleOpen, updateGradients]);

  useEffect(() => {
    if (!collapsibleOpen) return;
    const scrollEl = scrollRef.current;
    const contentEl = contentMeasureRef.current;
    if (!scrollEl || !contentEl) return;

    const ro = new ResizeObserver(() => {
      scrollListToBottomIfFollowing();
      updateGradients();
    });
    ro.observe(contentEl);
    return () => ro.disconnect();
  }, [collapsibleOpen, scrollListToBottomIfFollowing, updateGradients]);

  useEffect(
    () => () => {
      clearStickSettleTimer();
    },
    [clearStickSettleTimer]
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (e.deltaY < -0.5) {
        stickToBottomRef.current = false;
        clearStickSettleTimer();
      }
    },
    [clearStickSettleTimer]
  );

  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    touchLastYRef.current = e.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMove = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      const y = e.touches[0]?.clientY;
      if (y == null || touchLastYRef.current == null) return;
      if (y - touchLastYRef.current > 12) {
        stickToBottomRef.current = false;
        clearStickSettleTimer();
      }
      touchLastYRef.current = y;
    },
    [clearStickSettleTimer]
  );

  const handleTouchEnd = useCallback(() => {
    touchLastYRef.current = null;
  }, []);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      scheduleStickToBottomSettle(el);
      updateGradients();
    },
    [scheduleStickToBottomSettle, updateGradients]
  );

  return (
    <div className="min-w-0 px-[1px]">
      {isWorkingPlaceholder ? (
        <div className="flex w-full min-w-0 items-center gap-[6px] text-left text-[var(--text-secondary)]">
          <span
            className={`font-sans text-[13px] font-normal leading-snug ${
              shimmerLoading ? "tool-loading-text" : ""
            }`}
          >
            {label}
          </span>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex w-full min-w-0 cursor-pointer items-center gap-[6px] text-left text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        >
          <span
            className={`font-sans text-[13px] font-normal leading-snug ${
              shimmerLoading ? "tool-loading-text" : ""
            }`}
          >
            {label}
          </span>
          <ChevronDown
            className={`size-[14px] shrink-0 transition-transform duration-300 ease-[cubic-bezier(0.33,1,0.68,1)] motion-reduce:transition-none ${
              open ? "rotate-180" : ""
            }`}
            strokeWidth={1.75}
            aria-hidden
          />
        </button>
      )}

      <CollapsibleHeight open={collapsibleOpen}>
        <div className="relative pt-[10px]">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            onWheel={handleWheel}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
            className="ml-[2px] border-l border-[var(--border-subtle)] pl-[10px] overflow-y-auto hide-scrollbar-y"
            style={{ maxHeight: ENTRY_LIST_MAX_HEIGHT }}
          >
            <div ref={contentMeasureRef} className="flex flex-col gap-[14px]">
              {entries.map((entry, i) => (
                <WorkedEntryBlock
                  key={
                    entry.kind === "tool"
                      ? entry.toolCallId ?? `tool-${i}-${entry.title}`
                      : `${entry.kind}-${i}`
                  }
                  entry={entry}
                  isLiveWorkedTail={isLiveWorkedTail}
                />
              ))}
            </div>
          </div>
          {showTopGrad ? (
            <div
              className="pointer-events-none absolute inset-x-0 top-[10px] ml-[2px] h-[28px] z-[1] bg-gradient-to-b to-transparent"
              style={{ backgroundImage: `linear-gradient(to bottom, ${gradientVar}, transparent)` }}
            />
          ) : null}
          {showBottomGrad ? (
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 ml-[2px] h-[28px] z-[1] bg-gradient-to-b from-transparent"
              style={{ backgroundImage: `linear-gradient(to bottom, transparent, ${gradientVar})` }}
            />
          ) : null}
        </div>
      </CollapsibleHeight>
    </div>
  );
}

function WorkedEntryBlock({
  entry,
  isLiveWorkedTail,
}: {
  entry: WorkedSessionEntry;
  isLiveWorkedTail: boolean;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      className={`transition-all duration-300 ease-out motion-reduce:transition-none motion-reduce:opacity-100 motion-reduce:translate-y-0 ${
        visible ? "translate-y-0 opacity-100" : "translate-y-[6px] opacity-0"
      }`}
    >
      {renderEntry(entry, isLiveWorkedTail)}
    </div>
  );
}

function renderEntry(entry: WorkedSessionEntry, isLiveWorkedTail: boolean) {
  switch (entry.kind) {
    case "verbatim":
      return (
        <div className="flex gap-[8px]">
          <span className={iconWrap}>
            <ScrollText className="size-[14px]" strokeWidth={1.5} aria-hidden />
          </span>
          <pre className="whitespace-pre-wrap font-mono text-[12px] font-normal leading-relaxed text-[var(--text-secondary)]">
            {entry.text}
          </pre>
        </div>
      );
    case "explore":
      return (
        <div className="flex gap-[8px]">
          <span className={iconWrap}>
            <FolderOpen className="size-[14px]" strokeWidth={1.5} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-sans text-[12px] font-medium text-[var(--text-secondary)]">
              {entry.caption ?? `Explored ${entry.paths.length} file${entry.paths.length === 1 ? "" : "s"}`}
            </p>
            <ul className="mt-[6px] flex list-none flex-col gap-[4px]">
              {entry.paths.map((path) => (
                <li
                  key={path}
                  className="font-mono text-[12px] font-normal leading-snug text-[var(--text-secondary)]"
                >
                  {path}
                </li>
              ))}
            </ul>
          </div>
        </div>
      );
    case "reasoning":
      return (
        <div className="flex gap-[8px]">
          <div className="min-w-0 flex-1">
            <p className="font-sans text-[13px] font-normal leading-relaxed text-[var(--text-primary)]">
              <span className="text-[var(--text-secondary)]">Thought: </span>
              {entry.text}
            </p>
          </div>
        </div>
      );
    case "assistant_inline":
      return (
        <div className="flex gap-[8px]">
          <div className="min-w-0 flex-1">
            <p className="font-sans text-[13px] font-normal leading-relaxed text-[var(--text-primary)]">
              {entry.text}
            </p>
          </div>
        </div>
      );
    case "tool": {
      const active = isToolEntryActive(entry);
      const statusKey =
        entry.status === "failed" || entry.status === "cancelled"
          ? entry.status
          : null;
      return (
        <div className="flex gap-[8px]">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-[8px]">
              <p
                className={`font-sans text-[13px] font-normal ${
                  active && isLiveWorkedTail
                    ? "tool-loading-text"
                    : active
                      ? "text-[var(--text-primary)]"
                      : entry.status === "failed"
                      ? "text-[#fda4af]"
                      : entry.status === "cancelled"
                        ? "text-[#fcd34d]"
                        : "text-[var(--text-primary)]"
                }`}
              >
                {entry.title}
              </p>
              {statusKey ? (
                <span
                  className={`rounded-full border px-[7px] py-[1px] font-sans text-[10px] font-medium uppercase tracking-[0.08em] ${toolStatusClass[statusKey]}`}
                >
                  {statusKey}
                </span>
              ) : null}
            </div>
            {entry.detail?.trim() ? (
              <p className="mt-[4px] line-clamp-4 font-sans text-[12px] font-normal leading-relaxed text-[var(--text-secondary)]">
                {entry.detail}
              </p>
            ) : null}
            {entry.files?.length ? (
              <ul className="mt-[6px] flex list-none flex-col gap-[4px]">
                {entry.files.map((file) => (
                  <li
                    key={file}
                    className="font-mono text-[12px] font-normal leading-snug text-[var(--text-secondary)]"
                  >
                    {file}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      );
    }
  }
}
