"use client";

import {
  Bug,
  Check,
  Flame,
  GitBranch,
  Infinity,
  Layers,
  ListChecks,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";
import { useEffect } from "react";
import type { RefObject } from "react";
import { VerticalFadedScroll } from "@/components/chat/VerticalFadedScroll";
import { AgentBackendIcon } from "@/components/chat/AgentBackendIcon";
import { ModelBrandIcon } from "@/components/chat/ModelBrandIcon";
import { ComposerCommandPanel } from "@/components/chat/ComposerCommandPanel";
import { getModeTone } from "@/lib/chat-modes";
import type { ComposerCommandPanelPosition } from "@/lib/composer-command-panel";
import type { AgentBackendId } from "@/lib/agent-types";
import type { SlashMenuItem, SlashMenuSection } from "@/lib/composer-suggestions";
import type { EditorMode, KnownEditorMode, ModelInfo } from "@/lib/types";

type Props = {
  sections: SlashMenuSection[];
  flatItems: SlashMenuItem[];
  totalItems: number;
  truncated: boolean;
  selectedIndex: number;
  query: string;
  mode: EditorMode;
  model: ModelInfo;
  backendId: AgentBackendId;
  position: ComposerCommandPanelPosition;
  onSelect: (item: SlashMenuItem) => void;
  onHighlight: (index: number) => void;
  listRef: RefObject<HTMLDivElement | null>;
  popoverRef: RefObject<HTMLDivElement | null>;
};

function modelValueKey(model: ModelInfo): string {
  return model.modelValue ?? model.id;
}

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

function rowClass(selected: boolean, disabled?: boolean): string {
  return `flex w-full cursor-pointer items-start gap-[10px] rounded-[var(--radius-tab)] px-[10px] py-[8px] text-left outline-none transition-colors hover:bg-[var(--accent-bg)] focus-visible:bg-[var(--accent-bg)] ${
    selected ? "bg-[var(--accent-bg)]" : ""
  } ${disabled ? "cursor-not-allowed opacity-45" : ""}`;
}

export function ComposerSlashMenu({
  sections,
  flatItems,
  totalItems,
  truncated,
  selectedIndex,
  query,
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

  return (
    <ComposerCommandPanel
      id="composer-autocomplete"
      ariaLabel="Commands"
      position={position}
      popoverRef={popoverRef}
      search={{
        value: query,
        placeholder: "Search skills, context, chats...",
      }}
    >
      <VerticalFadedScroll
        wrapperClassName="flex min-h-0 flex-1 flex-col"
        scrollRef={listRef}
        measureKey={`${sections.length}:${flatItems.length}:${selectedIndex}`}
        scrollClassName="hide-scrollbar-y min-h-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]"
      >
        <div className="flex flex-col p-[6px]">
          {flatItems.length === 0 ? (
            <p className="px-[10px] py-[8px] font-sans text-[12.5px] text-[var(--text-disabled)]">
              No matches
            </p>
          ) : (
            sectionRows.map((section, sectionIndex) => {
              if (section.rows.length === 0) {
                return null;
              }
              return (
                <div key={section.id} className="flex flex-col">
                  {sectionIndex > 0 ? (
                    <div
                      className="my-[4px] h-px shrink-0 bg-[var(--agent-border)]"
                      aria-hidden
                    />
                  ) : null}
                  {showSectionLabels && section.label ? (
                    <p className="px-[10px] pb-[2px] pt-[4px] font-sans text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--text-disabled)]">
                      {section.label}
                    </p>
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
                    const ModeIcon =
                      item.action.kind === "mode"
                        ? iconForModeTone(getModeTone(item.action.modeId))
                        : null;

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
                        <span className="mt-[1px] flex size-[16px] shrink-0 items-center justify-center text-[var(--text-secondary)]">
                          {item.action.kind === "model" ? (
                            <ModelBrandIcon
                              model={item.action.model}
                              className="size-[15px] shrink-0"
                              strokeWidth={1.5}
                            />
                          ) : item.action.kind === "backend" ? (
                            <AgentBackendIcon
                              backendId={item.action.backendId}
                              className="size-[15px] shrink-0"
                              strokeWidth={1.5}
                              emphasized={active}
                            />
                          ) : ModeIcon ? (
                            <ModeIcon className="size-[15px] shrink-0" strokeWidth={1.6} aria-hidden />
                          ) : null}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-sans text-[13px] text-[var(--text-primary)]">
                            {item.label}
                          </span>
                          {item.description ? (
                            <span className="mt-[1px] block truncate font-sans text-[11px] leading-[15px] text-[var(--text-secondary)]">
                              {item.description}
                            </span>
                          ) : null}
                        </span>
                        {active ? (
                          <Check
                            className="mt-[2px] size-[13px] shrink-0 text-[var(--text-primary)]"
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
          {truncated ? (
            <p className="px-[10px] py-[8px] font-sans text-[12px] text-[var(--text-disabled)]">
              Showing {flatItems.length} of {totalItems} matches. Keep typing to narrow the list.
            </p>
          ) : null}
        </div>
      </VerticalFadedScroll>
    </ComposerCommandPanel>
  );
}
