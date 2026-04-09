"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { StickyChatHeader } from "./StickyChatHeader";
import { useChatStickyPush } from "@/hooks/useChatStickyPush";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { TodoStatusCard } from "./TodoStatusCard";
import { TodoCard } from "./TodoCard";
import { SubagentCard } from "./SubagentCard";
import { AskQuestionCard } from "./AskQuestionCard";
import { ActivityLabel } from "./ActivityLabel";
import { WorkedSessionCard } from "./WorkedSessionCard";
import { ShellCommandCard } from "./ShellCommandCard";
import { PermissionRequestCard } from "./PermissionRequestCard";
import { askStepsFromMessage } from "@/lib/ask-question-utils";
import { buildMessageThreadRows, type MessageThreadRow } from "./message-thread-rows";
import type { ChatMessage } from "@/lib/types";

/** Types that end the “live tail” worked-session; later messages must not keep prior cards in loading UI. */
const CHAIN_BREAKING_AFTER_WORKED = new Set<ChatMessage["type"]>([
  "user",
  "assistant",
  "worked-session",
  "permission-request",
  "ask-question",
  "shell-run",
  "subagent",
  "todo",
  "todo-status",
  "activity-label",
]);

export function workedSessionScopedKey(conversationId: string, messageId: string): string {
  return `${conversationId}::${messageId}`;
}

function shouldKeepWorkedSessionLoading(messages: ChatMessage[], startIndex: number): boolean {
  for (let i = startIndex + 1; i < messages.length; i += 1) {
    if (CHAIN_BREAKING_AFTER_WORKED.has(messages[i]!.type)) {
      return false;
    }
  }
  return true;
}

function findLastWorkedSessionIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.type === "worked-session") {
      return i;
    }
  }
  return -1;
}

export interface MessageThreadContentProps {
  messages: ChatMessage[];
  /**
   * Main chat: every user turn is sticky; newer turns stack above and push older ones off.
   * Transcript tab: off.
   */
  stickyUserHeader?: boolean;
  /** Scrollport for progressive “push previous user up” math (main chat only). */
  scrollRootRef?: RefObject<HTMLElement | null>;
  workedSessionSurface?: "panel" | "editor";
  /** When a subagent row has `subagentTranscript`, clicking opens this. */
  onOpenSubagent?: (payload: {
    title: string;
    transcript: ChatMessage[];
    sessionId?: string;
  }) => void;
  onResolvePermission?: (requestId: string, optionId: string) => void;
  onCancelPermission?: (requestId: string) => void;
  /** When set, worked-session expand/collapse is persisted under scoped keys. */
  conversationId?: string;
  /** Conversation is still producing output (last worked block may default-open). */
  conversationBusy?: boolean;
  workedSessionOpenByScopedId?: Record<string, boolean>;
  onWorkedSessionOpenChange?: (scopedKey: string, open: boolean) => void;
  /**
   * Window long threads with @tanstack/react-virtual. Sticky user headers are disabled
   * automatically when this is on (parent should pass stickyUserHeader=false).
   */
  virtualize?: boolean;
}

