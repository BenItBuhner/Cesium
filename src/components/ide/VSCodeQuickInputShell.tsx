"use client";

import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
} from "react";
import {
  HardwareAwareTextInput,
  type TextSurfaceController,
} from "@/components/input/HardwareAwareTextField";

const shell =
  "flex w-full max-w-[640px] flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--palette-border)] bg-[var(--palette-surface)] shadow-[var(--palette-shadow)]";

export function VSCodeQuickInputShell({
  open,
  onClose,
  screenReaderTitle,
  inputLabel,
  placeholder,
  value,
  onChange,
  onKeyDown,
  onHardwareKeyDown,
  inputRef: inputRefProp,
  children,
  footer,
  hideInput = false,
}: {
  open: boolean;
  onClose: () => void;
  screenReaderTitle: string;
  inputLabel: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  onHardwareKeyDown?: (
    event: globalThis.KeyboardEvent,
    controller: TextSurfaceController
  ) => boolean;
  inputRef?: MutableRefObject<HTMLElement | null>;
  children: ReactNode;
  footer?: ReactNode;
  /** List-only quick pick (e.g. agent switcher hold-cycle). */
  hideInput?: boolean;
}) {
  const inputId = useId();
  const titleId = useId();
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const internalRef = useRef<HTMLElement | null>(null);
  const inputRef = inputRefProp ?? internalRef;

  useEffect(() => {
    if (!open) return;

    const handleDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") {
        return;
      }

      const overlay = overlayRef.current;
      if (!overlay) {
        return;
      }

      const openPalettes = Array.from(
        document.querySelectorAll<HTMLElement>("[data-ide-palette]")
      );
      if (openPalettes.at(-1) !== overlay) {
        return;
      }

      event.preventDefault();
      onClose();
    };

    document.addEventListener("keydown", handleDocumentKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleDocumentKeyDown, true);
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      data-ide-palette
      className="fixed inset-0 z-[10050] flex items-start justify-center px-4 pt-[12vh]"
      role="presentation"
    >
      <div
        className="absolute inset-0 bg-[var(--palette-backdrop)]"
        aria-hidden
        onPointerDown={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        className={`relative ${shell}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId} className="sr-only">
          {screenReaderTitle}
        </h2>
        {hideInput ? (
          <div className="border-b border-[var(--palette-divider)] px-[10px] py-[8px]">
            <p className="font-sans text-[12px] text-[var(--palette-footer-text)]">
              {inputLabel}
            </p>
          </div>
        ) : (
          <div className="border-b border-[var(--palette-divider)] px-[10px] py-[6px]">
            <label htmlFor={inputId} className="sr-only">
              {inputLabel}
            </label>
            <HardwareAwareTextInput
              inputRef={inputRef}
              id={inputId}
              placeholder={placeholder}
              value={value}
              onChange={onChange}
              onNativeKeyDown={onKeyDown}
              onHardwareKeyDown={onHardwareKeyDown}
              type="text"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              surfaceKind="palette"
              className="box-border w-full border-0 bg-transparent py-[6px] font-sans text-[13px] text-[var(--palette-input-text)] outline-none ring-0 placeholder:text-[var(--palette-placeholder)] focus:outline-none focus:ring-0"
              ariaLabel={inputLabel}
            />
          </div>
        )}
        {children}
        {footer ? (
          <div className="border-t border-[var(--palette-divider)] px-[10px] py-[6px]">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
