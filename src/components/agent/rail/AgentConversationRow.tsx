"use client";

import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { LoaderCircle } from "lucide-react";
import type {
  AgentConversationStatus,
  AgentRailConversationSummary,
} from "@/lib/agent-types";

function ConversationStatusIcon({
  hasPendingPermission,
  selected,
  status,
}: {
  hasPendingPermission: boolean;
  selected: boolean;
  status: AgentConversationStatus;
}) {
  if (status === "running") {
    return (
      <LoaderCircle
        className="size-[14px] shrink-0 animate-spin text-[var(--text-secondary)]"
        strokeWidth={1.5}
      />
    );
  }
  const dotColor = hasPendingPermission
    ? "bg-[var(--plan-accent)]"
    : selected
      ? "bg-[var(--text-primary)]"
      : "bg-[var(--text-disabled)]";
  return <span className={`size-[6px] shrink-0 rounded-full ${dotColor}`} />;
}

export function AgentConversationRow({
  conversation,
  editValue,
  editing = false,
  onBeginRename,
  onCancelRename,
  onCommitRename,
  onContextMenu,
  onEditValueChange,
  onSelect,
  selected,
}: {
  conversation: AgentRailConversationSummary;
  editValue?: string;
  editing?: boolean;
  onBeginRename?: () => void;
  onCancelRename?: () => void;
  onCommitRename?: () => void;
  onContextMenu?: (
    event: MouseEvent<HTMLButtonElement>,
    conversation: AgentRailConversationSummary
  ) => void;
  onEditValueChange?: (value: string) => void;
  onSelect: () => void;
  selected: boolean;
}) {
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [editing]);

  const rowClassName = `flex h-[30px] w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[9px] text-left transition-colors ${
    selected ? "bg-[var(--bg-card)]" : "hover:bg-[var(--bg-card)]"
  }`;

  const titleClassName = `truncate font-sans text-[14px] font-normal ${
    selected ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"
  }`;

  const statusIcon = (
    <ConversationStatusIcon
      status={conversation.status}
      selected={selected}
      hasPendingPermission={conversation.hasPendingPermission}
    />
  );

  const handleContextMenu = onContextMenu
    ? (event: MouseEvent<HTMLButtonElement>) => {
        onContextMenu(event, conversation);
      }
    : undefined;

  if (editing) {
    return (
      <div className={rowClassName} title={conversation.title}>
        {statusIcon}
        <input
          ref={renameInputRef}
          value={editValue ?? conversation.title}
          aria-label="Conversation name"
          className={`min-w-0 flex-1 bg-transparent outline-none ${titleClassName}`}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => onEditValueChange?.(event.target.value)}
          onBlur={() => onCommitRename?.()}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onCommitRename?.();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onCancelRename?.();
            }
          }}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      onContextMenu={handleContextMenu}
      className={rowClassName}
      title={conversation.title}
    >
      {statusIcon}
      <span
        className={titleClassName}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onBeginRename?.();
        }}
      >
        {conversation.title}
      </span>
    </button>
  );
}
