"use client";

import { ListOrdered } from "lucide-react";
import type { QueuedChatPrompt } from "@/lib/types";

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
  if (items.length === 0) {
    return null;
  }

  const frame =
    "mx-[12px] flex flex-col gap-[8px] overflow-hidden rounded-t-[var(--radius-card)] rounded-b-none border-x border-t border-[var(--border-card)] bg-[var(--bg-card)] p-[10px]";

  const btn =
    "shrink-0 rounded-[6px] px-[8px] py-[4px] font-sans text-[10.5px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-40";

  return (
    <div className={frame}>
      <div className="flex items-center gap-[6px] text-[var(--text-secondary)]">
        <ListOrdered className="size-[14px] shrink-0" strokeWidth={1.5} aria-hidden />
        <span className="font-sans text-[10.5px] font-medium uppercase tracking-wide">
          Queued messages
        </span>
      </div>
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
                <button type="button" className={btn} onClick={() => onUnqueue(item)}>
                  Unqueue
                </button>
                <button type="button" className={btn} onClick={() => onDelete(item)}>
                  Delete
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
