"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { VerticalFadedScroll } from "@/components/chat/VerticalFadedScroll";
import { useClickOutside } from "@/hooks/useClickOutside";
import { usePopover, type PopoverPlacement } from "@/hooks/usePopover";

const popoverClass =
  "rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)]";

export type SettingsSelectOption = {
  value: string;
  label: string;
};

type SettingsThemeSelectProps = {
  value: string;
  options: SettingsSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  /** Width / layout for the outer trigger wrapper (e.g. w-full max-w-[…]). */
  className?: string;
  /** Classes for the trigger button (typically border, bg, text tokens). */
  triggerClassName: string;
  placement?: PopoverPlacement;
  disabled?: boolean;
};

export function SettingsThemeSelect({
  value,
  options,
  onChange,
  ariaLabel,
  className = "",
  triggerClassName,
  placement = "below",
  disabled = false,
}: SettingsThemeSelectProps) {
  const [open, setOpen] = useState(false);
  const [menuWidth, setMenuWidth] = useState<number>(0);
  const close = useCallback(() => setOpen(false), []);
  const { triggerRef, popoverRef, position, ready } = usePopover(open, { placement });

  useClickOutside(triggerRef, close, open, [popoverRef]);

  useEffect(() => {
    if (!open) {
      return;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = triggerRef.current;
        if (el) {
          setMenuWidth(el.getBoundingClientRect().width);
        }
      });
    });
  }, [open, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  const selected = options.find((o) => o.value === value);
  const label = selected?.label ?? value;

  return (
    <div ref={triggerRef} className={className}>
      <button
        type="button"
        disabled={disabled || options.length === 0}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (!disabled && options.length > 0) setOpen((v) => !v);
        }}
        className={`${triggerClassName} text-left`}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronDown
          className={`size-[14px] shrink-0 text-[var(--text-secondary)] transition-transform duration-150 ${
            open ? "rotate-180" : ""
          }`}
          strokeWidth={2}
          aria-hidden
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={popoverRef}
            data-ide-input-sink
            role="listbox"
            aria-label={ariaLabel}
            className={`fixed z-[9999] overflow-hidden ${popoverClass}`}
            style={{
              ...(position.top != null
                ? { top: position.top }
                : { bottom: position.bottom ?? 0 }),
              left: position.left,
              width: menuWidth > 0 ? menuWidth : undefined,
              minWidth: menuWidth > 0 ? menuWidth : 200,
              maxHeight: position.maxHeight,
              opacity: ready ? 1 : 0,
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="min-h-0" style={{ maxHeight: position.maxHeight }}>
              <VerticalFadedScroll
                measureKey={`${options.length}:${value}`}
                edgeColorVar="var(--bg-panel)"
                scrollClassName="hide-scrollbar-y max-h-full min-h-0 overflow-y-auto overscroll-contain py-[4px]"
              >
                {options.map((o) => {
                  const active = o.value === value;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        onChange(o.value);
                        close();
                      }}
                      className="flex w-full items-center gap-[8px] px-[12px] py-[6px] text-left font-sans text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]"
                    >
                      <span className="min-w-0 flex-1 truncate">{o.label}</span>
                      {active ? (
                        <Check className="size-[14px] shrink-0 text-[var(--text-primary)]" strokeWidth={2} />
                      ) : (
                        <span className="size-[14px] shrink-0" aria-hidden />
                      )}
                    </button>
                  );
                })}
              </VerticalFadedScroll>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
