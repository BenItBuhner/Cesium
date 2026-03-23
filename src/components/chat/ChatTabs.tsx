"use client";

import { useRef } from "react";
import { Plus } from "lucide-react";
import { useTabStripWheel } from "@/hooks/useTabStripWheel";
import type { ChatTab } from "@/lib/types";

interface ChatTabsProps {
  tabs: ChatTab[];
  onSelectTab: (id: string) => void;
}

export function ChatTabs({ tabs, onSelectTab }: ChatTabsProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  useTabStripWheel(stripRef, { speed: 2.1 });

  return (
    <div className="flex h-[var(--tab-height)] min-w-0 items-center overflow-hidden">
      <div
        ref={stripRef}
        className="hide-scrollbar-x flex min-w-0 flex-1 items-center gap-0 p-[2px]"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelectTab(tab.id)}
            className="flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-tab)] px-[9px] py-[9px] transition-colors"
            style={{
              background: tab.active ? "var(--bg-tab-active)" : "transparent",
            }}
          >
            <span className="whitespace-nowrap font-sans text-[14px] font-normal text-[var(--text-secondary)]">
              {tab.title}
            </span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="mr-[9px] shrink-0 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        aria-label="New chat"
      >
        <Plus className="size-[18px]" strokeWidth={1.5} />
      </button>
    </div>
  );
}
