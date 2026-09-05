"use client";

import {
  ArrowUpLeft,
  CircleAlert,
  CirclePause,
  LoaderCircle,
  MessagesSquare,
} from "lucide-react";
import { useMemo } from "react";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import { useAgentShellStateMaybe } from "@/components/agent/AgentShellStateContext";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import { listSideChatsOf, sideChatOriginOf } from "@/lib/side-chat";
import type { AgentConversationRecord, AgentConversationStatus } from "@/lib/agent-types";

const STRIP_CLASS =
  "flex min-w-0 items-center gap-[8px] rounded-[8px] border border-[var(--border-subtle)] bg-[var(--bg-card)] px-[10px] py-[6px] font-sans text-[12px] text-[var(--text-secondary)]";

function statusLabel(status: AgentConversationStatus | undefined): string {
  switch (status) {
    case "running":
    case "pause_requested":
    case "pausing":
      return "working";
    case "paused":
      return "paused";
    case "awaiting_permission":
      return "awaiting permission";
    case "awaiting_question":
      return "waiting for you";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    case "interrupted":
      return "interrupted";
    case "idle":
      return "idle";
    default:
      return "unavailable";
  }
}

function StatusGlyph({ status }: { status: AgentConversationStatus | undefined }) {
  switch (status) {
    case "running":
    case "pause_requested":
    case "pausing":
      return (
        <LoaderCircle
          className="size-[12px] shrink-0 animate-spin text-[var(--text-secondary)]"
          strokeWidth={1.6}
          aria-hidden
        />
      );
    case "paused":
      return (
        <CirclePause className="size-[12px] shrink-0 text-[var(--text-disabled)]" strokeWidth={1.6} aria-hidden />
      );
    case "failed":
      return (
        <CircleAlert className="size-[12px] shrink-0 text-[var(--status-error)]" strokeWidth={1.7} aria-hidden />
      );
    case "awaiting_permission":
    case "awaiting_question":
      return (
        <span className="grid size-[12px] shrink-0 place-items-center" aria-hidden>
          <span className="size-[6px] rounded-full bg-[var(--plan-accent)]" />
        </span>
      );
    default:
      return (
        <span className="grid size-[12px] shrink-0 place-items-center" aria-hidden>
          <span className="size-[6px] rounded-full bg-[var(--text-disabled)]" />
        </span>
      );
  }
}

/**
 * Conversation-level chrome for the side-chat relationship.
 *
 * - On a side chat: which primary it belongs to, that primary's live status,
 *   and a control to jump back to it.
 * - On a primary with side chats: one pill per open side chat, each reopening
 *   the child as a full chat in the right editor group. Side chats never take
 *   a rail row, so this is how they stay discoverable.
 */
export function SideChatStrip({
  conversationId,
  className,
}: {
  conversationId: string;
  className?: string;
}) {
  const { conversations, conversationsById } = useAgentConversations();
  const { openAgentConversation } = useOpenInEditor();
  const shell = useAgentShellStateMaybe();
  const conversation = conversationsById[conversationId] ?? null;
  const origin = sideChatOriginOf(conversation);
  const parent: AgentConversationRecord | null = origin
    ? conversationsById[origin.parentConversationId] ?? null
    : null;
  const children = useMemo(
    () =>
      origin
        ? []
        : listSideChatsOf(conversations, conversationId).filter(
            (child) => child.archivedAt == null
          ),
    [conversationId, conversations, origin]
  );

  if (origin) {
    const parentTitle = parent?.title ?? origin.parentTitle ?? "Primary chat";
    const parentId = origin.parentConversationId;
    const focusPrimary = () => {
      if (shell) {
        shell.setSelectedConversationId(parentId);
        return;
      }
      openAgentConversation({ conversationId: parentId, title: parentTitle, group: "left" });
    };
    return (
      <div className={className}>
        <div className={STRIP_CLASS} data-side-chat-strip="child">
          <MessagesSquare className="size-[13px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.7} aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-[var(--text-primary)]">Side chat</span>
            <span aria-hidden> · </span>
            <span>attached to </span>
            <span className="text-[var(--text-primary)]" title={parentTitle}>
              {parentTitle}
            </span>
          </span>
          <span
            className="inline-flex shrink-0 items-center gap-[5px] whitespace-nowrap"
            title={parent ? `Primary chat is ${statusLabel(parent.status)}` : "Primary chat is unavailable"}
          >
            <StatusGlyph status={parent?.status} />
            <span>{statusLabel(parent?.status)}</span>
          </span>
          <button
            type="button"
            onClick={focusPrimary}
            className="inline-flex shrink-0 items-center gap-[4px] rounded-[6px] px-[6px] py-[2px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)]"
            title="Show the primary chat"
          >
            <ArrowUpLeft className="size-[12px]" strokeWidth={1.8} aria-hidden />
            <span>Primary</span>
          </button>
        </div>
      </div>
    );
  }

  if (children.length === 0) {
    return null;
  }

  return (
    <div className={className}>
      <div className={STRIP_CLASS} data-side-chat-strip="parent">
        <MessagesSquare className="size-[13px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.7} aria-hidden />
        <span className="shrink-0 whitespace-nowrap">
          Side chats <span className="text-[var(--text-disabled)]">({children.length})</span>
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-[6px] overflow-x-auto">
          {children.map((child) => (
            <button
              key={child.id}
              type="button"
              onClick={() =>
                openAgentConversation({
                  conversationId: child.id,
                  title: child.title,
                  group: "right",
                })
              }
              className="inline-flex max-w-[220px] shrink-0 items-center gap-[5px] rounded-full border border-[var(--border-subtle)] px-[8px] py-[2px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card-hover)]"
              title={`Open side chat "${child.title}" (${statusLabel(child.status)})`}
            >
              <StatusGlyph status={child.status} />
              <span className="truncate">{child.title}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
