"use client";

import { useState } from "react";
import { ChevronDown, CornerUpLeft, Trash2 } from "lucide-react";
import type { QueuedChatPrompt } from "@/lib/types";
import { CollapsibleHeight } from "./CollapsibleHeight";

type ComposerQueueDockProps = {
  items: QueuedChatPrompt[];
  onDelete: (item: QueuedChatPrompt) => void;
  onUnqueue: (item: QueuedChatPrompt) => void;
};

function oneLinePreview(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function ComposerQueueDock({
  items,
  onDelete,
  onUnqueue,
}: ComposerQueueDockProps) {
  const [open, setOpen] = useState(true);

  if (items.length === 0) {
    return null;
  }

  const frame =
    "mx-[12px] flex flex-col gap-[8px] overflow-hidden rounded-t-[var(--radius-card)] rounded-b-none border-x border-t border-[var(--border-card)] bg-[var(--bg-card)] p-[10px]";

  return (
    <div className={frame}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
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
          {items.map((item) => {
            const line = oneLinePreview(item.text);
            return (
              <li
                key={item.id}
                className="flex min-w-0 items-center gap-[8px] border-b border-[var(--border-card)] pb-[6px] last:border-b-0 last:pb-0"
              >
                <span
                  className="min-w-0 flex-1 truncate font-sans text-[12px] font-normal text-[var(--text-primary)]"
                  title={item.text}
                >
                  {line || "(empty)"}
                </span>
                <div className="flex shrink-0 items-center gap-[2px]">
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