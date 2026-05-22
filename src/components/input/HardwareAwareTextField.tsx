"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEventHandler,
  type MutableRefObject,
  type PointerEvent,
  type ReactElement,
} from "react";
import { useHardwareInput } from "@/components/input/HardwareInputProvider";
import type { HardwareSurfaceKind } from "@/components/input/hardware-input-types";
import { shouldAutoFocusTextInput } from "@/lib/mobile-autofocus";
import {
  applyTextBufferKey,
  clampSelection,
  getSelectedText,
  hasSelection,
  replaceSelection,
  type TextSelection,
} from "@/components/input/text-buffer";

export type TextSurfaceController = {
  selection: TextSelection;
  setSelection: (selection: TextSelection) => void;
  replaceSelection: (insert: string) => void;
};

type SharedProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  id?: string;
  autoFocus?: boolean;
  allowWorkbenchShortcuts?: boolean;
  inputRef?: MutableRefObject<HTMLElement | null>;
  onHardwareKeyDown?: (
    event: KeyboardEvent,
    controller: TextSurfaceController
  ) => boolean;
  onNativeKeyDown?: KeyboardEventHandler<HTMLInputElement | HTMLTextAreaElement>;
  onFocus?: () => void;
  onBlur?: () => void;
  role?: string;
  ariaControls?: string;
  ariaExpanded?: boolean;
  ariaAutocomplete?: "none" | "inline" | "list" | "both";
  autoComplete?: string;
  spellCheck?: boolean;
  surfaceKind?: HardwareSurfaceKind;
  multiline?: boolean;
  type?: "text" | "search";
  rows?: number;
};

function assignRef(
  targetRef: MutableRefObject<HTMLElement | null> | undefined,
  value: HTMLElement | null
) {
  if (targetRef) {
    targetRef.current = value;
  }
}

