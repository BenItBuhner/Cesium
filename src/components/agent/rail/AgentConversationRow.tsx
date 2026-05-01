"use client";

import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { LoaderCircle, MoreVertical } from "lucide-react";
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
  onOverflowMenu,
  onEditValueChange,
  onSelect,
  rowIndex,
  selected,
  showOverflowMenu = false,
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
  /** iPad / no native context menu: opens the same menu as `onContextMenu`. */
  onOverflowMenu?: (anchorEl: HTMLElement) => void;
  onEditValueChange?: (value: string) => void;
  onSelect: () => void;
  rowIndex?: number;
  selected: boolean;
  showOverflowMenu?: boolean;
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

  const rowClassName = `flex h-[var(--agent-rail-row-height)] w-full items-center gap-[8px] rounded-[var(--agent-control-radius)] px-[9px] text-left transition-colors select-none ${
    selected ? "bg-[var(--agent-card-bg)]" : "hover:bg-[var(--agent-card-bg)]"
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
      <div
        className={rowClassName}
        title={conversation.title}
        data-perf="agent-rail-row"
        data-conversation-id={conversation.id}
        data-rail-row-index={rowIndex}
      >
        {statusIcon}
        <input
          ref={renameInputRef}
          value={editValue ?? conversation.title}
          aria-label="Conversation name"
          data-perf="agent-rail-rename-input"
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
    <div
      className="group flex w-full min-w-0 items-center gap-[4px]"
      data-perf="agent-rail-row"
      data-conversation-id={conversation.id}
      data-rail-row-index={rowIndex}
    >
      <button
        type="button"
        onClick={onSelect}
        onContextMenu={handleContextMenu}
        data-perf="agent-rail-row-button"
        className={`${rowClassName} min-w-0 flex-1`}
        title={conversation.title}
      >
        {statusIcon}
        <span
          className={titleClassName}
          data-perf="agent-rail-row-title"
          onDoubleClick={(event) => {
            event.stopPropagation();
            onBeginRename?.();
          }}
        >
          {conversation.title}
        </span>
      </button>
      {showOverflowMenu && onOverflowMenu ? (
        <button
          type="button"
          className="mr-[4px] flex size-[24px] shrink-0 items-center justify-center rounded-[var(--agent-control-radius)] text-[var(--text-secondary)] opacity-0 pointer-events-none transition-[opacity,background-color,color] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)] hover:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:bg-[var(--accent-bg)] focus-visible:text-[var(--text-primary)] focus-visible:opacity-100"
          aria-label={`More actions for ${conversation.title}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onOverflowMenu(e.currentTarget);
          }}
        >
          <MoreVertical className="size-[16px]" strokeWidth={1.5} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
