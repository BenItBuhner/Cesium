"use client";

import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";

const shell =
  "flex w-full max-w-[640px] flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--palette-border)] bg-[var(--palette-surface)] shadow-[var(--palette-shadow)]";

export function VSCodeQuickInputShell({
  open,
  screenReaderTitle,
  inputLabel,
  placeholder,
  value,
  onChange,
  onKeyDown,
  inputRef: inputRefProp,
  children,
  footer,
}: {
  open: boolean;
  screenReaderTitle: string;
  inputLabel: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const inputId = useId();
  const titleId = useId();
  const internalRef = useRef<HTMLInputElement>(null);
  const inputRef = inputRefProp ?? internalRef;

  useEffect(() => {
    if (!open) return;
    const t = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(t);
  }, [open, inputRef]);

  if (!open) return null;

  return (
    <div
      data-ide-palette
      className="fixed inset-0 z-[10050] flex items-start justify-center px-4 pt-[12vh]"
      role="presentation"
    >
      <div
        className="absolute inset-0 bg-[var(--palette-backdrop)]"
        aria-hidden
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
        <div className="border-b border-[var(--palette-divider)] px-[10px] py-[6px]">
          <label htmlFor={inputId} className="sr-only">
            {inputLabel}
          </label>
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            className="box-border w-full border-0 bg-transparent py-[6px] font-sans text-[13px] text-[var(--palette-input-text)] outline-none ring-0 placeholder:text-[var(--palette-placeholder)] focus:outline-none focus:ring-0"
          />
        </div>
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
