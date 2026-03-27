"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useId,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ArrowUp, Mic, Upload } from "lucide-react";
import { useHardwareInput } from "@/components/input/HardwareInputProvider";
import {
  applyTextBufferKey,
  clampSelection,
  replaceSelection,
  type TextSelection,
} from "@/components/input/text-buffer";
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
  getCaretClientRect,
  getCaretOffset,
  parseTriggerToken,
  replaceTextRange,
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

function resolvePointerSelection(
  event: ReactPointerEvent<HTMLElement>,
  valueLength: number
): TextSelection {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return { start: valueLength, end: valueLength };
  }

  const char = target.closest("[data-faux-offset-start]") as HTMLElement | null;
  if (!char) {
    return { start: valueLength, end: valueLength };
  }

  const start = Number(char.dataset.fauxOffsetStart ?? valueLength);
  const end = Number(char.dataset.fauxOffsetEnd ?? start);
  const rect = char.getBoundingClientRect();
  const midpoint = rect.left + rect.width / 2;
  const next = event.clientX < midpoint ? start : end;
  return { start: next, end: next };
}

function renderComposerText(
  value: string,
  selection: TextSelection,
  active: boolean,
  caretRef: { current: HTMLSpanElement | null }
) {
  const safe = clampSelection(value, selection);
  const nodes: JSX.Element[] = [];

  if (value.length === 0) {
    if (active) {
      nodes.push(
        <span
          key="caret"
          ref={(node) => {
            caretRef.current = node;
          }}
          className="inline-block h-[1.1em] w-px align-middle bg-[var(--text-primary)]"
          data-faux-caret
        />
      );
    }
    return nodes;
  }

  for (let index = 0; index < value.length; index += 1) {
    if (active && safe.start === safe.end && safe.start === index) {
      nodes.push(
        <span
          key={`caret-${index}`}
          ref={(node) => {
            caretRef.current = node;
          }}
          className="inline-block h-[1.1em] w-px align-middle bg-[var(--text-primary)]"
          data-faux-caret
        />
      );
    }

    const char = value[index]!;
    const selected = index >= safe.start && index < safe.end;
    nodes.push(
      <span
        key={`char-${index}`}
        data-faux-offset-start={index}
        data-faux-offset-end={index + 1}
        className={
          selected
            ? "rounded-[2px] bg-[var(--accent-bg)] text-[var(--text-primary)]"
            : undefined
        }
      >
        {char === " " ? "\u00a0" : char}
      </span>
    );
  }

  if (active && safe.start === safe.end && safe.end === value.length) {
    nodes.push(
      <span
        key={`caret-${value.length}`}
        ref={(node) => {
          caretRef.current = node;
        }}
        className="inline-block h-[1.1em] w-px align-middle bg-[var(--text-primary)]"
        data-faux-caret
      />
    );
  }

  return nodes;
}