export function MessageThreadContent({
  messages,
  stickyUserHeader = false,
  scrollRootRef,
  workedSessionSurface = "panel",
  onOpenSubagent,
  onResolvePermission,
  onCancelPermission,
  conversationId,
  conversationBusy = false,
  workedSessionOpenByScopedId,
  onWorkedSessionOpenChange,
  virtualize = false,
}: MessageThreadContentProps) {
  const stickyElMapRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const registerStickyEl = useCallback((order: number, el: HTMLDivElement | null) => {
    const m = stickyElMapRef.current;
    if (el) {
      m.set(order, el);
    } else {
      m.delete(order);
    }
  }, []);

  const pushFor = useChatStickyPush(
    scrollRootRef,
    stickyElMapRef,
    messages,
    !!stickyUserHeader
  );

  const lastWorkedSessionIndex = useMemo(
    () => findLastWorkedSessionIndex(messages),
    [messages]
  );

  const rows = useMemo(() => buildMessageThreadRows(messages), [messages]);

  const renderRow = useCallback(
    (row: MessageThreadRow): ReactNode => {
      if (row.kind === "user_todo") {
        const msg = messages[row.userIndex];
        const next = messages[row.todoIndex];
        if (!msg || !next) {
          return null;
        }
        const stackOrder = row.stackOrder;
        const block = (
          <div className="flex flex-col">
            <UserMessage
              content={msg.content}
              segments={msg.segments}
              attachments={msg.attachments}
              showReplyCue={msg.showReplyCue}
            />
            <TodoStatusCard content={next.content!} meldUserAbove />
          </div>
        );
        return (
          <StickyChatHeader
            key={row.key}
            enabled={!!stickyUserHeader}
            stackOrder={stackOrder}
            pushUpPx={pushFor(stackOrder)}
            registerStickyEl={registerStickyEl}
          >
            {block}
          </StickyChatHeader>
        );
      }

      if (row.kind === "user") {
        const msg = messages[row.index];
        if (!msg || msg.type !== "user") {
          return null;
        }
        const stackOrder = row.stackOrder;
        const inner = (
          <UserMessage
            content={msg.content}
            segments={msg.segments}
            attachments={msg.attachments}
            showReplyCue={msg.showReplyCue}
          />
        );
        return (
          <StickyChatHeader
            key={row.key}
            enabled={!!stickyUserHeader}
            stackOrder={stackOrder}
            pushUpPx={pushFor(stackOrder)}
            registerStickyEl={registerStickyEl}
          >
            {inner}
          </StickyChatHeader>
        );
      }

      const i = row.index;
      const msg = messages[i];
      if (!msg) {
        return null;
      }

      switch (msg.type) {
        case "assistant":
          return <AssistantMessage key={row.key} content={msg.content!} />;
        case "todo-status":
          return <TodoStatusCard key={row.key} content={msg.content!} />;
        case "todo":
          return (
            <TodoCard key={row.key} label={msg.todoLabel!} todos={msg.todos!} />
          );
        case "subagent": {
          if (!onOpenSubagent) {
            return (
              <SubagentCard
                key={row.key}
                title={msg.subagentTitle!}
                meta={msg.subagentMeta}
                recentActivity={msg.recentActivity}
                complete={msg.subagentStatus !== "running"}
              />
            );
          }
          const transcript: ChatMessage[] =
            msg.subagentTranscript?.length
              ? msg.subagentTranscript
              : [
                  {
                    id: `${msg.id}-subagent-trace-missing`,
                    type: "assistant",
                    content:
                      "No transcript payload was attached to this subagent card. In a full product build, opening it would show the exact messages, tool calls, and edits from that run.",
                  },
                ];
          return (
            <SubagentCard
              key={row.key}
              title={msg.subagentTitle!}
              meta={msg.subagentMeta}
              recentActivity={msg.recentActivity}
              complete={msg.subagentStatus !== "running"}
              interactive
              onOpen={() =>
                onOpenSubagent({
                  title: msg.subagentTitle!,
                  transcript,
                  sessionId: msg.subagentId,
                })
              }
            />
          );
        }
        case "ask-question": {
          const steps = askStepsFromMessage(msg);
          if (steps.length) {
            return <AskQuestionCard key={row.key} steps={steps} />;
          }
          return null;
        }
        case "permission-request":
          return (
            <PermissionRequestCard
              key={row.key}
              title={msg.permissionTitle ?? "Permission required"}
              detail={msg.permissionDetail}
              options={msg.permissionOptions ?? []}
              resolved={msg.permissionResolved}
              selectedOptionId={msg.permissionSelectedOptionId}
              onSelect={(optionId) => {
                if (!msg.permissionRequestId) {
                  return;
                }
                onResolvePermission?.(msg.permissionRequestId, optionId);
              }}
              onCancel={
                msg.permissionRequestId && onCancelPermission
                  ? () => onCancelPermission(msg.permissionRequestId!)
                  : undefined
              }
            />
          );
        case "activity-label":
          return (
            <ActivityLabel
              key={row.key}
              label={msg.activityLabel!}
              detail={msg.activityDetail}
              files={msg.activityFiles}
              defaultOpen={msg.activityDefaultOpen}
            />
          );
        case "worked-session": {
          const scopedKey =
            conversationId && onWorkedSessionOpenChange
              ? workedSessionScopedKey(conversationId, msg.id)
              : null;
          const stored =
            scopedKey != null ? workedSessionOpenByScopedId?.[scopedKey] : undefined;
          const chainLoading =
            msg.loading || shouldKeepWorkedSessionLoading(messages, i);
          const isTailForExpandDefault =
            i === lastWorkedSessionIndex &&
            conversationBusy &&
            shouldKeepWorkedSessionLoading(messages, i);
          let openProp: boolean | undefined;
          let onOpenChange: ((v: boolean) => void) | undefined;
          if (scopedKey != null && onWorkedSessionOpenChange) {
            openProp =
              stored !== undefined
                ? stored
                : isTailForExpandDefault && msg.workedDefaultOpen !== false
                  ? true
                  : false;
            onOpenChange = (v: boolean) => {
              onWorkedSessionOpenChange(scopedKey, v);
            };
          }
          return (
            <WorkedSessionCard
              key={row.key}
              label={msg.workedLabel!}
              entries={msg.workedEntries!}
              open={openProp}
              onOpenChange={onOpenChange}
              defaultOpen={msg.workedDefaultOpen}
              loading={chainLoading}
              isLiveWorkedTail={i === lastWorkedSessionIndex && chainLoading}
              surface={workedSessionSurface}
            />
          );
        }
        case "shell-run":
          return <ShellCommandCard key={row.key} title={msg.shellTitle!} />;
        default:
          return null;
      }
    },
    [
      conversationBusy,
      conversationId,
      lastWorkedSessionIndex,
      messages,
      onCancelPermission,
      onOpenSubagent,
      onResolvePermission,
      onWorkedSessionOpenChange,
      pushFor,
      registerStickyEl,
      stickyUserHeader,
      workedSessionOpenByScopedId,
      workedSessionSurface,
    ]
  );

  const useVirtualList =
    virtualize && rows.length >= 16 && scrollRootRef != null;

  const virtualizer = useVirtualizer({
    count: useVirtualList ? rows.length : 0,
    getScrollElement: () => scrollRootRef?.current ?? null,
    estimateSize: () => 132,
    overscan: 8,
  });

  if (useVirtualList) {
    const items = virtualizer.getVirtualItems();
    return (
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {items.map((item) => {
          const row = rows[item.index];
          if (!row) {
            return null;
          }
          return (
            <div
              key={row.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full pb-[10px] [&>*]:shrink-0"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {renderRow(row)}
            </div>
          );
        })}
      </div>
    );
  }

  const nodes: ReactNode[] = rows.map((row) => renderRow(row)).filter(Boolean);
  return (
    <div className="flex flex-col gap-[10px] [&>*]:shrink-0">{nodes}</div>
  );
}
