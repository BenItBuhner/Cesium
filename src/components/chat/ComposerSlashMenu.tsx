"use client";

import { Check } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { RefObject } from "react";
import { VerticalFadedScroll } from "@/components/chat/VerticalFadedScroll";
import { AgentBackendIcon } from "@/components/chat/AgentBackendIcon";
import { ModelBrandIcon } from "@/components/chat/ModelBrandIcon";
import type { ComposerPopoverPosition } from "@/components/chat/ComposerAutocomplete";
import {
  popoverMenuFixedPanelClass,
  popoverMenuItemClass,
  popoverMenuListClass,
  popoverMenuSectionLabelClass,
} from "@/components/ui/popover-menu-ui";
import type { AgentBackendId } from "@/lib/agent-types";
import type { SlashMenuItem, SlashMenuSection } from "@/lib/composer-suggestions";
import type { EditorMode, ModelInfo } from "@/lib/types";

type Props = {
  sections: SlashMenuSection[];
  flatItems: SlashMenuItem[];
  selectedIndex: number;
  mode: EditorMode;
  model: ModelInfo;
  backendId: AgentBackendId;
  position: ComposerPopoverPosition;
  onSelect: (item: SlashMenuItem) => void;
  onHighlight: (index: number) => void;
  listRef: RefObject<HTMLDivElement | null>;
  popoverRef: RefObject<HTMLDivElement | null>;
};

function modelValueKey(model: ModelInfo): string {
  return model.modelValue ?? model.id;
}

function rowClass(selected: boolean, disabled?: boolean): string {
  return `${popoverMenuItemClass} cursor-pointer ${
    selected ? "bg-[var(--accent-bg)]" : ""
  } ${disabled ? "cursor-not-allowed opacity-45" : ""}`;
}

export function ComposerSlashMenu({
  sections,
  flatItems,
  selectedIndex,
  mode,
  model,
  backendId,
  position,
  onSelect,
  onHighlight,
  listRef,
  popoverRef,
}: Props) {
  useEffect(() => {
    if (flatItems.length === 0) return;
    const root = listRef.current;
    if (!root) return;
    const opt = root.querySelector(`[role="option"][aria-selected="true"]`);
    opt?.scrollIntoView({ block: "nearest" });
  }, [flatItems.length, listRef, selectedIndex]);

  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const left = Math.max(8, Math.min(position.left, vw - 288));

  const positionStyle =
    position.placement === "above"
      ? { bottom: position.bottom, top: "auto" as const, left, maxHeight: position.maxHeight }
      : { top: position.top, bottom: "auto" as const, left, maxHeight: position.maxHeight };

  const showSectionLabels = sections.length > 1;
  let runningIndex = 0;
  const sectionRows = sections.map((section) => {
    const rows = section.items.map((item) => {
      const rowIndex = runningIndex;
      runningIndex += 1;
      return { item, rowIndex };
    });
    return { ...section, rows };
  });

  return createPortal(
    <div
      id="composer-autocomplete"
      ref={popoverRef}
      className={`${popoverMenuFixedPanelClass} flex w-[min(280px,calc(100vw-16px))] flex-col`}
      style={positionStyle}
      role="listbox"
      aria-label="Commands"
      data-ide-composer-floating-popover
      data-ide-input-sink
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <VerticalFadedScroll
        wrapperClassName="flex min-h-0 flex-1 flex-col"
        scrollRef={listRef}
        measureKey={`${sections.length}:${flatItems.length}:${selectedIndex}`}
        edgeColorVar="var(--bg-panel)"
        scrollClassName="hide-scrollbar-y min-h-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]"
      >
        <div className={popoverMenuListClass}>
          {flatItems.length === 0 ? (
            <p className="px-[8px] py-[6px] font-sans text-[12.5px] text-[var(--text-disabled)]">
              No matches
            </p>
          ) : (
            sectionRows.map((section) => {
              if (section.rows.length === 0) {
                return null;
              }
              return (
                <div key={section.id} className="flex flex-col">
                  {showSectionLabels && section.label ? (
                    <p className={popoverMenuSectionLabelClass}>{section.label}</p>
                  ) : null}
                  {section.rows.map(({ item, rowIndex }) => {
                    const selected = rowIndex === selectedIndex;
                    const active =
                      item.action.kind === "mode"
                        ? item.action.modeId === mode
                        : item.action.kind === "model"
                          ? modelValueKey(item.action.model) === modelValueKey(model)
                          : item.action.kind === "backend"
                            ? item.action.backendId === backendId
                            : false;

                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        disabled={item.disabled}
                        onMouseEnter={() => onHighlight(rowIndex)}
                        onClick={() => onSelect(item)}
                        className={rowClass(selected, item.disabled)}
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-[8px]">
                          {item.action.kind === "model" ? (
                            <ModelBrandIcon
                              model={item.action.model}
                              className="size-[14px] shrink-0"
                              strokeWidth={1.5}
                            />
                          ) : item.action.kind === "backend" ? (
                            <AgentBackendIcon
                              backendId={item.action.backendId}
                              className="size-[14px] shrink-0"
                              strokeWidth={1.5}
                              emphasized={active}
                            />
                          ) : null}
                          <span className="min-w-0 truncate">{item.label}</span>
                        </span>
                        {active ? (
                          <Check
                            className="size-[13px] shrink-0 text-[var(--text-primary)]"
                            strokeWidth={2}
                            aria-hidden
                          />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      </VerticalFadedScroll>
    </div>,
    document.body
  );
}
