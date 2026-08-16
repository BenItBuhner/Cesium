"use client";

import { useEffect, useRef } from "react";
import { VSCodeQuickInputShell } from "./VSCodeQuickInputShell";

/** Row shown in the hold-to-cycle quick switcher (agent conversations and/or editor tabs). */
export type QuickSwitcherItem = {
  id: string;
  title: string;
  kind: "conversation" | "tab";
  /** Muted trailing detail after the title (workspace name, pane label, …). */
  secondary?: string;
  badge?: string;
  /** Relative activity time; omitted for editor tabs. */
  updatedAt?: number;
  /** Editor pane the tab lives in (tab items only). */
  group?: "left" | "right";
  /** Raw editor tab id (tab items only). */
  tabId?: string;
};

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
  listLabel = "Recently used agents",
  emptyLabel = "Nothing to switch",
}: {
  open: boolean;
  items: QuickSwitcherItem[];
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
  onClose: () => void;
  listLabel?: string;
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
      screenReaderTitle="Quick switcher"
      inputLabel={listLabel}
      placeholder=""
      value=""
      onChange={() => undefined}
      onKeyDown={() => undefined}
      footer={
        <p className="font-sans text-[11px] text-[var(--palette-footer-text)]">
          Hold the modifier and tap the key to move · release it or{" "}
          <kbd className={kbdCls}>Enter</kbd> to switch ·{" "}
          <kbd className={kbdCls}>Esc</kbd> to cancel
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
                  {item.secondary ? (
                    <span className={secondaryCls}>{` · ${item.secondary}`}</span>
                  ) : null}
                  {item.badge ? (
                    <span className={`${secondaryCls} uppercase`}>{` · ${item.badge}`}</span>
                  ) : null}
                </span>
                <span
                  className={`shrink-0 whitespace-nowrap font-sans text-[11px] ${secondaryCls}`}
                >
                  {item.updatedAt != null ? formatRelativeTime(item.updatedAt) : ""}
                </span>
              </div>
            );
          })
        )}
      </div>
    </VSCodeQuickInputShell>
  );
}