export function ChatComposer({
  mode,
  onModeChange,
  model,
  onModelChange,
  layout = "docked-bottom",
}: ChatComposerProps) {
  const surfaceId = useId().replace(/:/g, "_");
  const {
    enabled: hardwareInputEnabled,
    registerSurface,
    unregisterSurface,
    activateSurface,
    deactivateSurface,
    isSurfaceActive,
  } = useHardwareInput();
  const [value, setValue] = useState("");
  const [selection, setSelection] = useState<TextSelection>({
    start: 0,
    end: 0,
  });
  const [hasFocus, setHasFocus] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [menuPos, setMenuPos] = useState<ComposerPopoverPosition>({
    placement: "above",
    bottom: 100,
    left: 8,
    maxHeight: 280,
  });

  const editorRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLSpanElement | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<MenuState | null>(null);
  const valueRef = useRef(value);
  const selectionRef = useRef(selection);
  const filteredAtRef = useRef<AtSuggestion[]>([]);
  const filteredSlashRef = useRef<SlashSuggestion[]>([]);
  const selectedIndexRef = useRef(selectedIndex);
  menuRef.current = menu;

  const filteredAt = useMemo(
    () => (menu?.kind === "at" ? filterAtSuggestions(AT_LIST, menu.query) : []),
    [menu]
  );
  const filteredSlash = useMemo(
    () =>
      menu?.kind === "slash"
        ? filterSlashSuggestions(SLASH_COMMANDS, menu.query)
        : [],
    [menu]
  );

  const isActive = hardwareInputEnabled
    ? isSurfaceActive(surfaceId)
    : hasFocus;
  const isEmpty = value.trim().length === 0;

  useEffect(() => {
    valueRef.current = value;
    selectionRef.current = selection;
  }, [selection, value]);

  useEffect(() => {
    filteredAtRef.current = filteredAt;
    filteredSlashRef.current = filteredSlash;
  }, [filteredAt, filteredSlash]);

  useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  useEffect(() => {
    const trig = parseTriggerToken(value, selection.end);
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
  }, [selection.end, value]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [menu?.query, menu?.kind, menu?.start]);

  useLayoutEffect(() => {
    if (!menu || !editorRef.current) return;
    const rect =
      (hardwareInputEnabled
        ? caretRef.current?.getBoundingClientRect()
        : getCaretClientRect(editorRef.current)) ??
      editorRef.current.getBoundingClientRect();
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
  }, [hardwareInputEnabled, menu, selection.end, value]);

  useClickOutside(editorRef, () => setMenu(null), !!menu, [popoverRef]);

  useEffect(() => {
    setSelection((prev) => clampSelection(value, prev));
  }, [value]);

  const syncNativeState = useCallback(() => {
    if (hardwareInputEnabled) return;
    const el = editorRef.current;
    if (!el) return;
    const text = el.textContent ?? "";
    const caret = getCaretOffset(el);
    setValue(text);
    setSelection({ start: caret, end: caret });
  }, [hardwareInputEnabled]);

  useEffect(() => {
    if (hardwareInputEnabled) return;
    const el = editorRef.current;
    if (!el) return;
    if (el.textContent !== value) {
      el.textContent = value;
    }
  }, [hardwareInputEnabled, value]);

  useEffect(() => {
    if (hardwareInputEnabled) return;
    const el = editorRef.current;
    if (!el) return;
    const doc = el.ownerDocument;
    const onSelectionChange = () => {
      const box = editorRef.current;
      if (!box) return;
      const sel = doc.getSelection();
      if (!sel?.anchorNode || !box.contains(sel.anchorNode)) return;
      syncNativeState();
    };
    doc.addEventListener("selectionchange", onSelectionChange);
    return () => doc.removeEventListener("selectionchange", onSelectionChange);
  }, [hardwareInputEnabled, syncNativeState]);

  const pickAt = useCallback(
    (item: AtSuggestion) => {
      const currentMenu = menuRef.current;
      if (!currentMenu || currentMenu.kind !== "at") return;
      if (!hardwareInputEnabled && editorRef.current) {
        replaceTextRange(
          editorRef.current,
          currentMenu.start,
          currentMenu.end,
          `${item.insert} `
        );
        syncNativeState();
        setMenu(null);
        return;
      }
      const next = replaceSelection(
        valueRef.current,
        { start: currentMenu.start, end: currentMenu.end },
        `${item.insert} `
      );
      valueRef.current = next.value;
      selectionRef.current = next.selection;
      setValue(next.value);
      setSelection(next.selection);
      setMenu(null);
    },
    [hardwareInputEnabled, syncNativeState]
  );

  const pickSlash = useCallback(
    (item: SlashSuggestion) => {
      const currentMenu = menuRef.current;
      if (!currentMenu || currentMenu.kind !== "slash") return;
      if (!hardwareInputEnabled && editorRef.current) {
        replaceTextRange(
          editorRef.current,
          currentMenu.start,
          currentMenu.end,
          `${item.insert} `
        );
        syncNativeState();
        setMenu(null);
        return;
      }
      const next = replaceSelection(
        valueRef.current,
        { start: currentMenu.start, end: currentMenu.end },
        `${item.insert} `
      );
      valueRef.current = next.value;
      selectionRef.current = next.selection;
      setValue(next.value);
      setSelection(next.selection);
      setMenu(null);
    },
    [hardwareInputEnabled, syncNativeState]
  );

  const handleComposerKey = useCallback(
    (event: globalThis.KeyboardEvent) => {
      const currentMenu = menuRef.current;
      const items =
        currentMenu?.kind === "at"
          ? filteredAtRef.current
          : filteredSlashRef.current;

      if (currentMenu && event.key === "Escape") {
        event.preventDefault();
        setMenu(null);
        return true;
      }
      if (currentMenu && event.key === "ArrowDown") {
        event.preventDefault();
        if (items.length === 0) return true;
        setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
        return true;
      }
      if (currentMenu && event.key === "ArrowUp") {
        event.preventDefault();
        if (items.length === 0) return true;
        setSelectedIndex((i) => Math.max(0, i - 1));
        return true;
      }
      if (
        currentMenu &&
        event.key === "Enter" &&
        !event.shiftKey &&
        items.length > 0
      ) {
        event.preventDefault();
        const idx = Math.min(selectedIndexRef.current, items.length - 1);
        if (currentMenu.kind === "at") {
          pickAt(items[idx] as AtSuggestion);
        } else {
          pickSlash(items[idx] as SlashSuggestion);
        }
        return true;
      }

      const next = applyTextBufferKey(
        valueRef.current,
        selectionRef.current,
        event,
        {
          multiline: true,
        }
      );
      if (!next.handled) return false;
      event.preventDefault();
      if (next.value !== valueRef.current) {
        valueRef.current = next.value;
        setValue(next.value);
      }
      selectionRef.current = next.selection;
      setSelection(next.selection);
      return true;
    },
    [pickAt, pickSlash]
  );

  const handleNativeComposerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!menu) return;
      const items = menu.kind === "at" ? filteredAt : filteredSlash;

      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(null);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (items.length === 0) return;
        setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (items.length === 0) return;
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && items.length > 0) {
        event.preventDefault();
        const idx = Math.min(selectedIndex, items.length - 1);
        if (menu.kind === "at") {
          pickAt(items[idx] as AtSuggestion);
        } else {
          pickSlash(items[idx] as SlashSuggestion);
        }
      }
    },
    [filteredAt, filteredSlash, menu, pickAt, pickSlash, selectedIndex]
  );

  useEffect(() => {
    if (!hardwareInputEnabled) {
      unregisterSurface(surfaceId);
      return;
    }

    registerSurface(surfaceId, {
      id: surfaceId,
      kind: "chat",
      allowWorkbenchShortcuts: false,
      focusTarget: editorRef.current,
      onKeyDown: (event) => handleComposerKey(event),
      onPaste: (text) => {
        const next = replaceSelection(
          valueRef.current,
          selectionRef.current,
          text
        );
        valueRef.current = next.value;
        selectionRef.current = next.selection;
        setValue(next.value);
        setSelection(next.selection);
        return true;
      },
      onCopy: () => {
        const currentSelection = selectionRef.current;
        if (currentSelection.start === currentSelection.end) return null;
        return valueRef.current.slice(
          currentSelection.start,
          currentSelection.end
        );
      },
      onCut: () => {
        const currentSelection = selectionRef.current;
        if (currentSelection.start === currentSelection.end) return null;
        const selected = valueRef.current.slice(
          currentSelection.start,
          currentSelection.end
        );
        const next = replaceSelection(
          valueRef.current,
          currentSelection,
          ""
        );
        valueRef.current = next.value;
        selectionRef.current = next.selection;
        setValue(next.value);
        setSelection(next.selection);
        return selected;
      },
    });

    return () => unregisterSurface(surfaceId);
  }, [
    handleComposerKey,
    hardwareInputEnabled,
    registerSurface,
    surfaceId,
    unregisterSurface,
  ]);

  const shellMargin =
    layout === "empty-top"
      ? "mx-[10px] mt-[10px] mb-0"
      : "mx-[10px] mb-[10px]";

  const modeModelPopoverPlacement =
    layout === "empty-top" ? "below" : "above";

  const textNodes = useMemo(
    () => renderComposerText(value, selection, isActive, caretRef),
    [isActive, selection, value]
  );

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
          contentEditable={!hardwareInputEnabled}
          suppressContentEditableWarning={!hardwareInputEnabled}
          tabIndex={hardwareInputEnabled ? 0 : undefined}
          onPointerDown={(event) => {
            if (hardwareInputEnabled) {
              activateSurface(surfaceId, editorRef.current);
              setSelection(resolvePointerSelection(event, value.length));
            }
          }}
          onMouseUp={() => {
            if (!hardwareInputEnabled) {
              syncNativeState();
            }
          }}
          onFocus={() => {
            setHasFocus(true);
            if (hardwareInputEnabled) {
              activateSurface(surfaceId, editorRef.current);
            }
          }}
          onBlur={() => {
            setHasFocus(false);
            if (hardwareInputEnabled) {
              deactivateSurface(surfaceId);
            }
          }}
          onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
            if (hardwareInputEnabled) {
              return;
            }
            handleNativeComposerKeyDown(event);
          }}
          onInput={() => {
            if (!hardwareInputEnabled) {
              syncNativeState();
            }
          }}
          onPaste={(event: ReactClipboardEvent<HTMLDivElement>) => {
            if (!hardwareInputEnabled) return;
            event.preventDefault();
            const next = replaceSelection(
              value,
              selection,
              event.clipboardData.getData("text/plain")
            );
            setValue(next.value);
            setSelection(next.selection);
          }}
          onCopy={(event: ReactClipboardEvent<HTMLDivElement>) => {
            if (!hardwareInputEnabled || selection.start === selection.end) return;
            event.preventDefault();
            event.clipboardData.setData(
              "text/plain",
              value.slice(selection.start, selection.end)
            );
          }}
          onCut={(event: ReactClipboardEvent<HTMLDivElement>) => {
            if (!hardwareInputEnabled || selection.start === selection.end) return;
            event.preventDefault();
            event.clipboardData.setData(
              "text/plain",
              value.slice(selection.start, selection.end)
            );
            const next = replaceSelection(value, selection, "");
            setValue(next.value);
            setSelection(next.selection);
          }}
          className="min-h-[18px] whitespace-pre-wrap break-words font-sans text-[14px] font-normal text-[var(--text-primary)] outline-none"
          role={menu ? "combobox" : "textbox"}
          aria-label="Chat input"
          aria-expanded={menu ? true : undefined}
          aria-controls={menu ? "composer-autocomplete" : undefined}
          aria-autocomplete={menu ? "list" : undefined}
          aria-multiline
          data-hardware-input-surface={hardwareInputEnabled ? "" : undefined}
          data-hardware-surface-kind={hardwareInputEnabled ? "chat" : undefined}
        >
          {hardwareInputEnabled ? textNodes : null}
        </div>
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
