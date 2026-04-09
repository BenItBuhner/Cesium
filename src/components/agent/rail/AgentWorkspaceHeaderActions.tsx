"use client";

import type { MouseEvent } from "react";
import { MoreVertical, Plus } from "lucide-react";

const actionButtonClassName =
  "flex size-[18px] items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]";

export function AgentWorkspaceHeaderActions({
  workspaceName,
  onNewChat,
  onOpenMenu,
}: {
  workspaceName: string;
  onNewChat: () => void;
  onOpenMenu: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onNewChat}
        className={actionButtonClassName}
        aria-label={`Start new chat in ${workspaceName}`}
        title={`Start new chat in ${workspaceName}`}
      >
        <Plus className="size-[16px]" strokeWidth={1.5} />
      </button>
      <button
        type="button"
        onClick={onOpenMenu}
        className={actionButtonClassName}
        aria-label={`More actions for ${workspaceName}`}
        title={`More actions for ${workspaceName}`}
      >
        <MoreVertical className="size-[16px]" strokeWidth={1.5} />
      </button>
    </>
  );
}
