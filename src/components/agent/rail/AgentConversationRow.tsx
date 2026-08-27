"use client";

import {
  memo,
  useEffect,
  useRef,
  type KeyboardEvent,
  type DragEvent,
  type MouseEvent,
} from "react";
import {
  CheckSquare,
  CircleAlert,
  CircleCheck,
  CirclePause,
  Cloud,
  LoaderCircle,
  MessageCircleQuestion,
  Moon,
  MoreVertical,
  ShieldAlert,
  Square,
} from "lucide-react";
import type { AgentRailConversationSummary } from "@/lib/agent-types";
import {
  getAgentRailStatusInfo,
  type AgentRailRowDetailMode,
  type AgentRailStatusInfo,
} from "@/lib/agent-rail-status";
import { useAgentRailRelativeTime } from "@/hooks/useAgentRailRelativeTime";
import { IntegrationIcon } from "@/components/chat/IntegrationIcon";
import { integrationIconLabel } from "@/lib/integration-icons";

const DETAIL_TONE_CLASSES: Record<AgentRailStatusInfo["tone"], string> = {
  attention: "text-[var(--plan-accent)]",
  error: "text-[var(--status-error)]",
  active: "text-[var(--text-secondary)]",
  accent: "text-[var(--text-secondary)]",
  muted: "text-[var(--text-disabled)]",
};

function ConversationStatusGlyph({
  compact = false,
  selected,
  statusInfo,
}: {
  /** Compact rows keep the classic minimal glyphs: a spinner or a plain dot. */
  compact?: boolean;
  selected: boolean;
  statusInfo: AgentRailStatusInfo;
}) {
  if (compact) {
    if (statusInfo.active) {
      return (
        <LoaderCircle
          className="size-[14px] shrink-0 animate-spin text-[var(--text-secondary)]"
          strokeWidth={1.5}
          aria-hidden
        />
      );
    }
    const dotColor =
      statusInfo.kind === "permission" || statusInfo.kind === "question"
        ? "bg-[var(--plan-accent)]"
        : statusInfo.kind === "failed"
          ? "bg-[var(--status-error)]"
          : selected
            ? "bg-[var(--text-primary)]"
            : "bg-[var(--text-disabled)]";
    return (
      <span className="grid size-[14px] shrink-0 place-items-center" aria-hidden>
        <span className={`size-[6px] rounded-full ${dotColor}`} />
      </span>
    );
  }
  switch (statusInfo.kind) {
    case "permission":
      return (
        <ShieldAlert
          className="size-[14px] shrink-0 text-[var(--plan-accent)]"
          strokeWidth={1.8}
          aria-hidden
        />
      );
    case "question":
      return (
        <MessageCircleQuestion
          className="size-[14px] shrink-0 text-[var(--plan-accent)]"
          strokeWidth={1.8}
          aria-hidden
        />
      );
    case "failed":
      return (
        <CircleAlert
          className="size-[14px] shrink-0 text-[var(--status-error)]"
          strokeWidth={1.8}
          aria-hidden
        />
      );
    case "running":
      return (
        <LoaderCircle
          className="size-[14px] shrink-0 animate-spin text-[var(--text-secondary)]"
          strokeWidth={1.5}
          aria-hidden
        />
      );
    case "pausing":
      return (
        <LoaderCircle
          className="size-[14px] shrink-0 animate-spin text-[var(--text-disabled)]"
          strokeWidth={1.5}
          aria-hidden
        />
      );
    case "paused":
      return (
        <CirclePause
          className="size-[14px] shrink-0 text-[var(--text-disabled)]"
          strokeWidth={1.6}
          aria-hidden
        />
      );
    case "done_unread":
      return (
        <CircleCheck
          className="size-[14px] shrink-0 text-[var(--accent)]"
          strokeWidth={1.6}
          aria-hidden
        />
      );
    default: {
      const dotColor = selected
        ? "bg-[var(--text-primary)]"
        : "bg-[var(--text-disabled)]";
      return (
        <span className="grid size-[14px] shrink-0 place-items-center" aria-hidden>
          <span className={`size-[6px] rounded-full ${dotColor}`} />
        </span>
      );
    }
  }
}

