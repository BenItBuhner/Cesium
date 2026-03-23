"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from "react";
import {
  File,
  FileCode,
  FileJson,
  FileText,
  Braces,
} from "lucide-react";
import type { QuickOpenEntry } from "@/lib/quick-open-files";
import { VSCodeQuickInputShell } from "./VSCodeQuickInputShell";

function fileGlyph(path: string, language?: string) {
  const lower = path.toLowerCase();
  const lang = language?.toLowerCase() ?? "";
  if (lang === "json" || lower.endsWith(".json")) {
    return (
      <FileJson
        className="size-[16px] shrink-0 text-[var(--palette-icon-json)]"
        strokeWidth={1.5}
        aria-hidden
      />
    );
  }
  if (lang === "markdown" || lower.endsWith(".md")) {
    return (
      <FileText
        className="size-[16px] shrink-0 text-[var(--palette-icon-md)]"
        strokeWidth={1.5}
        aria-hidden
      />
    );
  }
  if (lang === "css" || lower.endsWith(".css")) {
    return (
      <Braces
        className="size-[16px] shrink-0 text-[var(--palette-icon-css)]"
        strokeWidth={1.5}
        aria-hidden
      />
    );
  }
  if (
    lang === "typescript" ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".ts")
  ) {
    return (
      <FileCode
        className="size-[16px] shrink-0 text-[var(--palette-icon-ts)]"
        strokeWidth={1.5}
        aria-hidden
      />
    );
  }
  return (
    <File
      className="size-[16px] shrink-0 text-[var(--palette-icon-fallback)]"
      strokeWidth={1.5}
      aria-hidden
    />
  );
}

function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf("/");
  if (i < 0) return { dir: "", base: path };
  return { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

function score(query: string, path: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const p = path.toLowerCase();
  if (p === q) return 0;
  const at = p.indexOf(q);
  if (at >= 0) return 10 + at;
  const parts = q.split(/\s+/).filter(Boolean);
  let s = 100;
  for (const part of parts) {
    const j = p.indexOf(part);
    if (j < 0) return 1e6;
    s += j;
  }
  return s;
}

const rowBase =
  "flex w-full cursor-pointer items-center gap-[8px] px-[10px] py-[4px] text-left font-sans outline-none";

const kbdCls =
  "rounded border border-[var(--palette-kbd-border)] bg-[var(--palette-kbd-bg)] px-[5px] py-[1px] font-mono text-[10px] text-[var(--palette-kbd-text)]";

export function QuickOpen({
  open,
  onClose,
  entries,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  entries: QuickOpenEntry[];
  onPick: (entry: QuickOpenEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return [...entries].sort((a, b) => a.path.localeCompare(b.path));
    const ranked = entries
      .map((e) => ({ e, s: score(q, e.path) }))
      .filter((x) => x.s < 1e6)
      .sort((a, b) => a.s - b.s || a.e.path.localeCompare(b.e.path));
    return ranked.map((x) => x.e);
  }, [entries, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
    }
  }, [open]);

  useEffect(() => {
    setSel((s) => (filtered.length === 0 ? 0 : Math.min(s, filtered.length - 1)));
  }, [filtered.length]);

  const pickAt = useCallback(
    (i: number) => {
      const e = filtered[i];
      if (!e) return;
      onPick(e);
      onClose();
    },
    [filtered, onClose, onPick]
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
        pickAt(sel);
      }
    },
    [filtered.length, onClose, pickAt, sel]
  );

  return (
    <VSCodeQuickInputShell
      open={open}
      screenReaderTitle="Quick open file"
      inputLabel="File search"
      placeholder="Search files by name (demo: path filter only)"
      value={query}
      onChange={setQuery}
      onKeyDown={onKeyDown}
      footer={
        <p className="font-sans text-[11px] text-[var(--palette-footer-text)]">
          Demo workspace · <kbd className={kbdCls}>Enter</kbd> open ·{" "}
          <kbd className={kbdCls}>Esc</kbd> close
        </p>
      }
    >
      <div className="hide-scrollbar-y max-h-[min(380px,45vh)] min-h-[140px] overflow-y-auto py-[4px]">
        {filtered.length === 0 ? (
          <p className="px-[10px] py-[12px] font-sans text-[13px] text-[var(--palette-row-muted)]">
            No matching files
          </p>
        ) : (
          <ul className="m-0 list-none p-0" role="listbox">
            {filtered.map((e, i) => {
              const { dir, base } = splitPath(e.path);
              const on = i === sel;
              return (
                <li key={e.path} role="option" aria-selected={on}>
                  <button
                    type="button"
                    className={`${rowBase} ${
                      on
                        ? "bg-[var(--palette-row-selected-bg)]"
                        : "text-[var(--palette-row-text)]"
                    }`}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => pickAt(i)}
                  >
                    {fileGlyph(e.path, e.node.language)}
                    <span className="min-w-0 flex-1 truncate font-sans text-[13px]">
                      {dir ? (
                        <span
                          className={
                            on
                              ? "text-[var(--palette-row-selected-muted)]"
                              : "text-[var(--palette-row-muted)]"
                          }
                        >
                          {dir}
                        </span>
                      ) : null}
                      <span
                        className={
                          on
                            ? "text-[var(--palette-row-selected-text)]"
                            : "text-[var(--palette-row-text)]"
                        }
                      >
                        {base}
                      </span>
                    </span>
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