function resolvePointerSelection(
  event: PointerEvent<HTMLElement>,
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

function renderTextNodes(
  value: string,
  selection: TextSelection,
  active: boolean
) {
  const safe = clampSelection(value, selection);
  const nodes: ReactElement[] = [];

  if (value.length === 0) {
    if (active) {
      nodes.push(
        <span
          key="caret"
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
        className="inline-block h-[1.1em] w-px align-middle bg-[var(--text-primary)]"
        data-faux-caret
      />
    );
  }

  return nodes;
}

function HardwareAwareTextSurface({
  value,
  onChange,
  placeholder,
  className,
  ariaLabel,
  id,
  autoFocus = false,
  allowWorkbenchShortcuts = false,
  inputRef,
  onHardwareKeyDown,
  onNativeKeyDown,
  onFocus,
  onBlur,
  role = "textbox",
  ariaControls,
  ariaExpanded,
  ariaAutocomplete,
  autoComplete,
  spellCheck = false,
  surfaceKind = "text",
  multiline = false,
  type = "text",
  rows = 1,
}: SharedProps) {
  const generatedId = useId().replace(/:/g, "_");
  const surfaceId = `hardware-surface-${generatedId}`;
  const { enabled, registerSurface, unregisterSurface, activateSurface, deactivateSurface, isSurfaceActive } =
    useHardwareInput();
  const [selection, setSelectionState] = useState<TextSelection>({
    start: value.length,
    end: value.length,
  });
  const fauxRef = useRef<HTMLDivElement | null>(null);
  const nativeRef = useRef<HTMLElement | null>(null);
  const valueRef = useRef(value);
  const selectionRef = useRef(selection);
  const onChangeRef = useRef(onChange);
  const onHardwareKeyDownRef = useRef(onHardwareKeyDown);
  const autoFocusEnabled = autoFocus && shouldAutoFocusTextInput();

  const setSelection = useCallback(
    (next: TextSelection) => {
      setSelectionState(clampSelection(valueRef.current, next));
    },
    []
  );

  const replaceCurrentSelection = useCallback(
    (insert: string) => {
      const next = replaceSelection(
        valueRef.current,
        selectionRef.current,
        insert
      );
      valueRef.current = next.value;
      selectionRef.current = next.selection;
      onChangeRef.current(next.value);
      setSelectionState(next.selection);
    },
    []
  );

  const setNativeInputRef = useCallback((node: HTMLInputElement | null) => {
    nativeRef.current = node;
  }, []);

  const setNativeTextareaRef = useCallback((node: HTMLTextAreaElement | null) => {
    nativeRef.current = node;
  }, []);

  useEffect(() => {
    valueRef.current = value;
    selectionRef.current = selection;
    onChangeRef.current = onChange;
    onHardwareKeyDownRef.current = onHardwareKeyDown;
  }, [onChange, onHardwareKeyDown, selection, value]);

  useEffect(() => {
    setSelectionState((prev) => clampSelection(value, prev));
  }, [value]);

  useEffect(() => {
    assignRef(inputRef, enabled ? fauxRef.current : nativeRef.current);
  }, [enabled, inputRef]);

  useEffect(() => {
    if (!enabled) {
      unregisterSurface(surfaceId);
      return;
    }

    registerSurface(surfaceId, {
      id: surfaceId,
      kind: surfaceKind,
      allowWorkbenchShortcuts,
      focusTarget: fauxRef.current,
      onKeyDown: (event) => {
        const controller: TextSurfaceController = {
          selection: selectionRef.current,
          setSelection,
          replaceSelection: replaceCurrentSelection,
        };

        if (onHardwareKeyDownRef.current?.(event, controller)) {
          event.preventDefault();
          return true;
        }

        const currentValue = valueRef.current;
        const currentSelection = selectionRef.current;
        const next = applyTextBufferKey(currentValue, currentSelection, event, {
          multiline,
        });
        if (!next.handled) {
          return {
            handled: false,
            allowWorkbenchShortcuts,
          };
        }

        event.preventDefault();
        if (next.value !== currentValue) {
          valueRef.current = next.value;
          onChangeRef.current(next.value);
        }
        selectionRef.current = next.selection;
        setSelectionState(next.selection);
        return true;
      },
      onPaste: (text) => {
        replaceCurrentSelection(text);
        return true;
      },
      onCopy: () => {
        if (!hasSelection(selectionRef.current)) return null;
        return getSelectedText(valueRef.current, selectionRef.current);
      },
      onCut: () => {
        if (!hasSelection(selectionRef.current)) return null;
        const selected = getSelectedText(valueRef.current, selectionRef.current);
        replaceCurrentSelection("");
        return selected;
      },
    });

    return () => unregisterSurface(surfaceId);
  }, [
    allowWorkbenchShortcuts,
    enabled,
    multiline,
    registerSurface,
    replaceCurrentSelection,
    setSelection,
    surfaceId,
    surfaceKind,
    unregisterSurface,
  ]);

  useEffect(() => {
    if (!enabled || !autoFocusEnabled) return;
    activateSurface(surfaceId, fauxRef.current);
  }, [activateSurface, autoFocusEnabled, enabled, surfaceId]);

  const active = enabled && isSurfaceActive(surfaceId);
  const nodes = useMemo(
    () => renderTextNodes(value, selection, active),
    [active, selection, value]
  );
  const placeholderClassName = multiline
    ? "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-left leading-[inherit] text-[var(--text-disabled)]"
    : "pointer-events-none absolute inset-y-0 left-0 right-0 flex items-center justify-start overflow-hidden whitespace-nowrap text-left leading-[inherit] text-[var(--text-disabled)]";
  const contentClassName = multiline
    ? "relative min-h-[1.1em] w-full whitespace-pre-wrap break-words text-left leading-[inherit]"
    : "relative flex h-full min-h-[1.1em] w-full items-center justify-start overflow-hidden whitespace-pre text-left leading-[inherit]";
  const emptyCaretClassName = multiline
    ? "pointer-events-none absolute left-0 top-0 h-[1.1em] w-px bg-[var(--text-primary)]"
    : "pointer-events-none absolute left-0 top-1/2 h-[1.1em] w-px -translate-y-1/2 bg-[var(--text-primary)]";

  if (!enabled) {
    if (multiline) {
      return (
        <textarea
          ref={setNativeTextareaRef}
          id={id}
          rows={rows}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={className}
          aria-label={ariaLabel}
          autoFocus={autoFocusEnabled}
          onKeyDown={onNativeKeyDown as KeyboardEventHandler<HTMLTextAreaElement>}
          onFocus={onFocus}
          onBlur={onBlur}
          role={role}
          aria-controls={ariaControls}
          aria-expanded={ariaExpanded}
          aria-autocomplete={ariaAutocomplete}
          autoComplete={autoComplete}
          spellCheck={spellCheck}
        />
      );
    }

    return (
      <input
        ref={setNativeInputRef}
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={className}
        aria-label={ariaLabel}
        autoFocus={autoFocusEnabled}
        onKeyDown={onNativeKeyDown as KeyboardEventHandler<HTMLInputElement>}
        onFocus={onFocus}
        onBlur={onBlur}
        role={role}
        aria-controls={ariaControls}
        aria-expanded={ariaExpanded}
        aria-autocomplete={ariaAutocomplete}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
      />
    );
  }

  return (
    <div
      ref={fauxRef}
      id={id}
      tabIndex={0}
      role={role}
      aria-label={ariaLabel}
      aria-controls={ariaControls}
      aria-expanded={ariaExpanded}
      aria-autocomplete={ariaAutocomplete}
      aria-multiline={multiline || undefined}
      className={`${className ?? ""} relative cursor-text outline-none`}
      data-hardware-input-surface
      data-hardware-surface-kind={surfaceKind}
      onPointerDown={(event) => {
        activateSurface(surfaceId, fauxRef.current);
        setSelection(resolvePointerSelection(event, value.length));
      }}
      onFocus={() => {
        activateSurface(surfaceId, fauxRef.current);
        onFocus?.();
      }}
      onBlur={() => {
        deactivateSurface(surfaceId);
        onBlur?.();
      }}
    >
      <div className={contentClassName}>
        {value.length === 0 ? (
          <>
            <span className={placeholderClassName}>
              {placeholder ?? ""}
            </span>
            {active ? (
              <span
                className={emptyCaretClassName}
                data-faux-caret
              />
            ) : null}
          </>
        ) : (
          nodes
        )}
      </div>
    </div>
  );
}

export function HardwareAwareTextInput(
  props: Omit<SharedProps, "multiline" | "rows">
) {
  return <HardwareAwareTextSurface {...props} multiline={false} />;
}

export function HardwareAwareTextArea(
  props: Omit<SharedProps, "multiline" | "type">
) {
  return <HardwareAwareTextSurface {...props} multiline />;
}
