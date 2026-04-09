"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { TextSurfaceController } from "@/components/input/HardwareAwareTextField";
import { VSCodeQuickInputShell } from "./VSCodeQuickInputShell";

const rowBase =
  "flex w-full cursor-pointer items-center gap-[10px] px-[10px] py-[5px] text-left font-sans text-[13px] outline-none";

export type RecentChatOption = {
  id: string;
  title: string;
  updatedAt: number;
  detail?: string;
  badge?: string;
};

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

export function RecentChatsModal({
  emptyLabel = "No recent chats",
  inputLabel = "Search recent chats",
  items,
  open,
  onClose,
  placeholder = "Search recent chats...",
  screenReaderTitle = "Recent chats",
  onSelectConversation,
}: {
  emptyLabel?: string;
  inputLabel?: string;
  items: RecentChatOption[];
  open: boolean;
  onClose: () => void;
  placeholder?: string;
  screenReaderTitle?: string;
  onSelectConversation: (conversationId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => {
      const hay = `${item.title}\n${item.detail ?? ""}\n${item.badge ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [items, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
    }
  }, [open]);

  useEffect(() => {
    setSel((s) => (filtered.length === 0 ? 0 : Math.min(s, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    if (!open || filtered.length === 0) return;
    const root = listRef.current;
    if (!root) return;
    const option = root.querySelector<HTMLElement>(
      `[role="option"][aria-selected="true"]`
    );
    option?.scrollIntoView({ block: "nearest" });
  }, [filtered.length, open, sel]);

  const runAt = useCallback(
    (i: number) => {
      const c = filtered[i];
      if (!c) return;
      onSelectConversation(c.id);
      onClose();
    },
    [filtered, onSelectConversation, onClose]
  );

  const handleListKey = useCallback(
    (key: string, preventDefault: () => void) => {
      if (key === "Escape") {
        preventDefault();
        onClose();
        return true;
      }
      if (key === "ArrowDown") {
        preventDefault();
        setSel((s) => (filtered.length ? (s + 1) % filtered.length : 0));
        return true;
      }
      if (key === "ArrowUp") {
        preventDefault();
        setSel((s) =>
          filtered.length ? (s - 1 + filtered.length) % filtered.length : 0
        );
        return true;
      }
      if (key === "Enter") {
        preventDefault();
        runAt(sel);
        return true;
      }
      return false;
    },
    [filtered.length, onClose, runAt, sel]
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      void handleListKey(e.key, () => e.preventDefault());
    },
    [handleListKey]
  );

  const onHardwareKeyDown = useCallback(
    (event: globalThis.KeyboardEvent, _controller: TextSurfaceController) => {
      void _controller;
      return handleListKey(event.key, () => event.preventDefault());
    },
    [handleListKey]
  );

  return (
    <VSCodeQuickInputShell
      open={open}
      onClose={onClose}
      screenReaderTitle={screenReaderTitle}
      inputLabel={inputLabel}
      placeholder={placeholder}
      value={query}
      onChange={setQuery}
      onKeyDown={onKeyDown}
      onHardwareKeyDown={onHardwareKeyDown}
    >
      <div
        ref={listRef}
        className="hide-scrollbar-y max-h-[320px] overflow-y-auto overflow-x-hidden"
        role="listbox"
      >
        {filtered.length === 0 ? (
          <div className="px-[10px] py-[20px] text-center font-sans text-[13px] text-[var(--palette-placeholder)]">
            {query ? "No matching chats" : emptyLabel}
          </div>
        ) : (
          filtered.map((item, i) => {
            const on = i === sel;
            const secondaryCls = on
              ? "text-[var(--palette-row-selected-muted)]"
              : "text-[var(--palette-row-muted)]";
            return (
              <div
                key={item.id}
                role="option"
                aria-selected={on}
                className={`${rowBase} ${
                  on
                    ? "bg-[var(--palette-row-selected-bg)] text-[var(--palette-row-selected-text)]"
                    : "text-[var(--palette-row-text)]"
                }`}
                onMouseEnter={() => setSel(i)}
                onClick={() => runAt(i)}
              >
                <span
                  className={`min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-sans text-[13px] ${
                    on ? "text-[var(--palette-row-selected-text)]" : "text-[var(--palette-row-text)]"
                  }`}
                >
                  {item.title}
                  {item.detail ? (
                    <span className={secondaryCls}>{` \u00b7 ${item.detail}`}</span>
                  ) : null}
                  {item.badge ? (
                    <span className={`${secondaryCls} uppercase`}>{` \u00b7 ${item.badge}`}</span>
                  ) : null}
                </span>
                <span className={`shrink-0 whitespace-nowrap font-sans text-[11px] ${secondaryCls}`}>
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
