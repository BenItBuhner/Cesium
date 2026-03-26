"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
} from "react";
import { ArrowUp, Mic, Upload } from "lucide-react";
import { ModeDropdown } from "./ModeDropdown";
import { ModelDropdown } from "./ModelDropdown";
import {
  ComposerAutocomplete,
  type ComposerPopoverPosition,
} from "./ComposerAutocomplete";
import { useClickOutside } from "@/hooks/useClickOutside";
import { availableModels } from "@/lib/mock-data";
import {
  getAllAtSuggestions,
  filterAtSuggestions,
  SLASH_COMMANDS,
  filterSlashSuggestions,
  type AtSuggestion,
  type SlashSuggestion,
} from "@/lib/composer-suggestions";
import {
  getCaretOffset,
  parseTriggerToken,
  replaceTextRange,
  getCaretClientRect,
} from "./composer-editor-utils";
import type { EditorMode, ModelInfo } from "@/lib/types";

const AT_LIST = getAllAtSuggestions();

const sendButtonBgClass: Record<EditorMode, string> = {
  agent: "bg-[var(--accent-dark)]",
  plan: "bg-[var(--plan-accent-dark)]",
  debug: "bg-[var(--debug-accent-dark)]",
  ask: "bg-[var(--ask-accent-dark)]",
};

type MenuState =
  | { kind: "at"; start: number; end: number; query: string }
  | { kind: "slash"; start: number; end: number; query: string };

interface ChatComposerProps {
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  model: ModelInfo;
  onModelChange: (model: ModelInfo) => void;
  /** Empty thread: composer sits under tabs; otherwise docked above bottom. */
  layout?: "docked-bottom" | "empty-top";
}

