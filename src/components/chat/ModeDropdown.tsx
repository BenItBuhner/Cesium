"use client";

import { useState, useCallback, useMemo, useRef, useLayoutEffect } from "react";
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
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import {
  detectShortcutPlatform,
  getShortcutDisplayForCommand,
} from "@/lib/keyboard-shortcuts";
import { DEFAULT_MODE_OPTIONS, ensureCurrentModeOption, getModeTone } from "@/lib/chat-modes";
import type { AgentModeOption, EditorMode, KnownEditorMode } from "@/lib/types";

interface ModeOption {
  id: EditorMode;
  label: string;
  description?: string;
  icon: LucideIcon;
  tone: KnownEditorMode;
  shortcut?: string;
}

const modeColors: Record<KnownEditorMode, { text: string; bg: string }> = {
  agent: { text: "var(--accent)", bg: "var(--accent-bg)" },
  plan: { text: "var(--plan-accent)", bg: "var(--plan-accent-bg)" },
  debug: { text: "var(--debug-accent)", bg: "var(--debug-accent-bg)" },
  ask: { text: "var(--ask-accent)", bg: "var(--ask-accent-bg)" },
};

function iconForModeTone(tone: KnownEditorMode): LucideIcon {
  switch (tone) {
    case "plan":
      return ListChecks;
    case "debug":
      return Bug;
    case "ask":
      return MessageSquare;
    default:
      return Infinity;
  }
}

interface ModeDropdownProps {
  mode: EditorMode;
  onModeChange?: (mode: EditorMode) => void;
  /** `below`: open under the trigger (e.g. composer at top). Default: above (docked-bottom composer). */
  popoverPlacement?: "above" | "below";
  disabled?: boolean;
  options?: AgentModeOption[];
}

export function ModeDropdown({
  mode,
  onModeChange,
  popoverPlacement = "above",
  disabled = false,
  options,
}: ModeDropdownProps) {
  const { settings } = useGlobalSettings();
  const platform = useMemo(() => detectShortcutPlatform(), []);
  const modes = useMemo((): ModeOption[] => {
    const baseOptions = ensureCurrentModeOption(
      mode,
      options?.length ? options : DEFAULT_MODE_OPTIONS
    );
    const agentShortcut = getShortcutDisplayForCommand(
      settings.keyboardShortcuts.bindings,
      "workbench.action.focusChatAgentMode",
      platform
    );
    return baseOptions.map((option) => {
      const tone = getModeTone(option.id);
      return {
        ...option,
        icon: iconForModeTone(tone),
        tone,
        shortcut:
          getModeTone(option.id) === "agent" ? agentShortcut || undefined : undefined,
      };
    });
  }, [mode, options, platform, settings.keyboardShortcuts.bindings]);
  const [open, setOpen] = useState(false);
  const [expandedWidth, setExpandedWidth] = useState(28);
  const labelMeasureRef = useRef<HTMLSpanElement>(null);
  const triggerExpanded = open;
  const close = useCallback(() => setOpen(false), []);
  const { triggerRef, popoverRef, position, ready } = usePopover(open, {
    placement: popoverPlacement,
  });

  useClickOutside(triggerRef, close, open, [popoverRef]);

  const current = modes.find((candidate) => candidate.id === mode) ?? modes[0];
  const colors = modeColors[current?.tone ?? "agent"];
  const TriggerIcon = current.icon;

  useLayoutEffect(() => {
    const node = labelMeasureRef.current;
    if (!node) {
      return;
    }
    const nextWidth = Math.max(28, Math.ceil(node.getBoundingClientRect().width));
    setExpandedWidth(nextWidth);
  }, [current.label, triggerExpanded]);

  return (
    <div ref={triggerRef} className="relative inline-flex">
      <span
        ref={labelMeasureRef}
        className="pointer-events-none absolute opacity-0"
        aria-hidden
      >
        <span
          className="inline-flex items-center rounded-[var(--radius-pill)] py-[1px] pl-[8px] pr-[7px] font-sans text-[13px] font-normal"
          style={{ background: colors.bg }}
        >
          <TriggerIcon
            className="size-[13px] shrink-0"
            style={{ color: colors.text }}
            strokeWidth={1.5}
          />
          <span className="ml-[6px] whitespace-nowrap" style={{ color: colors.text }}>
            {current.label}
          </span>
          <ChevronDown
            className="ml-[6px] size-[8px] shrink-0"
            style={{ color: colors.text }}
            strokeWidth={2.5}
          />
        </span>
      </span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        style={{
          background: colors.bg,
          width: triggerExpanded ? `${expandedWidth}px` : undefined,
          minWidth: 28,
        }}
        className={`group inline-flex items-center overflow-hidden rounded-[var(--radius-pill)] py-[1px] transition-[padding,opacity] duration-200 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 ${
          triggerExpanded ? "pl-[8px] pr-[7px]" : "pl-[7px] pr-[7px]"
        }`}
      >
        <TriggerIcon className="size-[13px] shrink-0" style={{ color: colors.text }} strokeWidth={1.5} />
        <span
          className={`overflow-hidden whitespace-nowrap font-sans text-[13px] font-normal transition-[margin,max-width,opacity] duration-200 ${
            triggerExpanded
              ? "ml-[6px] max-w-[240px] opacity-100"
              : "ml-0 max-w-0 opacity-0 group-hover:ml-[6px] group-hover:max-w-[240px] group-hover:opacity-100 group-focus-visible:ml-[6px] group-focus-visible:max-w-[240px] group-focus-visible:opacity-100"
          }`}
          style={{ color: colors.text }}
        >
          {current.label}
        </span>
        <ChevronDown
          className={`size-[8px] shrink-0 transition-[margin,opacity,width] duration-200 ${
            triggerExpanded
              ? "ml-[6px] w-[8px] opacity-100"
              : "ml-0 w-0 opacity-0 group-hover:ml-[6px] group-hover:w-[8px] group-hover:opacity-100 group-focus-visible:ml-[6px] group-focus-visible:w-[8px] group-focus-visible:opacity-100"
          }`}
          style={{ color: colors.text }}
          strokeWidth={2.5}
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-[9999] w-[200px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] py-[4px] transition-opacity"
            data-ide-input-sink
            style={{
              ...(position.top != null
                ? { top: position.top }
                : { bottom: position.bottom ?? 0 }),
              left: position.left,
              opacity: ready ? 1 : 0,
              maxHeight: position.maxHeight,
              overflow: "auto",
              overscrollBehavior: "contain",
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
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
                    style={{
                      color: active
                        ? modeColors[opt.tone].text
                        : "var(--text-secondary)",
                    }}
                  />
                  <div className="flex-1">
                    <div
                      className="font-sans text-[13px] font-normal"
                      style={{
                        color: active ? "var(--text-primary)" : "var(--text-secondary)",
                      }}
                    >
                      {opt.label}
                    </div>
                    {opt.description && (
                      <div className="mt-[1px] font-sans text-[11px] text-[var(--text-disabled)]">
                        {opt.description}
                      </div>
                    )}
                  </div>
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
