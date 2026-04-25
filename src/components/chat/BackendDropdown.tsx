"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Bot, Check, ChevronDown } from "lucide-react";
import { useClickOutside } from "@/hooks/useClickOutside";
import { usePopover } from "@/hooks/usePopover";
import type { AgentBackendId, AgentBackendInfo } from "@/lib/agent-types";
import { AgentBackendIcon } from "./AgentBackendIcon";

interface BackendDropdownProps {
  backendId: AgentBackendId;
  backends: AgentBackendInfo[];
  onBackendChange?: (backendId: AgentBackendId) => void;
  onRequestHandoff?: (backendId: AgentBackendId) => void;
  popoverPlacement?: "above" | "below";
  disabled?: boolean;
  /** Bumped when Ctrl+Shift+Tab cycles backend so the chip briefly expands like the mode control. */
  labelPeekKey?: number;
  /** Increment to open the menu from a keyboard shortcut (settings). */
  menuOpenTriggerKey?: number;
}

const BACKEND_LABEL_KEYBOARD_PEEK_MS = 560;

export function BackendDropdown({
  backendId,
  backends,
  onBackendChange,
  onRequestHandoff,
  popoverPlacement = "above",
  disabled = false,
  labelPeekKey = 0,
  menuOpenTriggerKey = 0,
}: BackendDropdownProps) {
  const [open, setOpen] = useState(false);
  const [keyboardLabelPeek, setKeyboardLabelPeek] = useState(false);
  const [expandedWidth, setExpandedWidth] = useState(28);
  const close = useCallback(() => setOpen(false), []);
  const { triggerRef, popoverRef, position, ready } = usePopover(open, {
    placement: popoverPlacement,
  });
  useClickOutside(triggerRef, close, open, [popoverRef]);
  const labelMeasureRef = useRef<HTMLSpanElement>(null);

  const options = useMemo(() => backends, [backends]);
  const current = options.find((option) => option.id === backendId) ?? null;
  const showLabelExpanded = open || keyboardLabelPeek;

  useEffect(() => {
    if (labelPeekKey <= 0) {
      return;
    }
    setKeyboardLabelPeek(true);
    const id = window.setTimeout(() => {
      setKeyboardLabelPeek(false);
    }, BACKEND_LABEL_KEYBOARD_PEEK_MS);
    return () => window.clearTimeout(id);
  }, [labelPeekKey]);

  useEffect(() => {
    if (menuOpenTriggerKey <= 0) {
      return;
    }
    setOpen(true);
  }, [menuOpenTriggerKey]);

  useLayoutEffect(() => {
    const node = labelMeasureRef.current;
    if (!node) {
      return;
    }
    const nextWidth = Math.max(28, Math.ceil(node.getBoundingClientRect().width));
    setExpandedWidth(nextWidth);
  }, [current?.label, showLabelExpanded]);

  return (
    <div ref={triggerRef} className="relative inline-flex max-w-full min-w-0">
      <span
        ref={labelMeasureRef}
        className="pointer-events-none absolute opacity-0"
        aria-hidden
      >
 <span className="inline-flex items-center rounded-[var(--radius-pill)] bg-[var(--bg-panel)] py-[1px] pl-[8px] pr-[7px] font-sans text-[13px] font-normal">
 {current
 ? (
                <AgentBackendIcon backendId={current.id} className="size-[13px] shrink-0" />
              )
            : (
                <Bot className="size-[13px] shrink-0" strokeWidth={1.5} />
              )}
          <span className="ml-[6px] whitespace-nowrap text-[var(--text-primary)]">
            {current?.label ?? backendId}
          </span>
          <ChevronDown className="ml-[6px] size-[8px] shrink-0" strokeWidth={2.5} />
        </span>
      </span>
 <button
 type="button"
 disabled={disabled || !current}
 onClick={() => setOpen((value) => !value)}
    style={{
      width: showLabelExpanded ? `${expandedWidth}px` : undefined,
      minWidth: 28,
    }}
    className={`group inline-flex items-center overflow-hidden rounded-[var(--radius-pill)] bg-[var(--bg-panel)] py-[1px] text-[var(--text-secondary)] transition-[padding,opacity,width] duration-200 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 ${
      showLabelExpanded ? "pl-[8px] pr-[7px] ease-out" : "pl-[7px] pr-[7px] ease-in"
    }`}
 >
        {current
          ? (
              <AgentBackendIcon backendId={current.id} className="size-[13px] shrink-0" />
            )
          : (
              <Bot className="size-[13px] shrink-0" strokeWidth={1.5} />
            )}
        <span
          className={`overflow-hidden whitespace-nowrap font-sans text-[13px] font-normal text-[var(--text-primary)] transition-[margin,max-width,opacity] duration-200 ${
            showLabelExpanded
              ? "ml-[6px] max-w-[240px] opacity-100 ease-out"
              : "ml-0 max-w-0 opacity-0 ease-in group-hover:ml-[6px] group-hover:max-w-[240px] group-hover:opacity-100 group-hover:ease-out group-focus-visible:ml-[6px] group-focus-visible:max-w-[240px] group-focus-visible:opacity-100 group-focus-visible:ease-out"
          }`}
        >
          {current?.label ?? backendId}
        </span>
        <ChevronDown
          className={`size-[8px] shrink-0 transition-[margin,opacity,width] duration-200 ${
            showLabelExpanded
              ? "ml-[6px] w-[8px] opacity-100 ease-out"
              : "ml-0 w-0 opacity-0 ease-in group-hover:ml-[6px] group-hover:w-[8px] group-hover:opacity-100 group-hover:ease-out group-focus-visible:ml-[6px] group-focus-visible:w-[8px] group-focus-visible:opacity-100 group-focus-visible:ease-out"
          }`}
          strokeWidth={2.5}
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-[9999] w-[240px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] py-[4px] transition-opacity"
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
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
            {options.map((option) => {
              const active = option.id === backendId;
              const unavailable = !option.available;
              const detail =
                option.experimental && !option.available
                  ? "Experimental adapter placeholder"
                  : option.description;
              const isDifferentBackend = option.id !== backendId;
              return (
                <div key={option.id} className="flex flex-col">
                  <button
                    type="button"
                    disabled={unavailable}
                    title={detail}
                    onClick={() => {
                      if (unavailable) return;
                      if (isDifferentBackend && onRequestHandoff) {
                        onRequestHandoff(option.id);
                      } else {
                        onBackendChange?.(option.id);
                      }
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-[8px] px-[12px] py-[5px] text-left transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <AgentBackendIcon
                      backendId={option.id}
                      className="size-[15px] shrink-0"
                      strokeWidth={1.5}
                      emphasized={active}
                    />
                    <span
                      className="min-w-0 flex-1 truncate font-sans text-[13px] font-normal"
                      style={{
                        color: active ? "var(--text-primary)" : "var(--text-secondary)",
                      }}
                    >
                      {option.label}
                    </span>
                    {active && (
                      <Check className="size-[14px] shrink-0 text-[var(--text-primary)]" strokeWidth={2} />
                    )}
                  </button>
                </div>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}
