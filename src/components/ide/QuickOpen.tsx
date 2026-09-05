"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { TextSurfaceController } from "@/components/input/HardwareAwareTextField";
import {
  File,
  FileCode,
  FileJson,
  FileText,
  Braces,
  ChevronRight,
  MessageSquare,
  Settings,
  SquareStack,
} from "lucide-react";
import type { QuickOpenEntry } from "@/lib/quick-open-files";
import type { AgentSwitcherCandidate } from "@/lib/agent-conversation-mru";
import { formatAgentRailRelativeTime } from "@/lib/agent-rail-status";
import type { SettingsSearchEntry } from "@/lib/settings-search-index";
import {
  QUICK_OPEN_SCOPE_IDS,
  QUICK_OPEN_SCOPE_LABELS,
  QUICK_OPEN_SCOPE_PLACEHOLDERS,
  cycleQuickOpenScope,
  parseQuickOpenQuery,
  type QuickOpenScopeId,
} from "@/lib/quick-open-scopes";
import type { PaletteCommand } from "./CommandPalette";
import { VSCodeQuickInputShell } from "./VSCodeQuickInputShell";

/** Open editor tab surfaced in the Tabs scope. */
export type QuickOpenTabItem = {
  id: string;
  name: string;
  group: "left" | "right";
  active: boolean;
};

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

