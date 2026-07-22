"use client";

import {
  useState,
  useCallback,
  useMemo,
  useRef,
  useLayoutEffect,
  useEffect,
} from "react";
import { createPortal } from "react-dom";
import {
  Infinity,
  Flame,
  Layers,
  ListChecks,
  Bug,
  MessageSquare,
  ChevronDown,
  Check,
  GitBranch,
  type LucideIcon,
} from "lucide-react";
import { useClickOutside } from "@/hooks/useClickOutside";
import { usePopover } from "@/hooks/usePopover";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import {
  detectShortcutPlatform,
  getShortcutDisplayForCommand,
} from "@/lib/keyboard-shortcuts";
import { DEFAULT_MODE_OPTIONS, ensureCurrentModeOption, getModeTone, isOrchestrationMode } from "@/lib/chat-modes";
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
  goal: { text: "var(--goal-accent)", bg: "var(--goal-accent-bg)" },
  workflow: { text: "var(--workflow-accent)", bg: "var(--workflow-accent-bg)" },
  orchestration: { text: "var(--orchestration-accent)", bg: "var(--orchestration-accent-bg)" },
};

function iconForModeTone(tone: KnownEditorMode): LucideIcon {
  switch (tone) {
    case "plan":
      return ListChecks;
    case "debug":
      return Bug;
    case "ask":
      return MessageSquare;
    case "goal":
      return Flame;
    case "workflow":
      return GitBranch;
    case "orchestration":
      return Layers;
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
  /**
   * Increment when the mode is cycled via keyboard (e.g. Shift+Tab) so the chip briefly
   * expands to show the label like hover, then collapses.
   */
  labelPeekKey?: number;
  /** Increment to open the menu from a keyboard shortcut (settings). */
  menuOpenTriggerKey?: number;
  /** When true, mode selection generally cannot be changed. */
  modeLocked?: boolean;
}

const MODE_LABEL_KEYBOARD_PEEK_MS = 560;

export function ModeDropdown({
  mode,
  onModeChange,
  popoverPlacement = "above",
  disabled = false,
  options,
  labelPeekKey = 0,
  menuOpenTriggerKey = 0,
  modeLocked = false,
}: ModeDropdownProps) {
  const { settings } = useGlobalSettings();
  const platform = useMemo(() => detectShortcutPlatform(), []);
  const modes = useMemo((): ModeOption[] => {
    const baseOptions = ensureCurrentModeOption(
      mode,
      options?.length ? options : DEFAULT_MODE_OPTIONS
    );
    const planShortcut = getShortcutDisplayForCommand(
      settings.keyboardShortcuts.bindings,
      "workbench.action.focusChatPlanMode",
      platform
    );
    const agentShortcut = getShortcutDisplayForCommand(
      settings.keyboardShortcuts.bindings,
      "workbench.action.focusChatAgentMode",
      platform
    );
    const shortcutsByTone: Partial<Record<KnownEditorMode, string | undefined>> = {
      agent: agentShortcut || undefined,
      plan: planShortcut || undefined,
    };
    return baseOptions.map((option) => {
      const tone = getModeTone(option.id);
      return {
        ...option,
        icon: iconForModeTone(tone),
        tone,
        shortcut: shortcutsByTone[tone],
      };
    });
  }, [mode, options, platform, settings.keyboardShortcuts.bindings]);
  const [open, setOpen] = useState(false);
  const [keyboardLabelPeek, setKeyboardLabelPeek] = useState(false);
  const [expandedWidth, setExpandedWidth] = useState(28);
  const labelMeasureRef = useRef<HTMLSpanElement>(null);
  const showLabelExpanded = open || keyboardLabelPeek;
  const close = useCallback(() => setOpen(false), []);
  const { triggerRef, popoverRef, position, ready } = usePopover(open, {
    placement: popoverPlacement,
  });

  useClickOutside(triggerRef, close, open, [popoverRef]);

  useEffect(() => {
    if (labelPeekKey <= 0) {
      return;
    }
    setKeyboardLabelPeek(true);
    const id = window.setTimeout(() => {
      setKeyboardLabelPeek(false);
    }, MODE_LABEL_KEYBOARD_PEEK_MS);
    return () => window.clearTimeout(id);
  }, [labelPeekKey]);

  useEffect(() => {
    if (menuOpenTriggerKey <= 0 || disabled || modeLocked) {
      return;
    }
    setOpen(true);
  }, [disabled, menuOpenTriggerKey, modeLocked]);

  const current = modes.find((candidate) => candidate.id === mode) ?? modes[0];
  const colors = modeColors[current?.tone ?? "agent"];
  const TriggerIcon = current.icon;
  const modeMenuInteractive = !disabled && !modeLocked;
  const showModeLabel = showLabelExpanded || isOrchestrationMode(mode);

  useLayoutEffect(() => {
    const node = labelMeasureRef.current;
    if (!node) {
      return;
    }
    const nextWidth = Math.max(28, Math.ceil(node.getBoundingClientRect().width));
    setExpandedWidth(nextWidth);
  }, [current.label, showLabelExpanded]);

  return (
    <div ref={triggerRef} className="relative inline-flex max-w-full min-w-0">
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
 disabled={!modeMenuInteractive}
 onClick={() => {
   if (!modeMenuInteractive) {
     return;
   }
   setOpen((v) => !v);
 }}
    style={{
      background: colors.bg,
      width: showModeLabel ? `${expandedWidth}px` : undefined,
      minWidth: 28,
    }}
    aria-label={`Mode: ${current.label}`}
    title={`Mode: ${current.label}`}
    className={`group inline-flex items-center overflow-hidden rounded-[var(--radius-pill)] py-[1px] transition-[padding,opacity,width] duration-200 hover:opacity-90 disabled:cursor-default disabled:opacity-100 ${
      showModeLabel ? "pl-[8px] pr-[7px] ease-out" : "pl-[7px] pr-[7px] ease-in"
    }`}
 >
        <TriggerIcon className="size-[13px] shrink-0" style={{ color: colors.text }} strokeWidth={1.5} />
        <span
          className={`overflow-hidden whitespace-nowrap font-sans text-[13px] font-normal transition-[margin,max-width,opacity] duration-200 ${
            showModeLabel
              ? "ml-[6px] max-w-[240px] opacity-100 ease-out"
              : "ml-0 max-w-0 opacity-0 ease-in group-hover:ml-[6px] group-hover:max-w-[240px] group-hover:opacity-100 group-hover:ease-out group-focus-visible:ml-[6px] group-focus-visible:max-w-[240px] group-focus-visible:opacity-100 group-focus-visible:ease-out"
          }`}
          style={{ color: colors.text }}
        >
          {current.label}
        </span>
        <ChevronDown
          className={`size-[8px] shrink-0 transition-[margin,opacity,width] duration-200 ${
            showModeLabel
              ? "ml-[6px] w-[8px] opacity-100 ease-out"
              : "ml-0 w-0 opacity-0 ease-in group-hover:ml-[6px] group-hover:w-[8px] group-hover:opacity-100 group-hover:ease-out group-focus-visible:ml-[6px] group-focus-visible:w-[8px] group-focus-visible:opacity-100 group-focus-visible:ease-out"
          }`}
          style={{ color: colors.text }}
          strokeWidth={2.5}
        />
      </button>

      {open && modeMenuInteractive &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-[9999] w-[200px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] py-[4px] transition-opacity"
            data-ide-input-sink
            data-ide-composer-floating-popover
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
                  title={opt.description ?? opt.label}
                  onClick={() => {
                    onModeChange?.(opt.id);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-[8px] px-[12px] py-[5px] text-left transition-colors hover:bg-white/[0.06]"
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
                  <span
                    className="min-w-0 flex-1 truncate font-sans text-[13px] font-normal"
                    style={{
                      color: active ? "var(--text-primary)" : "var(--text-secondary)",
                    }}
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
