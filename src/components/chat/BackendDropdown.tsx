"use client";

import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Check, ChevronDown, Sparkles, type LucideProps } from "lucide-react";
import { useClickOutside } from "@/hooks/useClickOutside";
import { usePopover } from "@/hooks/usePopover";
import type { AgentBackendId, AgentBackendInfo } from "@/lib/agent-types";

function renderBackendIcon(id: AgentBackendId, props: LucideProps) {
  if (id === "cursor-acp") {
    return <Sparkles {...props} />;
  }
  return <Bot {...props} />;
}

interface BackendDropdownProps {
  backendId: AgentBackendId;
  backends: AgentBackendInfo[];
  onBackendChange?: (backendId: AgentBackendId) => void;
  popoverPlacement?: "above" | "below";
  disabled?: boolean;
}

export function BackendDropdown({
  backendId,
  backends,
  onBackendChange,
  popoverPlacement = "above",
  disabled = false,
}: BackendDropdownProps) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { triggerRef, popoverRef, position, ready } = usePopover(open, {
    placement: popoverPlacement,
  });
  useClickOutside(triggerRef, close, open, [popoverRef]);

  const options = useMemo(() => backends, [backends]);
  const current = options.find((option) => option.id === backendId) ?? null;

  return (
    <div ref={triggerRef}>
      <button
        type="button"
        disabled={disabled || !current}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-[4px] rounded-[var(--radius-pill)] bg-[var(--bg-panel)] px-[6px] py-[1px] text-[var(--text-secondary)] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {current
          ? renderBackendIcon(current.id, {
              className: "size-[13px] shrink-0",
              strokeWidth: 1.5,
            })
          : (
              <Bot className="size-[13px] shrink-0" strokeWidth={1.5} />
            )}
        <span className="font-sans text-[13px] font-normal text-[var(--text-primary)]">
          {current?.label ?? backendId}
        </span>
        <ChevronDown className="size-[8px] shrink-0" strokeWidth={2.5} />
      </button>

      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-[9999] w-[240px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] py-[4px] transition-opacity"
            style={{
              ...(position.top != null
                ? { top: position.top }
                : { bottom: position.bottom ?? 0 }),
              left: position.left,
              opacity: ready ? 1 : 0,
              maxHeight: position.maxHeight,
              overflow: "auto",
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {options.map((option) => {
              const active = option.id === backendId;
              const unavailable = !option.available;
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={unavailable}
                  onClick={() => {
                    if (unavailable) return;
                    onBackendChange?.(option.id);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-[8px] px-[12px] py-[6px] text-left transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {renderBackendIcon(option.id, {
                    className: "size-[15px] shrink-0",
                    strokeWidth: 1.5,
                    style: {
                      color: active
                        ? "var(--text-primary)"
                        : "var(--text-secondary)",
                    },
                  })}
                  <span className="min-w-0 flex-1">
                    <span className="block font-sans text-[13px] font-normal text-[var(--text-primary)]">
                      {option.label}
                    </span>
                    <span className="block truncate font-sans text-[11px] text-[var(--text-secondary)]">
                      {option.experimental && !option.available
                        ? "Experimental adapter placeholder"
                        : option.description}
                    </span>
                  </span>
                  {active && (
                    <Check className="size-[14px] shrink-0 text-[var(--text-primary)]" strokeWidth={2} />
                  )}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}
