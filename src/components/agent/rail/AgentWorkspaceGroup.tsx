"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export function AgentWorkspaceGroup({
  actions,
  children,
  collapsed,
  name,
  onToggleCollapsed,
}: {
  actions?: ReactNode;
  children: ReactNode;
  collapsed: boolean;
  name: string;
  onToggleCollapsed: () => void;
}) {
  return (
    <section className="pb-[12px]">
      <div className="group flex items-center gap-[6px]">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex min-w-0 flex-1 items-center gap-[4px] rounded-[var(--radius-tab)] py-[1px] pl-px pr-[6px] text-left transition-colors hover:bg-[var(--accent-bg)]"
          aria-expanded={!collapsed}
        >
          <ChevronRight
            className={`size-[10px] shrink-0 text-[var(--text-secondary)] transition-transform duration-200 ease-out motion-reduce:transition-none ${
              collapsed ? "" : "rotate-90"
            }`}
            strokeWidth={2}
            aria-hidden
          />
          <span className="min-w-0 truncate font-sans text-[11px] font-normal text-[var(--text-disabled)]">
            {name}
          </span>
        </button>
        {actions ? (
          <div className="ml-auto flex items-center gap-[4px]">
            {actions}
          </div>
        ) : null}
      </div>
      {!collapsed ? <div className="pt-[4px]">{children}</div> : null}
    </section>
  );
}
