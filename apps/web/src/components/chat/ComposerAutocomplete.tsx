"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { RefObject } from "react";
import { AtSign, File, Slash, Sparkles } from "lucide-react";
import type { AtSuggestion, SlashSuggestion } from "@/lib/composer-suggestions";

const POPOVER_CLASS =
  "fixed z-[9999] flex w-[min(360px,calc(100vw-16px))] flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)]";

export type ComposerPopoverPosition =
  | { placement: "above"; bottom: number; left: number; maxHeight: number }
  | { placement: "below"; top: number; left: number; maxHeight: number };

type Props =
  | {
      kind: "at";
      items: AtSuggestion[];
      selectedIndex: number;
      position: ComposerPopoverPosition;
      onSelect: (item: AtSuggestion) => void;
      onHighlight: (index: number) => void;
      listRef: RefObject<HTMLDivElement | null>;
      popoverRef: RefObject<HTMLDivElement | null>;
    }
  | {
      kind: "slash";
      items: SlashSuggestion[];
      selectedIndex: number;
      position: ComposerPopoverPosition;
      onSelect: (item: SlashSuggestion) => void;
      onHighlight: (index: number) => void;
      listRef: RefObject<HTMLDivElement | null>;
      popoverRef: RefObject<HTMLDivElement | null>;
    };

function hotkeyLetter(index: number): string {
  return String.fromCharCode(65 + Math.min(index, 25));
}

export function ComposerAutocomplete(props: Props) {
  const { selectedIndex, position, onHighlight, listRef, popoverRef } = props;
  const title = props.kind === "at" ? "Context" : "Commands";
  const Icon = props.kind === "at" ? AtSign : Slash;

  const itemCount = props.kind === "at" ? props.items.length : props.items.length;
  useEffect(() => {
    if (itemCount === 0) return;
    const root = listRef.current;
    if (!root) return;
    const opt = root.querySelector(`[role="option"][aria-selected="true"]`);
    opt?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, itemCount, listRef]);

  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const left = Math.max(8, Math.min(position.left, vw - 368));

  const positionStyle =
    position.placement === "above"
      ? { bottom: position.bottom, top: "auto" as const, left, maxHeight: position.maxHeight }
      : { top: position.top, bottom: "auto" as const, left, maxHeight: position.maxHeight };

  return createPortal(
    <div
      id="composer-autocomplete"
      ref={popoverRef}
      className={POPOVER_CLASS}
      style={positionStyle}
      role="listbox"
      aria-label={title}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex shrink-0 items-center gap-[6px] border-b border-[var(--border-card)] px-[10px] py-[6px]">
        <Icon className="size-[13px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.5} />
        <span className="font-sans text-[13px] font-normal text-[var(--text-secondary)]">{title}</span>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-[4px]">
        {props.kind === "at" &&
          props.items.map((item, i) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={i === selectedIndex}
              onMouseEnter={() => onHighlight(i)}
              onClick={() => props.onSelect(item)}
              className={`flex w-full items-center gap-[8px] px-[12px] py-[6px] text-left transition-colors hover:bg-white/[0.06] ${i === selectedIndex ? "bg-white/[0.06]" : ""}`}
            >
              <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[var(--radius-checkbox)] border border-[var(--border-card)] font-sans text-[9px] font-medium text-[var(--text-primary)]">
                {hotkeyLetter(i)}
              </span>
              {item.category === "tool" ? (
                <Sparkles className="size-[14px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.5} />
              ) : (
                <File className="size-[14px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.5} />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-sans text-[13px] font-normal text-[var(--text-primary)]">
                  {item.label}
                </span>
                <span className="block truncate font-sans text-[11px] text-[var(--text-disabled)]">
                  {item.subtitle}
                </span>
              </span>
            </button>
          ))}

        {props.kind === "slash" &&
          props.items.map((item, i) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={i === selectedIndex}
              onMouseEnter={() => onHighlight(i)}
              onClick={() => props.onSelect(item)}
              className={`flex w-full items-center gap-[8px] px-[12px] py-[6px] text-left transition-colors hover:bg-white/[0.06] ${i === selectedIndex ? "bg-white/[0.06]" : ""}`}
            >
              <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[var(--radius-checkbox)] border border-[var(--border-card)] font-sans text-[9px] font-medium text-[var(--text-primary)]">
                {hotkeyLetter(i)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-sans text-[13px] font-normal text-[var(--text-primary)]">
                  {item.label}
                </span>
                <span className="block truncate font-sans text-[11px] text-[var(--text-disabled)]">
                  {item.subtitle}
                </span>
              </span>
            </button>
          ))}

        {itemCount === 0 && (
          <p className="px-[12px] py-[10px] font-sans text-[13px] text-[var(--text-disabled)]">No matches</p>
        )}
      </div>
    </div>,
    document.body
  );
}
