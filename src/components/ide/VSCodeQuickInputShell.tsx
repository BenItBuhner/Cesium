"use client";

import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";

const shell =
  "flex w-full max-w-[640px] flex-col overflow-hidden rounded-[5px] border border-[#3c3c3c] bg-[#252526] shadow-[0_16px_48px_rgba(0,0,0,0.55)]";

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
      className="fixed inset-0 z-[10050] flex items-start justify-center pt-[12vh] px-4"
      role="presentation"
    >
      <div
        className="absolute inset-0 bg-black/45"
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
        <div className="border-b border-[#3c3c3c] px-[10px] py-[6px]">
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
            className="box-border w-full border-0 bg-transparent py-[6px] font-sans text-[13px] text-[#cccccc] outline-none ring-0 placeholder:text-[#767676] focus:outline-none focus:ring-0"
          />
        </div>
        {children}
        {footer ? (
          <div className="border-t border-[#2a2a2a] px-[10px] py-[6px]">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}
