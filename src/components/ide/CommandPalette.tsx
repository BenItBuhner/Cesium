"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from "react";
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
const rowInactive = "text-[#cccccc]";
const rowActive = "bg-[#04395e] text-[#ffffff]";
const kb = "ml-auto shrink-0 font-mono text-[11px] tabular-nums";

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

  const runAt = useCallback(
    (i: number) => {
      const c = filtered[i];
      if (!c) return;
      c.run();
      onClose();
    },
    [filtered, onClose]
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => (filtered.length ? (s + 1) % filtered.length : 0));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) =>
          filtered.length ? (s - 1 + filtered.length) % filtered.length : 0
        );
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        runAt(sel);
      }
    },
    [filtered.length, onClose, runAt, sel]
  );

  return (
    <VSCodeQuickInputShell
      open={open}
      screenReaderTitle="Command palette"
      inputLabel="Command search"
      placeholder="Type the name of a command to run."
      value={query}
      onChange={setQuery}
      onKeyDown={onKeyDown}
      footer={
        <p className="font-sans text-[11px] text-[#767676]">
          <kbd className="rounded border border-[#3c3c3c] bg-[#1e1e1e] px-[5px] py-[1px] font-mono text-[10px]">
            ↑↓
          </kbd>{" "}
          to navigate ·{" "}
          <kbd className="rounded border border-[#3c3c3c] bg-[#1e1e1e] px-[5px] py-[1px] font-mono text-[10px]">
            Enter
          </kbd>{" "}
          to run ·{" "}
          <kbd className="rounded border border-[#3c3c3c] bg-[#1e1e1e] px-[5px] py-[1px] font-mono text-[10px]">
            Esc
          </kbd>{" "}
          to close
        </p>
      }
    >
      <div className="max-h-[min(360px,42vh)] min-h-[120px] overflow-y-auto py-[4px]">
        {filtered.length === 0 ? (
          <p className="px-[10px] py-[12px] font-sans text-[13px] text-[#767676]">
            No matching commands
          </p>
        ) : (
          <ul className="m-0 list-none p-0" role="listbox">
            {filtered.map((c, i) => (
              <li key={c.id} role="option" aria-selected={i === sel}>
                <button
                  type="button"
                  className={`${rowBase} ${i === sel ? rowActive : rowInactive}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => runAt(i)}
                >
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.keybinding ? (
                    <span
                      className={`${kb} ${i === sel ? "text-[#9dc3e6]" : "text-[#767676]"}`}
                    >
                      {c.keybinding}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </VSCodeQuickInputShell>
  );
}
