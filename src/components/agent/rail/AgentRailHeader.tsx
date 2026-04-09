"use client";

import type { ReactNode } from "react";
import { PanelLeftClose } from "lucide-react";

export function AgentRailHeader({
  actions,
  onCollapse,
}: {
  actions?: ReactNode;
  onCollapse: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-[10px] px-[11px] pt-[11px]">
      <button
        type="button"
        onClick={onCollapse}
        className="flex size-[18px] items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
        aria-label="Collapse workspace rail"
        title="Collapse workspace rail"
      >
        <PanelLeftClose className="size-[16px]" strokeWidth={1.5} />
      </button>
      {actions ? (
        <div className="ml-auto flex items-center gap-[10px]">{actions}</div>
      ) : null}
    </div>
  );
}
