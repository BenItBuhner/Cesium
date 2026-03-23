"use client";

import { useState, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  Infinity,
  ListChecks,
  Bug,
  MessageSquare,
  ChevronDown,
  Check,
  type LucideIcon,
} from "lucide-react";
import { useClickOutside } from "@/hooks/useClickOutside";
import { usePopover } from "@/hooks/usePopover";
import type { EditorMode } from "@/lib/types";

interface ModeOption {
  id: EditorMode;
  label: string;
  icon: LucideIcon;
  shortcut?: string;
}

const modes: ModeOption[] = [
  { id: "agent", label: "Agent", icon: Infinity, shortcut: "Ctrl+I" },
  { id: "plan", label: "Plan", icon: ListChecks },
  { id: "debug", label: "Debug", icon: Bug },
  { id: "ask", label: "Ask", icon: MessageSquare },
];

const modeColors: Record<EditorMode, { text: string; bg: string }> = {
  agent: { text: "var(--accent)", bg: "var(--accent-bg)" },
  plan: { text: "var(--plan-accent)", bg: "var(--plan-accent-bg)" },
  debug: { text: "var(--debug-accent)", bg: "var(--debug-accent-bg)" },
  ask: { text: "var(--ask-accent)", bg: "var(--ask-accent-bg)" },
};

interface ModeDropdownProps {
  mode: EditorMode;
  onModeChange?: (mode: EditorMode) => void;
}

export function ModeDropdown({ mode, onModeChange }: ModeDropdownProps) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { triggerRef, popoverRef, position, ready } = usePopover(open);

  useClickOutside(triggerRef, close, open, [popoverRef]);

  const current = modes.find((m) => m.id === mode)!;
  const colors = modeColors[mode];
  const TriggerIcon = current.icon;

  return (
    <div ref={triggerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-[4px] rounded-[var(--radius-pill)] px-[6px] py-[1px] transition-opacity hover:opacity-80"
        style={{ background: colors.bg }}
      >
        <TriggerIcon className="size-[13px] shrink-0" style={{ color: colors.text }} strokeWidth={1.5} />
        <span className="font-sans text-[13px] font-normal" style={{ color: colors.text }}>
          {current.label}
        </span>
        <ChevronDown className="size-[8px] shrink-0" style={{ color: colors.text }} strokeWidth={2.5} />
      </button>

      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-[9999] w-[200px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] py-[4px] transition-opacity"
            style={{ bottom: position.bottom, left: position.left, opacity: ready ? 1 : 0, maxHeight: position.maxHeight, overflow: "auto" }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {modes.map((opt) => {
              const Icon = opt.icon;
              const active = opt.id === mode;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    onModeChange?.(opt.id);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-[8px] px-[12px] py-[6px] text-left transition-colors hover:bg-white/[0.06]"
                >
                  <Icon
                    className="size-[15px] shrink-0"
                    strokeWidth={1.5}
                    style={{ color: active ? colors.text : "var(--text-secondary)" }}
                  />
                  <span
                    className="flex-1 font-sans text-[13px] font-normal"
                    style={{ color: active ? "var(--text-primary)" : "var(--text-secondary)" }}
                  >
                    {opt.label}
                  </span>
                  {opt.shortcut && (
                    <span className="font-sans text-[11px] text-[var(--text-disabled)]">
                      {opt.shortcut}
                    </span>
                  )}
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
