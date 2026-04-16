"use client";

import { useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check, SlidersHorizontal } from "lucide-react";
import { useClickOutside } from "@/hooks/useClickOutside";
import { usePopover } from "@/hooks/usePopover";
import type { AgentConfigOption } from "@/lib/agent-types";

interface SessionConfigOptionDropdownProps {
  option: AgentConfigOption;
  value: string;
  onChange: (next: string) => void;
  popoverPlacement?: "above" | "below";
  disabled?: boolean;
}

export function SessionConfigOptionDropdown({
  option,
  value,
  onChange,
  popoverPlacement = "above",
  disabled = false,
}: SessionConfigOptionDropdownProps) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { triggerRef, popoverRef, position, ready } = usePopover(open, {
    placement: popoverPlacement,
  });
  useClickOutside(triggerRef, close, open, [popoverRef]);

  const current = useMemo(() => {
    return (
      option.options.find((o) => o.value === value) ??
      option.options.find((o) => o.value === option.currentValue) ??
      option.options[0]
    );
  }, [option, value]);

  const label = option.name || "Option";

  return (
    <div ref={triggerRef} className="inline-flex max-w-full min-w-0">
      <button
        type="button"
        disabled={disabled}
        title={option.description ?? label}
        onClick={() => setOpen((v) => !v)}
        className="flex max-w-[140px] items-center gap-[4px] rounded-[var(--radius-pill)] px-[6px] py-[1px] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
        style={{ background: "var(--bg-input)" }}
      >
        <SlidersHorizontal
          className="size-[11px] shrink-0 text-[var(--text-secondary)]"
          strokeWidth={1.5}
        />
        <span className="min-w-0 truncate font-sans text-[12px] font-normal text-[var(--text-secondary)]">
          {current?.name ?? label}
        </span>
        <ChevronDown
          className="size-[7px] shrink-0 text-[var(--text-secondary)]"
          strokeWidth={2.5}
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-[9999] min-w-[200px] max-w-[280px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] py-[4px] transition-opacity"
            data-ide-input-sink
            data-ide-composer-floating-popover
            style={{
              ...(position.top != null
                ? { top: position.top }
                : { bottom: position.bottom ?? 0 }),
              left: position.left,
              opacity: ready ? 1 : 0,
              maxHeight: Math.min(position.maxHeight ?? 320, 320),
              overflow: "auto",
              overscrollBehavior: "contain",
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <div className="border-b border-[var(--border-card)] px-[12px] py-[6px]">
              <p className="font-sans text-[11px] font-medium uppercase tracking-wide text-[var(--text-disabled)]">
                {label}
              </p>
            </div>
            <div className="py-[2px]">
              {option.options.map((opt) => {
                const active = opt.value === (current?.value ?? value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    title={opt.description ?? opt.name}
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-[8px] px-[12px] py-[5px] text-left transition-colors hover:bg-white/[0.06]"
                  >
                    <span
                      className="min-w-0 flex-1 truncate font-sans text-[13px] font-normal"
                      style={{
                        color: active ? "var(--text-primary)" : "var(--text-secondary)",
                      }}
                    >
                      {opt.name}
                    </span>
                    {active && (
                      <Check
                        className="size-[14px] shrink-0 text-[var(--text-primary)]"
                        strokeWidth={2}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
