"use client";

import { useEffect, useRef } from "react";
import type { AgentSwitcherCandidate } from "@/lib/agent-conversation-mru";
import { VSCodeQuickInputShell } from "./VSCodeQuickInputShell";

const rowBase =
  "flex w-full cursor-pointer items-center gap-[10px] px-[10px] py-[5px] text-left font-sans text-[13px] outline-none";

const kbdCls =
  "rounded border border-[var(--palette-kbd-border)] bg-[var(--palette-kbd-bg)] px-[5px] py-[1px] font-mono text-[10px] text-[var(--palette-kbd-text)]";

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

export function AgentSwitcherPalette({
  open,
  items,
  selectedIndex,
  onSelectedIndexChange,
  onClose,
  emptyLabel = "No agents to switch",
}: {
  open: boolean;
  items: AgentSwitcherCandidate[];
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
  onClose: () => void;
  emptyLabel?: string;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || items.length === 0) return;
    const root = listRef.current;
    if (!root) return;
    const option = root.querySelector<HTMLElement>(
      `[role="option"][aria-selected="true"]`
    );
    option?.scrollIntoView({ block: "nearest" });
  }, [items.length, open, selectedIndex]);

  return (
    <VSCodeQuickInputShell
      open={open}
      onClose={onClose}
      hideInput
      screenReaderTitle="Switch agent"
      inputLabel="Recently used agents"
      placeholder=""
      value=""
      onChange={() => undefined}
      onKeyDown={() => undefined}
      footer={
        <p className="font-sans text-[11px] text-[var(--palette-footer-text)]">
          Hold <kbd className={kbdCls}>Ctrl</kbd> and tap <kbd className={kbdCls}>Tab</kbd> to
          move · release <kbd className={kbdCls}>Ctrl</kbd> or <kbd className={kbdCls}>Enter</kbd>{" "}
          to switch · <kbd className={kbdCls}>Esc</kbd> to cancel
        </p>
      }
    >
      <div
        ref={listRef}
        className="hide-scrollbar-y max-h-[min(360px,42vh)] min-h-[120px] overflow-y-auto py-[4px]"
        role="listbox"
        aria-activedescendant={
          items.length > 0 ? `agent-switcher-option-${selectedIndex}` : undefined
        }
      >
        {items.length === 0 ? (
          <p className="px-[10px] py-[12px] font-sans text-[13px] text-[var(--palette-row-muted)]">
            {emptyLabel}
          </p>
        ) : (
          items.map((item, index) => {
            const on = index === selectedIndex;
            const secondaryCls = on
              ? "text-[var(--palette-row-selected-muted)]"
              : "text-[var(--palette-row-muted)]";
            return (
              <div
                key={item.id}
                id={`agent-switcher-option-${index}`}
                role="option"
                aria-selected={on}
                className={`${rowBase} ${
                  on
                    ? "bg-[var(--palette-row-selected-bg)] text-[var(--palette-row-selected-text)]"
                    : "text-[var(--palette-row-text)]"
                }`}
                onMouseEnter={() => onSelectedIndexChange(index)}
              >
                <span
                  className={`min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-sans text-[13px] ${
                    on
                      ? "text-[var(--palette-row-selected-text)]"
                      : "text-[var(--palette-row-text)]"
                  }`}
                >
                  {item.title}
                  {item.workspaceName ? (
                    <span className={secondaryCls}>{` · ${item.workspaceName}`}</span>
                  ) : null}
                  {item.badge ? (
                    <span className={`${secondaryCls} uppercase`}>{` · ${item.badge}`}</span>
                  ) : null}
                </span>
                <span
                  className={`shrink-0 whitespace-nowrap font-sans text-[11px] ${secondaryCls}`}
                >
                  {formatRelativeTime(item.updatedAt)}
                </span>
              </div>
            );
          })
        )}
      </div>
    </VSCodeQuickInputShell>
  );
}
