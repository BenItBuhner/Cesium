"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from "react";
import type { TextSurfaceController } from "@/components/input/HardwareAwareTextField";
import { VSCodeQuickInputShell } from "./VSCodeQuickInputShell";
import type { AgentConversationRecord } from "@/lib/agent-types";

const rowBase =
  "flex w-full cursor-pointer items-center gap-[10px] px-[10px] py-[5px] text-left font-sans text-[13px] outline-none";

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
  open,
  onClose,
  conversations,
  onSelectConversation,
}: {
  open: boolean;
  onClose: () => void;
  conversations: AgentConversationRecord[];
  onSelectConversation: (conversationId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => {
      const hay = c.title.toLowerCase();
      return hay.includes(q);
    });
  }, [conversations, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
    }
  }, [open]);

  useEffect(() => {
    setSel((s) => (filtered.length === 0 ? 0 : Math.min(s, filtered.length - 1)));
  }, [filtered.length]);

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
      screenReaderTitle="Recent chats"
      inputLabel="Search recent chats"
      placeholder="Search recent chats..."
      value={query}
      onChange={setQuery}
      onKeyDown={onKeyDown}
      onHardwareKeyDown={onHardwareKeyDown}
    >
      <div className="max-h-[320px] overflow-y-auto overflow-x-hidden">
        {filtered.length === 0 ? (
          <div className="px-[10px] py-[20px] text-center font-sans text-[13px] text-[var(--palette-placeholder)]">
            {query ? "No matching chats" : "No recent chats"}
          </div>
        ) : (
          filtered.map((conversation, i) => (
            <div
              key={conversation.id}
              role="option"
              aria-selected={i === sel}
              className={`${rowBase} ${
                i === sel
                  ? "bg-[var(--palette-row-selected-bg)] text-[var(--palette-row-selected-text)]"
                  : "text-[var(--palette-row-text)]"
              }`}
              onMouseEnter={() => setSel(i)}
              onClick={() => runAt(i)}
            >
              <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
              <span className="shrink-0 font-sans text-[11px] text-[var(--text-disabled)]">
                {formatRelativeTime(conversation.updatedAt)}
              </span>
            </div>
          ))
        )}
      </div>
    </VSCodeQuickInputShell>
  );
}
