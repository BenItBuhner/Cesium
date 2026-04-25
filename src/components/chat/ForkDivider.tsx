"use client";

import { GitFork } from "lucide-react";
import { getAgentLabel, HandoffAgentMark } from "./HandoffDivider";

interface ForkDividerProps {
  fromAgent: string;
}

const FORK_ICON_CLASS = "size-[13px] shrink-0";

export function ForkDivider({ fromAgent }: ForkDividerProps) {
  return (
    <div className="flex items-center gap-[12px] px-[16px] py-[8px]">
      <div className="flex-1 h-px bg-[var(--border-subtle)]" />
      <span className="inline-flex items-center gap-[6px] whitespace-nowrap text-[13px] text-[var(--text-secondary)]">
        <GitFork className={FORK_ICON_CLASS} strokeWidth={1.75} aria-hidden />
        <span>Conversation forked from</span>
        <HandoffAgentMark backendIdRaw={fromAgent} label={getAgentLabel(fromAgent)} />
      </span>
      <div className="flex-1 h-px bg-[var(--border-subtle)]" />
    </div>
  );
}