export function ChatComposer({
  mode,
  onModeChange,
  model,
  onModelChange,
  layout = "docked-bottom",
}: ChatComposerProps) {
  const [isEmpty, setIsEmpty] = useState(true);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [menuPos, setMenuPos] = useState<ComposerPopoverPosition>({
    placement: "above",
    bottom: 100,
    left: 8,
    maxHeight: 280,
  });

  const editorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<MenuState | null>(null);
  menuRef.current = menu;

  const filteredAt = useMemo(
    () => (menu?.kind === "at" ? filterAtSuggestions(AT_LIST, menu.query) : []),
    [menu]
  );
  const filteredSlash = useMemo(
    () => (menu?.kind === "slash" ? filterSlashSuggestions(SLASH_COMMANDS, menu.query) : []),
    [menu]
  );

  const syncTrigger = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const text = el.textContent ?? "";
    const caret = getCaretOffset(el);
    const trig = parseTriggerToken(text, caret);
    setMenu((prev) => {
      if (!trig) return prev === null ? prev : null;
      const next: MenuState = {
        kind: trig.kind,
        start: trig.start,
        end: trig.end,
        query: trig.query,
      };
      if (
        prev &&
        prev.kind === next.kind &&
        prev.start === next.start &&
        prev.end === next.end &&
        prev.query === next.query
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [menu?.query, menu?.kind, menu?.start]);

  useLayoutEffect(() => {
    if (!menu || !editorRef.current) return;
    const rect = getCaretClientRect(editorRef.current);
    if (!rect) return;
    const gap = 6;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const maxHCap = 300;
    const spaceAbove = rect.top - 8;
    const spaceBelow = vh - rect.bottom - 8;
    const minAbove = 72;
    const preferAbove = spaceAbove >= minAbove || spaceAbove >= spaceBelow;
    const left = Math.max(8, Math.min(rect.left, vw - 368));

    if (preferAbove) {
      const maxHeight = Math.min(maxHCap, Math.max(120, spaceAbove - gap));
      const bottom = vh - rect.top + gap;
      setMenuPos({ placement: "above", bottom, left, maxHeight });
    } else {
      const maxHeight = Math.min(maxHCap, Math.max(120, spaceBelow - gap));
      const top = rect.bottom + gap;
      setMenuPos({ placement: "below", top, left, maxHeight });
    }
  }, [menu, menu?.end]);

  useClickOutside(editorRef, () => setMenu(null), !!menu, [popoverRef]);

  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const doc = el.ownerDocument;
    function onSelectionChange() {
      const box = editorRef.current;
      if (!box) return;
      const sel = doc.getSelection();
      if (!sel?.anchorNode || !box.contains(sel.anchorNode)) return;
      syncTrigger();
    }
    doc.addEventListener("selectionchange", onSelectionChange);
    return () => doc.removeEventListener("selectionchange", onSelectionChange);
  }, [syncTrigger]);

  const pickAt = useCallback((item: AtSuggestion) => {
    const el = editorRef.current;
    const m = menuRef.current;
    if (!el || !m || m.kind !== "at") return;
    replaceTextRange(el, m.start, m.end, `${item.insert} `);
    setMenu(null);
    setIsEmpty((el.textContent ?? "").trim().length === 0);
  }, []);

  const pickSlash = useCallback((item: SlashSuggestion) => {
    const el = editorRef.current;
    const m = menuRef.current;
    if (!el || !m || m.kind !== "slash") return;
    replaceTextRange(el, m.start, m.end, `${item.insert} `);
    setMenu(null);
    setIsEmpty((el.textContent ?? "").trim().length === 0);
  }, []);

  function handleInput() {
    const text = editorRef.current?.textContent ?? "";
    setIsEmpty(text.trim().length === 0);
    syncTrigger();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!menu) return;
    const items = menu.kind === "at" ? filteredAt : filteredSlash;

    if (e.key === "Escape") {
      e.preventDefault();
      setMenu(null);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length === 0) return;
      setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length === 0) return;
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && items.length > 0) {
      e.preventDefault();
      const idx = Math.min(selectedIndex, items.length - 1);
      if (menu.kind === "at") pickAt(items[idx] as AtSuggestion);
      else pickSlash(items[idx] as SlashSuggestion);
    }
  }

  const shellMargin =
    layout === "empty-top"
      ? "mx-[10px] mt-[10px] mb-0"
      : "mx-[10px] mb-[10px]";

  const modeModelPopoverPlacement =
    layout === "empty-top" ? "below" : "above";

  return (
    <div
      data-ide-input-sink
      className={`${shellMargin} flex shrink-0 flex-col gap-[10px] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[10px]`}
    >
      <div className="relative">
        {isEmpty && (
          <span className="pointer-events-none absolute left-0 top-0 font-sans text-[14px] font-normal text-[var(--text-secondary)]">
            Plan, @ for context, / for skills
          </span>
        )}
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onMouseUp={syncTrigger}
          className="min-h-[18px] font-sans text-[14px] font-normal text-[var(--text-primary)] outline-none"
          role="textbox"
          aria-label="Chat input"
          aria-expanded={!!menu}
          aria-controls={menu ? "composer-autocomplete" : undefined}
          aria-autocomplete={menu ? "list" : undefined}
        />
      </div>

      {menu?.kind === "at" && (
        <ComposerAutocomplete
          kind="at"
          items={filteredAt}
          selectedIndex={selectedIndex}
          position={menuPos}
          onSelect={pickAt}
          onHighlight={setSelectedIndex}
          listRef={listRef}
          popoverRef={popoverRef}
        />
      )}
      {menu?.kind === "slash" && (
        <ComposerAutocomplete
          kind="slash"
          items={filteredSlash}
          selectedIndex={selectedIndex}
          position={menuPos}
          onSelect={pickSlash}
          onHighlight={setSelectedIndex}
          listRef={listRef}
          popoverRef={popoverRef}
        />
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-[11px]">
          <ModeDropdown
            mode={mode}
            onModeChange={onModeChange}
            popoverPlacement={modeModelPopoverPlacement}
          />
          <ModelDropdown
            model={model}
            models={availableModels}
            onModelChange={onModelChange}
            popoverPlacement={modeModelPopoverPlacement}
          />
        </div>

        <div className="flex items-center gap-[9px]">
          <button
            type="button"
            className="text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            aria-label="Upload file"
          >
            <Upload className="size-[14px] shrink-0" strokeWidth={1.5} aria-hidden />
          </button>
          <button
            type="button"
            className="text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            aria-label="Voice input"
          >
            <Mic className="size-[14px] shrink-0" strokeWidth={1.5} aria-hidden />
          </button>
          <button
            type="button"
            className={`flex h-[20px] w-[20px] items-center justify-center rounded-full transition-opacity hover:opacity-80 ${sendButtonBgClass[mode]}`}
            aria-label="Send"
          >
            <ArrowUp className="size-3 text-[var(--bg-main)]" strokeWidth={2.5} />
          </button>
        </div>
      </div>
    </div>
  );
}