export const AgentConversationRow = memo(function AgentConversationRow({
  conversation,
  detail = "balanced",
  detailContext,
  editValue,
  editing = false,
  onBeginRename,
  onCancelRename,
  onCommitRename,
  onContextMenu,
  onOverflowMenu,
  onEditValueChange,
  onSelect,
  onToggleSettled,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  rowIndex,
  selected,
  bulkSelectMode = false,
  bulkSelected = false,
  showOverflowMenu = false,
  showMachineBadge = false,
  unreadCompletion = false,
  acknowledgedFailure = false,
}: {
  conversation: AgentRailConversationSummary;
  /** Row density; `balanced` grows a detail line only when the row needs one. */
  detail?: AgentRailRowDetailMode;
  /** Extra muted context (e.g. workspace name) appended to the detail line. */
  detailContext?: string;
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
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Small settle toggle on the row card; settled rows sink until a new prompt. */
  onToggleSettled?: (conversation: AgentRailConversationSummary) => void;
  onDragStart?: (event: DragEvent<HTMLDivElement>, conversation: AgentRailConversationSummary) => void;
  onDragEnd?: (event: DragEvent<HTMLDivElement>, conversation: AgentRailConversationSummary) => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>, conversation: AgentRailConversationSummary) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>, conversation: AgentRailConversationSummary) => void;
  rowIndex?: number;
  selected: boolean;
  bulkSelectMode?: boolean;
  bulkSelected?: boolean;
  showOverflowMenu?: boolean;
  showMachineBadge?: boolean;
  unreadCompletion?: boolean;
  acknowledgedFailure?: boolean;
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

  const statusInfo = getAgentRailStatusInfo(conversation, {
    unreadCompletion,
    acknowledgedFailure,
  });

  const relativeTime = useAgentRailRelativeTime(conversation.updatedAt);
  const effectiveDetail: AgentRailRowDetailMode =
    bulkSelectMode || editing ? "compact" : detail;
  let detailText: string | null = null;
  let detailToneClass = DETAIL_TONE_CLASSES[statusInfo.tone];
  if (effectiveDetail !== "compact") {
    if (statusInfo.description) {
      detailText =
        statusInfo.kind === "done_unread" && relativeTime
          ? `${statusInfo.description} · ${relativeTime}`
          : statusInfo.description;
    } else if (effectiveDetail === "expanded" && relativeTime) {
      detailText = relativeTime;
      detailToneClass = DETAIL_TONE_CLASSES.muted;
    }
  }
  const hasDetailLine = detailText != null;

  const settled = conversation.settledAt != null;
  const rowHighlighted = bulkSelectMode ? bulkSelected : selected;
  const rowClassName = `flex w-full gap-[8px] rounded-[var(--agent-control-radius)] px-[9px] text-left select-none ${
    hasDetailLine
      ? "items-start py-[5px]"
      : "h-[var(--agent-rail-row-height)] items-center"
  } ${
    rowHighlighted ? "bg-[var(--agent-card-bg)]" : "hover:bg-[var(--agent-card-bg)]"
  } ${bulkSelectMode && bulkSelected ? "ring-1 ring-[var(--border-subtle)]" : ""}`;

  const titleClassName = `truncate font-sans text-[14px] font-normal ${
    rowHighlighted
      ? "text-[var(--text-primary)]"
      : settled
        ? "text-[var(--text-disabled)]"
        : "text-[var(--text-secondary)]"
  }`;

  const statusIcon = bulkSelectMode ? (
    bulkSelected ? (
      <CheckSquare
        className="size-[14px] shrink-0 text-[var(--text-primary)]"
        strokeWidth={1.6}
        aria-hidden
      />
    ) : (
      <Square
        className="size-[14px] shrink-0 text-[var(--text-disabled)]"
        strokeWidth={1.6}
        aria-hidden
      />
    )
  ) : (
    <ConversationStatusGlyph
      statusInfo={statusInfo}
      selected={selected}
      compact={effectiveDetail === "compact"}
    />
  );
  const isOrchestrationMode =
    String(conversation.mode).trim().toLowerCase() === "orchestration";
  const origin = conversation.origin;
  // Imported conversations render exactly like native ones - no badge.
  // Provenance stays discoverable via the hover title only.
  const originProviderId = origin?.kind === "cloud" ? origin.providerId : null;
  const originTitle = origin
    ? origin.kind === "cloud"
      ? `Triggered from ${integrationIconLabel(origin.providerId)}${
          origin.label ? ` · ${origin.label}` : ""
        }`
      : origin.kind === "cloud-snapshot"
        ? `Imported from your cloud context${
            origin.sourceServerName ? ` · ${origin.sourceServerName}` : ""
          }`
        : origin.kind === "trigger"
          ? `Fired by scheduled trigger${origin.triggerName ? ` "${origin.triggerName}"` : ""}`
          : `Imported from ${origin.backendId} · session ${origin.externalSessionId}`
    : undefined;

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

  const badges = (
    <>
      {conversation.executionTarget === "cloud" ? (
        <span
          title="Runs on the harness vendor's cloud (e.g. Cursor Cloud)"
          className="inline-flex size-[16px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)]"
        >
          <Cloud className="size-[11px]" strokeWidth={1.7} aria-hidden />
        </span>
      ) : null}
      {showMachineBadge && conversation.serverLabel ? (
        <span className="max-w-[72px] shrink truncate rounded-[var(--radius-tab)] bg-[var(--bg-card)] px-[4px] py-px font-sans text-[9px] text-[var(--text-disabled)]">
          {conversation.serverLabel}
        </span>
      ) : null}
      {isOrchestrationMode ? (
        <span className="shrink-0 rounded-[var(--radius-tab)] border border-[color-mix(in_srgb,var(--orchestration-accent)_35%,transparent)] bg-[var(--orchestration-accent-bg)] px-[5px] py-px font-mono text-[9px] font-medium uppercase tracking-[0.04em] text-[var(--orchestration-accent)]">
          ORCH
        </span>
      ) : null}
      {originProviderId ? (
        <span
          title={originTitle}
          className="inline-flex size-[16px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] border border-[color-mix(in_srgb,var(--accent)_35%,transparent)] bg-[var(--accent-bg)] text-[var(--accent)]"
        >
          <IntegrationIcon
            providerId={originProviderId}
            className="size-[10px]"
            tone="text"
          />
        </span>
      ) : null}
    </>
  );

  const rowTitle = detailText
    ? `${conversation.title}\n${detailText}${detailContext ? ` · ${detailContext}` : ""}`
    : conversation.title;

  return (
    // `content-visibility: auto` lets the browser skip layout/paint for rows
    // scrolled out of view - the rail has no virtualization, so with very
    // large conversation sets this is what keeps scrolling and re-renders
    // cheap. The intrinsic-size hint keeps the scrollbar stable.
    <div
      className="group flex w-full min-w-0 items-center gap-[4px] [content-visibility:auto] [contain-intrinsic-size:auto_30px]"
      draggable={Boolean(onDragStart) && !bulkSelectMode}
      onDragStart={
        onDragStart ? (event) => onDragStart(event, conversation) : undefined
      }
      onDragEnd={onDragEnd ? (event) => onDragEnd(event, conversation) : undefined}
      onDragOver={
        onDragOver ? (event) => onDragOver(event, conversation) : undefined
      }
      onDrop={onDrop ? (event) => onDrop(event, conversation) : undefined}
      data-perf="agent-rail-row"
      data-conversation-id={conversation.id}
      data-rail-row-index={rowIndex}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={bulkSelectMode ? bulkSelected : undefined}
        onContextMenu={handleContextMenu}
        data-perf="agent-rail-row-button"
        className={`${rowClassName} min-w-0 flex-1`}
        title={rowTitle}
      >
        {hasDetailLine ? (
          <>
            <span className="flex h-[20px] shrink-0 items-center">{statusIcon}</span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-[8px]">
                <span
                  className={`${titleClassName} min-w-0 flex-1 leading-[20px]`}
                  data-perf="agent-rail-row-title"
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    onBeginRename?.();
                  }}
                >
                  {conversation.title}
                </span>
                {badges}
              </span>
              <span
                className="flex min-w-0 items-baseline gap-[5px] pt-px font-sans text-[11px] leading-[15px]"
                data-perf="agent-rail-row-detail"
              >
                <span className={`truncate ${detailToneClass}`}>{detailText}</span>
                {detailContext ? (
                  <span className="min-w-0 shrink-[2] truncate text-[var(--text-disabled)]">
                    · {detailContext}
                  </span>
                ) : null}
              </span>
            </span>
          </>
        ) : (
          <>
            {statusIcon}
            <span
              className={titleClassName}
              data-perf="agent-rail-row-title"
              onDoubleClick={(event) => {
                event.stopPropagation();
                if (bulkSelectMode) {
                  return;
                }
                onBeginRename?.();
              }}
            >
              {conversation.title}
            </span>
            {badges}
          </>
        )}
      </button>
      {onToggleSettled && !bulkSelectMode ? (
        <button
          type="button"
          data-perf="agent-rail-row-settle"
          className={`flex size-[22px] shrink-0 items-center justify-center rounded-[var(--agent-control-radius)] text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)] ${
            settled ? "" : "rail-settle-hit"
          }`}
          aria-label={
            settled
              ? `Unsettle ${conversation.title}`
              : `Settle ${conversation.title}`
          }
          aria-pressed={settled}
          title={settled ? "Settled · click to unsettle" : "Settle conversation"}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggleSettled(conversation);
          }}
        >
          <Moon
            className="size-[13px]"
            strokeWidth={1.6}
            fill={settled ? "currentColor" : "none"}
            aria-hidden
          />
        </button>
      ) : null}
      {showOverflowMenu && onOverflowMenu ? (
        <button
          type="button"
          className="mr-[4px] flex size-[24px] shrink-0 items-center justify-center rounded-[var(--agent-control-radius)] text-[var(--text-secondary)] opacity-0 pointer-events-none hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)] group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:bg-[var(--accent-bg)] focus-visible:text-[var(--text-primary)] focus-visible:opacity-100"
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
});
