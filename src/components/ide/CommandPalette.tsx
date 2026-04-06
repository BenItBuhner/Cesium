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

export type PaletteCommand = {
  id: string;
  label: string;
  detail?: string;
  keybinding?: string;
  run: () => void;
};

const rowBase =
  "flex w-full cursor-pointer items-center gap-[10px] px-[10px] py-[5px] text-left font-sans text-[13px] outline-none";
const kb = "ml-auto shrink-0 font-mono text-[11px] tabular-nums";

const kbdCls =
  "rounded border border-[var(--palette-kbd-border)] bg-[var(--palette-kbd-bg)] px-[5px] py-[1px] font-mono text-[10px] text-[var(--palette-kbd-text)]";

export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => {
      const hay = `${c.label} ${c.detail ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [commands, query]);

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
      c.run();
      onClose();
    },
    [filtered, onClose]
  );

  const handleListKey = useCallback(
    (
      key: string,
      preventDefault: () => void
    ) => {
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
      screenReaderTitle="Command palette"
      inputLabel="Command search"
      placeholder="Type the name of a command to run."
      value={query}
      onChange={setQuery}
      onKeyDown={onKeyDown}
      onHardwareKeyDown={onHardwareKeyDown}
      footer={
        <p className="font-sans text-[11px] text-[var(--palette-footer-text)]">
          <kbd className={kbdCls}>↑↓</kbd> to navigate ·{" "}
          <kbd className={kbdCls}>Enter</kbd> to run ·{" "}
          <kbd className={kbdCls}>Esc</kbd> to close
        </p>
      }
    >
      <div
        ref={listRef}
        className="hide-scrollbar-y max-h-[min(360px,42vh)] min-h-[120px] overflow-y-auto py-[4px]"
      >
        {filtered.length === 0 ? (
          <p className="px-[10px] py-[12px] font-sans text-[13px] text-[var(--palette-row-muted)]">
            No matching commands
          </p>
        ) : (
          <ul className="m-0 list-none p-0" role="listbox">
            {filtered.map((c, i) => {
              const on = i === sel;
              return (
                <li key={c.id} role="option" aria-selected={on}>
                  <button
                    type="button"
                    className={`${rowBase} ${
                      on
                        ? "bg-[var(--palette-row-selected-bg)] text-[var(--palette-row-selected-text)]"
                        : "text-[var(--palette-row-text)]"
                    }`}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => runAt(i)}
                  >
                    <span className="min-w-0 flex-1 truncate">{c.label}</span>
                    {c.keybinding ? (
                      <span
                        className={`${kb} ${
                          on
                            ? "text-[var(--palette-keybinding-on-selected)]"
                            : "text-[var(--palette-keybinding-idle)]"
                        }`}
                      >
                        {c.keybinding}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </VSCodeQuickInputShell>
  );
}
