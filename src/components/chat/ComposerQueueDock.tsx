"use client";

import { ChevronDown, CornerUpLeft, Pencil, Settings2, Trash2 } from "lucide-react";
import type { AgentConversationConfig } from "@/lib/agent-types";
import type { QueuedChatPrompt, QueuedPromptConfigOverride } from "@/lib/types";
import {
  formatConfigOverrideTooltip,
  getConfigDiffFromPrevious,
} from "@/lib/queued-prompt-utils";
import { CollapsibleHeight } from "./CollapsibleHeight";

type ComposerQueueDockProps = {
  items: QueuedChatPrompt[];
  onDelete: (item: QueuedChatPrompt) => void;
  onUnqueue: (item: QueuedChatPrompt) => void;
  onEdit?: (item: QueuedChatPrompt) => void;
  conversationConfig?: AgentConversationConfig;
  backendLabels?: Record<string, string>;
  /** List expanded when false; when true, the header is visible but the list is collapsed. */
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
};

function oneLinePreview(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function ComposerQueueDock({
  items,
  onDelete,
  onUnqueue,
  onEdit,
  conversationConfig,
  backendLabels,
  collapsed,
  onCollapsedChange,
}: ComposerQueueDockProps) {
  const open = !collapsed;

  if (items.length === 0) {
    return null;
  }

  const frame =
    "mx-[12px] flex flex-col gap-[8px] overflow-hidden rounded-t-[var(--radius-card)] rounded-b-none border-x border-t border-[var(--border-card)] bg-[var(--bg-card)] p-[10px]";

  return (
    <div className={frame}>
      <button
        type="button"
        onClick={() => onCollapsedChange(!collapsed)}
        className="flex items-center gap-[6px] text-left transition-colors hover:text-[var(--text-primary)]"
      >
        <ChevronDown
          className={`size-[14px] shrink-0 text-[var(--text-secondary)] transition-transform duration-300 ease-[cubic-bezier(0.33,1,0.68,1)] motion-reduce:transition-none ${
            open ? "rotate-180" : ""
          }`}
          strokeWidth={1.75}
          aria-hidden
        />
        <span className="font-sans text-[10.5px] font-medium text-[var(--text-secondary)]">
          {items.length} queued message{items.length !== 1 ? "s" : ""}
        </span>
      </button>
      <CollapsibleHeight open={open}>
        <ul className="flex flex-col gap-[6px]" aria-label="Queued follow-up messages">
          {items.map((item, index) => {
            const line = oneLinePreview(item.text);
            const previousItem = index > 0 ? items[index - 1] : null;
            const configDiff: QueuedPromptConfigOverride | undefined =
              conversationConfig
                ? getConfigDiffFromPrevious(item, previousItem, conversationConfig)
                : undefined;
            const showIndicator = configDiff && Object.keys(configDiff).length > 0;
            const tooltip =
              showIndicator
                ? formatConfigOverrideTooltip(configDiff, backendLabels)
                : undefined;
            return (
              <li
                key={item.id}
                className="flex min-w-0 items-center gap-[8px] border-b border-[var(--border-card)] pb-[6px] last:border-b-0 last:pb-0"
              >
                {showIndicator && (
                  <span title={tooltip} className="inline-flex shrink-0">
                    <Settings2
                      className="size-[12px] text-[var(--text-secondary)]"
                      strokeWidth={2}
                      aria-hidden
                    />
                  </span>
                )}
                {item.delivery === "steer" ? (
                  <span className="shrink-0 rounded-full border border-[var(--border-subtle)] px-[6px] py-[2px] font-sans text-[10px] uppercase tracking-[0.04em] text-[var(--text-secondary)]">
                    Steer
                  </span>
                ) : null}
                <span
                  className="min-w-0 flex-1 truncate font-sans text-[12px] font-normal text-[var(--text-primary)]"
                  title={item.text}
                >
                  {line || "(empty)"}
                </span>
                <div className="flex shrink-0 items-center gap-[2px]">
                  {onEdit && (
                    <button
                      type="button"
                      onClick={() => onEdit(item)}
                      className="flex items-center gap-[4px] rounded-[6px] px-[8px] py-[4px] font-sans text-[10.5px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)]"
                      title="Edit"
                    >
                      <Pencil className="size-[12px]" strokeWidth={2} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onUnqueue(item)}
                    className="flex items-center gap-[4px] rounded-[6px] px-[8px] py-[4px] font-sans text-[10.5px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)]"
                    title="Unqueue"
                  >
                    <CornerUpLeft className="size-[12px]" strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(item)}
                    className="flex items-center gap-[4px] rounded-[6px] px-[8px] py-[4px] font-sans text-[10.5px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--status-error)]"
                    title="Delete"
                  >
                    <Trash2 className="size-[12px]" strokeWidth={2} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </CollapsibleHeight>
    </div>
  );
}