function scopeGlyph(scope: QuickOpenScopeId) {
  const cls = "size-[16px] shrink-0 text-[var(--palette-icon-fallback)]";
  switch (scope) {
    case "conversations":
      return <MessageSquare className={cls} strokeWidth={1.5} aria-hidden />;
    case "commands":
      return <ChevronRight className={cls} strokeWidth={1.5} aria-hidden />;
    case "settings":
      return <Settings className={cls} strokeWidth={1.5} aria-hidden />;
    case "tabs":
      return <SquareStack className={cls} strokeWidth={1.5} aria-hidden />;
    default:
      return <File className={cls} strokeWidth={1.5} aria-hidden />;
  }
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

/** Unified row shown in the list regardless of scope. */
type QuickOpenRow = {
  key: string;
  icon: ReactNode;
  /** Muted prefix rendered before the primary text (file directory). */
  primaryMuted?: string;
  primary: string;
  /** Muted inline detail after the primary text. */
  inlineDetail?: string;
  /** Right-aligned detail (keybinding, relative time, pane). */
  trailing?: string;
  pick: () => void;
};

const rowBase =
  "flex w-full cursor-pointer items-center gap-[8px] px-[10px] py-[4px] text-left font-sans outline-none";

const kbdCls =
  "rounded border border-[var(--palette-kbd-border)] bg-[var(--palette-kbd-bg)] px-[5px] py-[1px] font-mono text-[10px] text-[var(--palette-kbd-text)]";

export function QuickOpen({
  open,
  onClose,
  entries,
  onPick,
  conversations,
  onPickConversation,
  commands,
  settingsEntries,
  onPickSetting,
  getOpenTabs,
  onPickTab,
  searchSettings,
  defaultScope = "files",
}: {
  open: boolean;
  onClose: () => void;
  entries: QuickOpenEntry[];
  onPick: (entry: QuickOpenEntry) => void;
  conversations: AgentSwitcherCandidate[];
  onPickConversation: (conversationId: string) => void;
  commands: PaletteCommand[];
  settingsEntries: SettingsSearchEntry[];
  onPickSetting: (hit: SettingsSearchEntry) => void;
  getOpenTabs: () => QuickOpenTabItem[];
  onPickTab: (tab: QuickOpenTabItem) => void;
  /** Query-driven settings search (falls back to nav categories when empty). */
  searchSettings: (
    index: SettingsSearchEntry[],
    query: string,
    limit?: number
  ) => SettingsSearchEntry[];
  defaultScope?: QuickOpenScopeId;
}) {
  const [rawQuery, setRawQuery] = useState("");
  const [baseScope, setBaseScope] = useState<QuickOpenScopeId>(defaultScope);
  const [sel, setSel] = useState(0);
  const [tabItems, setTabItems] = useState<QuickOpenTabItem[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);

  const { scope, query } = useMemo(
    () => parseQuickOpenQuery(rawQuery, baseScope),
    [baseScope, rawQuery]
  );

  useEffect(() => {
    if (open) {
      setRawQuery("");
      setBaseScope(defaultScope);
      setSel(0);
      setTabItems(getOpenTabs());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const setScope = useCallback(
    (next: QuickOpenScopeId) => {
      setBaseScope(next);
      // A typed sigil/word prefix would fight the chip selection; strip it.
      setRawQuery((current) => {
        const parsed = parseQuickOpenQuery(current, next);
        return parsed.prefixed ? parsed.query : current;
      });
      setSel(0);
    },
    []
  );

  const rows = useMemo<QuickOpenRow[]>(() => {
    const q = query.trim();
    if (scope === "files") {
      const ranked = q
        ? entries
            .map((e) => ({ e, s: score(q, e.path) }))
            .filter((x) => x.s < 1e6)
            .sort((a, b) => a.s - b.s || a.e.path.localeCompare(b.e.path))
            .map((x) => x.e)
        : [...entries].sort((a, b) => a.path.localeCompare(b.path));
      return ranked.map((e) => {
        const { dir, base } = splitPath(e.path);
        return {
          key: `file:${e.path}`,
          icon: fileGlyph(e.path, e.node.language),
          primaryMuted: dir || undefined,
          primary: base,
          pick: () => onPick(e),
        };
      });
    }
    if (scope === "conversations") {
      const lower = q.toLowerCase();
      const matched = q
        ? conversations
            .map((c) => {
              const hay = `${c.title} ${c.workspaceName}`.toLowerCase();
              const at = hay.indexOf(lower);
              return { c, at };
            })
            .filter((x) => x.at >= 0)
            .sort((a, b) => a.at - b.at)
            .map((x) => x.c)
        : conversations;
      return matched.map((c) => ({
        key: `conversation:${c.id}`,
        icon: scopeGlyph("conversations"),
        primary: c.title,
        inlineDetail:
          [c.workspaceName, c.badge?.toUpperCase()].filter(Boolean).join(" · ") ||
          undefined,
        trailing: c.updatedAt ? formatAgentRailRelativeTime(c.updatedAt) : undefined,
        pick: () => onPickConversation(c.id),
      }));
    }
    if (scope === "commands") {
      const lower = q.toLowerCase();
      const matched = q
        ? commands.filter((c) =>
            `${c.label} ${c.detail ?? ""}`.toLowerCase().includes(lower)
          )
        : commands;
      return matched.map((c) => ({
        key: `command:${c.id}`,
        icon: scopeGlyph("commands"),
        primary: c.label,
        trailing: c.keybinding,
        pick: () => c.run(),
      }));
    }
    if (scope === "settings") {
      const matched = q
        ? searchSettings(settingsEntries, q, 50)
        : settingsEntries.filter((entry) => entry.kind === "nav");
      return matched.map((hit) => ({
        key: `setting:${hit.id}`,
        icon: scopeGlyph("settings"),
        primary: hit.label,
        inlineDetail: hit.subtitle || undefined,
        pick: () => onPickSetting(hit),
      }));
    }
    const lower = q.toLowerCase();
    const matched = q
      ? tabItems.filter((tab) => tab.name.toLowerCase().includes(lower))
      : tabItems;
    return matched.map((tab) => ({
      key: `tab:${tab.group}:${tab.id}`,
      icon: scopeGlyph("tabs"),
      primary: tab.name,
      inlineDetail: tab.active ? "active" : undefined,
      trailing: tab.group === "right" ? "right pane" : "left pane",
      pick: () => onPickTab(tab),
    }));
  }, [
    commands,
    conversations,
    entries,
    onPick,
    onPickConversation,
    onPickSetting,
    onPickTab,
    query,
    scope,
    searchSettings,
    settingsEntries,
    tabItems,
  ]);

  useEffect(() => {
    setSel((s) => (rows.length === 0 ? 0 : Math.min(s, rows.length - 1)));
  }, [rows.length]);

  useEffect(() => {
    if (!open || rows.length === 0) return;
    const root = listRef.current;
    if (!root) return;
    const option = root.querySelector<HTMLElement>(
      `[role="option"][aria-selected="true"]`
    );
    option?.scrollIntoView({ block: "nearest" });
  }, [rows.length, open, sel]);

  const pickAt = useCallback(
    (i: number) => {
      const row = rows[i];
      if (!row) return;
      row.pick();
      onClose();
    },
    [rows, onClose]
  );

  const handleListKey = useCallback(
    (
      key: string,
      preventDefault: () => void,
      modifiers?: { mod?: boolean; shift?: boolean }
    ) => {
      if (key === "Escape") {
        preventDefault();
        onClose();
        return true;
      }
      // Tab / Shift+Tab and repeated Mod+P cycle the search scope.
      if (key === "Tab" || (modifiers?.mod && key.toLowerCase() === "p")) {
        preventDefault();
        setScope(cycleQuickOpenScope(scope, modifiers?.shift ? -1 : 1));
        return true;
      }
      if (key === "ArrowDown") {
        preventDefault();
        setSel((s) => (rows.length ? (s + 1) % rows.length : 0));
        return true;
      }
      if (key === "ArrowUp") {
        preventDefault();
        setSel((s) => (rows.length ? (s - 1 + rows.length) % rows.length : 0));
        return true;
      }
      if (key === "Enter") {
        preventDefault();
        pickAt(sel);
        return true;
      }
      return false;
    },
    [onClose, pickAt, rows.length, scope, sel, setScope]
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      void handleListKey(e.key, () => e.preventDefault(), {
        mod: e.ctrlKey || e.metaKey,
        shift: e.shiftKey,
      });
    },
    [handleListKey]
  );

  const onHardwareKeyDown = useCallback(
    (event: globalThis.KeyboardEvent, _controller: TextSurfaceController) => {
      void _controller;
      return handleListKey(event.key, () => event.preventDefault(), {
        mod: event.ctrlKey || event.metaKey,
        shift: event.shiftKey,
      });
    },
    [handleListKey]
  );

  return (
    <VSCodeQuickInputShell
      open={open}
      onClose={onClose}
      screenReaderTitle="Quick open"
      inputLabel="Quick open search"
      placeholder={QUICK_OPEN_SCOPE_PLACEHOLDERS[scope]}
      value={rawQuery}
      onChange={setRawQuery}
      onKeyDown={onKeyDown}
      onHardwareKeyDown={onHardwareKeyDown}
      footer={
        <p className="font-sans text-[11px] text-[var(--palette-footer-text)]">
          <kbd className={kbdCls}>Tab</kbd> scope ·{" "}
          <kbd className={kbdCls}>Enter</kbd> open ·{" "}
          <kbd className={kbdCls}>Esc</kbd> close ·{" "}
          <kbd className={kbdCls}>&gt;</kbd> commands ·{" "}
          <kbd className={kbdCls}>@</kbd> chats ·{" "}
          <kbd className={kbdCls}>#</kbd> settings
        </p>
      }
    >
      <div
        className="flex items-center gap-[4px] overflow-x-auto border-b border-[var(--palette-divider)] px-[8px] py-[5px]"
        role="tablist"
        aria-label="Quick open scope"
      >
        {QUICK_OPEN_SCOPE_IDS.map((id) => {
          const on = id === scope;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setScope(id)}
              className={`shrink-0 cursor-pointer rounded-[4px] border px-[8px] py-[2px] font-sans text-[11px] transition-colors ${
                on
                  ? "border-[var(--palette-kbd-border)] bg-[var(--palette-row-selected-bg)] text-[var(--palette-row-selected-text)]"
                  : "border-transparent text-[var(--palette-row-muted)] hover:text-[var(--palette-row-text)]"
              }`}
            >
              {QUICK_OPEN_SCOPE_LABELS[id]}
            </button>
          );
        })}
      </div>
      <div
        ref={listRef}
        className="hide-scrollbar-y max-h-[min(380px,45vh)] min-h-[140px] overflow-y-auto py-[4px]"
      >
        {rows.length === 0 ? (
          <p className="px-[10px] py-[12px] font-sans text-[13px] text-[var(--palette-row-muted)]">
            No matching {QUICK_OPEN_SCOPE_LABELS[scope].toLowerCase()}
          </p>
        ) : (
          <ul className="m-0 list-none p-0" role="listbox">
            {rows.map((row, i) => {
              const on = i === sel;
              const mutedCls = on
                ? "text-[var(--palette-row-selected-muted)]"
                : "text-[var(--palette-row-muted)]";
              return (
                <li key={row.key} role="option" aria-selected={on}>
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
                    {row.icon}
                    <span className="min-w-0 flex-1 truncate font-sans text-[13px]">
                      {row.primaryMuted ? (
                        <span className={mutedCls}>{row.primaryMuted}</span>
                      ) : null}
                      <span
                        className={
                          on
                            ? "text-[var(--palette-row-selected-text)]"
                            : "text-[var(--palette-row-text)]"
                        }
                      >
                        {row.primary}
                      </span>
                      {row.inlineDetail ? (
                        <span className={mutedCls}>{` · ${row.inlineDetail}`}</span>
                      ) : null}
                    </span>
                    {row.trailing ? (
                      <span
                        className={`ml-auto shrink-0 whitespace-nowrap font-sans text-[11px] tabular-nums ${mutedCls}`}
                      >
                        {row.trailing}
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
