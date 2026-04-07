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
import type { WorkspaceWindowRecord } from "@/lib/types";
import { VSCodeQuickInputShell } from "./VSCodeQuickInputShell";

type WorkspaceWindowsModalItem = {
  id: string;
  label: string;
  detail?: string;
  onSelect: () => void;
};

const rowBase =
  "flex w-full cursor-pointer items-start gap-[10px] px-[10px] py-[7px] text-left font-sans text-[13px] outline-none";

function formatRelativeWindowTime(windowRecord: WorkspaceWindowRecord): string {
  const lastFocusedAt = windowRecord.lastFocusedAt ?? windowRecord.lastOpenedAt;
  const diffMs = Math.max(0, Date.now() - lastFocusedAt);
  const minutes = Math.round(diffMs / 60_000);
  if (minutes <= 1) {
    return "Active just now";
  }
  if (minutes < 60) {
    return `Active ${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `Active ${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return `Active ${days}d ago`;
}

export function WorkspaceWindowsModal({
  open,
  onClose,
  windows,
  activeWindowId,
  currentWindowLabel,
  onCreateWindow,
  onOpenWindow,
  onRenameCurrentWindow,
  initialSelectionId,
}: {
  open: boolean;
  onClose: () => void;
  windows: WorkspaceWindowRecord[];
  activeWindowId: string | null;
  currentWindowLabel: string | null;
  onCreateWindow: () => void;
  onOpenWindow: (windowId: string) => void;
  onRenameCurrentWindow?: () => void;
  initialSelectionId?: string | null;
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pendingInitialSelectionIdRef = useRef<string | null>(null);

  const items = useMemo<WorkspaceWindowsModalItem[]>(() => {
    const nextItems: WorkspaceWindowsModalItem[] = [
      {
        id: "action:create-window",
        label: "Create New Workspace Window",
        detail: "Open a dedicated window with its own persistent editor session.",
        onSelect: onCreateWindow,
      },
    ];

    if (onRenameCurrentWindow) {
      nextItems.push({
        id: "action:rename-current-window",
        label: "Rename Current Workspace Window",
        detail: currentWindowLabel
          ? `Current name: ${currentWindowLabel}`
          : "Give the current window a memorable name.",
        onSelect: onRenameCurrentWindow,
      });
    }

    for (const windowRecord of windows) {
      if (windowRecord.id === activeWindowId) {
        continue;
      }
      nextItems.push({
        id: `window:${windowRecord.id}`,
        label: windowRecord.label,
        detail: formatRelativeWindowTime(windowRecord),
        onSelect: () => onOpenWindow(windowRecord.id),
      });
    }

    return nextItems;
  }, [
    activeWindowId,
    currentWindowLabel,
    onCreateWindow,
    onOpenWindow,
    onRenameCurrentWindow,
    windows,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return items;
    }
    return items.filter((item) => {
      const haystack = `${item.label} ${item.detail ?? ""}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [items, query]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setQuery("");
    setSel(0);
    pendingInitialSelectionIdRef.current = initialSelectionId ?? null;
  }, [initialSelectionId, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    if (filtered.length === 0) {
      setSel(0);
      pendingInitialSelectionIdRef.current = null;
      return;
    }
    const pendingId = pendingInitialSelectionIdRef.current;
    if (!pendingId) {
      setSel((current) => Math.min(current, filtered.length - 1));
      return;
    }
    const nextIndex = filtered.findIndex((item) => item.id === pendingId);
    setSel(nextIndex >= 0 ? nextIndex : 0);
    pendingInitialSelectionIdRef.current = null;
  }, [filtered, open]);

  useEffect(() => {
    if (!open || filtered.length === 0) {
      return;
    }
    const root = listRef.current;
    if (!root) {
      return;
    }
    const option = root.querySelector<HTMLElement>(
      `[role="option"][aria-selected="true"]`
    );
    option?.scrollIntoView({ block: "nearest" });
  }, [filtered.length, open, sel]);

  const runAt = useCallback(
    (index: number) => {
      const item = filtered[index];
      if (!item) {
        return;
      }
      onClose();
      window.setTimeout(() => {
        item.onSelect();
      }, 0);
    },
    [filtered, onClose]
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
        setSel((current) => (filtered.length ? (current + 1) % filtered.length : 0));
        return true;
      }
      if (key === "ArrowUp") {
        preventDefault();
        setSel((current) =>
          filtered.length ? (current - 1 + filtered.length) % filtered.length : 0
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
    (event: KeyboardEvent<HTMLInputElement>) => {
      void handleListKey(event.key, () => event.preventDefault());
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
      screenReaderTitle="Workspace windows"
      inputLabel="Search workspace windows"
      placeholder="Search workspace windows and actions..."
      value={query}
      onChange={setQuery}
      onKeyDown={onKeyDown}
      onHardwareKeyDown={onHardwareKeyDown}
      footer={
        <p className="font-sans text-[11px] text-[var(--palette-footer-text)]">
          Enter to open or manage a window · Esc to close
        </p>
      }
    >
      <div
        ref={listRef}
        className="hide-scrollbar-y max-h-[320px] overflow-y-auto overflow-x-hidden"
        role="listbox"
      >
        {filtered.length === 0 ? (
          <div className="px-[10px] py-[20px] text-center font-sans text-[13px] text-[var(--palette-placeholder)]">
            {query ? "No matching workspace windows" : "No workspace window actions"}
          </div>
        ) : (
          filtered.map((item, index) => (
            <div
              key={item.id}
              role="option"
              aria-selected={index === sel}
              className={`${rowBase} ${
                index === sel
                  ? "bg-[var(--palette-row-selected-bg)] text-[var(--palette-row-selected-text)]"
                  : "text-[var(--palette-row-text)]"
              }`}
              onMouseEnter={() => setSel(index)}
              onClick={() => runAt(index)}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate">{item.label}</div>
                {item.detail ? (
                  <div className="truncate text-[11px] text-[var(--text-disabled)]">
                    {item.detail}
                  </div>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </VSCodeQuickInputShell>
  );
}
