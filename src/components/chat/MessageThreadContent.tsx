"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { StickyChatHeader } from "./StickyChatHeader";
import { useChatStickyPush } from "@/hooks/useChatStickyPush";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { TodoStatusCard } from "./TodoStatusCard";
import { TodoCard } from "./TodoCard";
import { LiveSubagentCard } from "./LiveSubagentCard";
import { AskQuestionCard } from "./AskQuestionCard";
import { ActivityLabel } from "./ActivityLabel";
import { WorkedSessionCard } from "./WorkedSessionCard";
import { ShellCommandCard } from "./ShellCommandCard";
import { PermissionRequestCard } from "./PermissionRequestCard";
import { HandoffDivider } from "./HandoffDivider";
import { ForkDivider } from "./ForkDivider";
import { askStepsFromMessage } from "@/lib/ask-question-utils";
import {
  buildMessageThreadSegments,
  type MessageThreadSegment,
  type UserTurnSegment,
} from "./message-thread-rows";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import type { ChatMessage } from "@/lib/types";
import { stripAgentTodoJsonAssistantContent } from "@/lib/agent-chat";

/**
 * Types that end the “live tail” worked-session; later messages must not keep prior cards in
 * loading UI.
 *
 * `permission-request` is intentionally omitted: permissions usually follow the same tool burst and
 * are often embedded in the worked card — treating them as chain-breaking flipped `loading` off and
 * auto-collapsed the tool dropdown, hiding the permission UI that needs a response.
 */
const CHAIN_BREAKING_AFTER_WORKED = new Set<ChatMessage["type"]>([
  "user",
  "assistant",
  "worked-session",
  "ask-question",
  "shell-run",
  "activity-label",
  "agent-handoff",
  "chat-fork",
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
  /** Scrollport for progressive "push previous user up" math (main chat only). */
  scrollRootRef?: RefObject<HTMLElement | null>;
  workedSessionSurface?: "panel" | "editor";
  /** When a subagent row has `subagentTranscript`, clicking opens this. */
  onOpenSubagent?: (payload: {
    title: string;
    transcript: ChatMessage[];
    sessionId?: string;
  }) => void;
  onResolvePermission?: (requestId: string, optionId: string, commandHint?: string) => void;
  /** When set, worked-session expand/collapse is persisted under scoped keys. */
  conversationId?: string;
  /** Conversation is still producing output (last worked block may default-open). */
  conversationBusy?: boolean;
  workedSessionOpenByScopedId?: Record<string, boolean>;
  onWorkedSessionOpenChange?: (scopedKey: string, open: boolean) => void;
  /** Absolute workspace root for concise tool path lists. */
  workspaceRoot?: string | null;
  /**
   * Window long threads with @tanstack/react-virtual. Turn blocks use `top` (not `transform`) so
   * inner `position: sticky` can use the main scrollport.
   */
  virtualize?: boolean;
  /** Callback when user clicks the fork button on a user message. messageId is the ChatMessage.id. */
  onForkMessage?: (messageId: string) => void;
}

export function MessageThreadContent({
  messages,
  stickyUserHeader = false,
  scrollRootRef,
  workedSessionSurface = "panel",
  onOpenSubagent,
  onResolvePermission,
  conversationId,
  conversationBusy = false,
  workedSessionOpenByScopedId,
  onWorkedSessionOpenChange,
  virtualize = false,
  workspaceRoot = null,
  onForkMessage,
}: MessageThreadContentProps) {
  const { settings } = useGlobalSettings();
  const inlineToolDetailsInChat = settings.agents.inlineToolDetailsInChat;

  const { embeddedPermissionByWorkedId, skipPermissionMessageIndex } = useMemo(() => {
    const embedded = new Map<string, ChatMessage>();
    const skip = new Set<number>();
    if (inlineToolDetailsInChat) {
      return { embeddedPermissionByWorkedId: embedded, skipPermissionMessageIndex: skip };
    }
    for (let i = 1; i < messages.length; i += 1) {
      const prev = messages[i - 1];
      const cur = messages[i];
      if (
        prev?.type === "worked-session" &&
        cur?.type === "permission-request" &&
        cur.permissionRequestId
      ) {
        embedded.set(prev.id, cur);
        skip.add(i);
      }
    }
    return { embeddedPermissionByWorkedId: embedded, skipPermissionMessageIndex: skip };
  }, [inlineToolDetailsInChat, messages]);

  const stickyElMapRef = useRef<Map<number, HTMLDivElement>>(new Map());
  useEffect(() => {
    stickyElMapRef.current.clear();
  }, [conversationId]);
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

  const segments = useMemo(() => buildMessageThreadSegments(messages), [messages]);

  const renderMessageAtIndex = useCallback(
    (i: number): ReactNode => {
      const msg = messages[i];
      if (!msg) {
        return null;
      }
      const rowKey = msg.id;
      switch (msg.type) {
        case "user":
          return null;
        case "todo-status":
          return (
            <div key={rowKey} data-chat-message-id={msg.id} className="min-w-0 w-full">
              <TodoStatusCard content={msg.content!} />
            </div>
          );
        case "assistant": {
          const assistantBody = stripAgentTodoJsonAssistantContent(msg.content ?? "");
          if (!assistantBody.trim()) {
            return null;
          }
          return (
            <div key={rowKey} data-chat-message-id={msg.id} className="min-w-0 w-full">
              <AssistantMessage content={assistantBody} />
            </div>
          );
        }
        case "todo":
          return (
            <div key={rowKey} data-chat-message-id={msg.id} className="min-w-0 w-full">
              <TodoCard label={msg.todoLabel!} todos={msg.todos!} />
            </div>
          );
        case "subagent": {
          if (!onOpenSubagent) {
            return (
              <div key={rowKey} data-chat-message-id={msg.id} className="min-w-0 w-full">
                <LiveSubagentCard
                  title={msg.subagentTitle!}
                  meta={msg.subagentMeta}
                  recentActivity={msg.recentActivity}
                  complete={msg.subagentStatus !== "running"}
                  transcript={msg.subagentTranscript}
                  sessionId={msg.subagentId}
                />
              </div>
            );
          }
          return (
            <div key={rowKey} data-chat-message-id={msg.id} className="min-w-0 w-full">
              <LiveSubagentCard
                title={msg.subagentTitle!}
                meta={msg.subagentMeta}
                recentActivity={msg.recentActivity}
                complete={msg.subagentStatus !== "running"}
                transcript={
                  msg.subagentTranscript?.length
                    ? msg.subagentTranscript
                    : [
                        {
                          id: `${msg.id}-subagent-trace-missing`,
                          type: "assistant",
                          content:
                            "No transcript payload was attached to this subagent card. In a full product build, opening it would show the exact messages, tool calls, and edits from that run.",
                        },
                      ]
                }
                sessionId={msg.subagentId}
                onOpenTranscript={({ transcript, sessionId }) =>
                  onOpenSubagent({
                    title: msg.subagentTitle!,
                    transcript,
                    sessionId,
                  })
                }
              />
            </div>
          );
        }
        case "ask-question": {
          const steps = askStepsFromMessage(msg);
          if (steps.length) {
            return (
              <div key={rowKey} data-chat-message-id={msg.id} className="min-w-0 w-full">
                <AskQuestionCard steps={steps} />
              </div>
            );
          }
          return null;
        }
        case "permission-request":
          if (skipPermissionMessageIndex.has(i)) {
            return null;
          }
          return (
            <div key={rowKey} data-chat-message-id={msg.id} className="min-w-0 w-full">
              <PermissionRequestCard
                title={msg.permissionTitle ?? "Permission required"}
                detail={msg.permissionDetail}
                options={msg.permissionOptions ?? []}
                resolved={msg.permissionResolved}
                selectedOptionId={msg.permissionSelectedOptionId}
                onSelect={(optionId) => {
                  if (!msg.permissionRequestId) {
                    return;
                  }
                  onResolvePermission?.(
                    msg.permissionRequestId,
                    optionId,
                    msg.permissionDetail
                  );
                }}
              />
            </div>
          );
        case "activity-label":
          return (
            <div key={rowKey} data-chat-message-id={msg.id} className="min-w-0 w-full">
              <ActivityLabel
                label={msg.activityLabel!}
                detail={msg.activityDetail}
                files={msg.activityFiles}
                defaultOpen={msg.activityDefaultOpen}
              />
            </div>
          );
        case "worked-session": {
          const scopedKey =
            conversationId && onWorkedSessionOpenChange
              ? workedSessionScopedKey(conversationId, msg.id)
              : null;
          const stored =
            scopedKey != null ? workedSessionOpenByScopedId?.[scopedKey] : undefined;
          const chainLoading =
            msg.loading ||
            (conversationBusy && shouldKeepWorkedSessionLoading(messages, i));
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
            <div key={rowKey} data-chat-message-id={msg.id} className="min-w-0 w-full">
              <WorkedSessionCard
                label={msg.workedLabel!}
                entries={msg.workedEntries!}
                highlightedEntry={msg.workedHighlightedEntry}
                open={openProp}
                onOpenChange={onOpenChange}
                defaultOpen={msg.workedDefaultOpen}
                loading={chainLoading}
                isLiveWorkedTail={i === lastWorkedSessionIndex && chainLoading}
                surface={workedSessionSurface}
                workspaceRoot={workspaceRoot}
                toolDetailsInWorkedCard={!inlineToolDetailsInChat}
                embeddedPermission={embeddedPermissionByWorkedId.get(msg.id) ?? null}
                onResolvePermission={onResolvePermission}
              />
            </div>
          );
        }
        case "shell-run":
          return (
            <div key={rowKey} data-chat-message-id={msg.id} className="min-w-0 w-full">
              <ShellCommandCard title={msg.shellTitle!} />
            </div>
          );
        case "agent-handoff":
          return (
            <div key={rowKey} data-chat-message-id={msg.id} className="min-w-0 w-full">
              <HandoffDivider
                fromAgent={msg.handoffFromAgent!}
                toAgent={msg.handoffToAgent!}
              />
            </div>
          );
        case "chat-fork":
          return (
            <div key={rowKey} data-chat-message-id={msg.id} className="min-w-0 w-full">
              <ForkDivider fromAgent={msg.forkFromAgent!} />
            </div>
          );
        default:
          return null;
      }
    },
    [
      conversationBusy,
      conversationId,
      embeddedPermissionByWorkedId,
      inlineToolDetailsInChat,
      lastWorkedSessionIndex,
      messages,
      onOpenSubagent,
      onResolvePermission,
      onWorkedSessionOpenChange,
      skipPermissionMessageIndex,
      workedSessionOpenByScopedId,
      workedSessionSurface,
      workspaceRoot,
    ]
  );

  const renderUserTurnHeader = useCallback(
    (turn: UserTurnSegment): ReactNode => {
      const stackOrder = turn.stackOrder;
      if (turn.userKind === "user_todo") {
        const userMsg = messages[turn.userIndex];
        const todoMsg = messages[turn.todoIndex];
        if (!userMsg || !todoMsg) {
          return null;
        }
        const block = (
          <div className="flex flex-col">
            <UserMessage
              content={userMsg.content}
              segments={userMsg.segments}
              attachments={userMsg.attachments}
              showReplyCue={userMsg.showReplyCue}
              highlight={userMsg.isHandoffMessage}
              onFork={onForkMessage ? () => onForkMessage(userMsg.id) : undefined}
            />
            <TodoStatusCard content={todoMsg.content!} meldUserAbove />
          </div>
        );
        return (
          <StickyChatHeader
            enabled={!!stickyUserHeader}
            stackOrder={stackOrder}
            pushUpPx={pushFor(stackOrder)}
            registerStickyEl={registerStickyEl}
            dataChatMessageId={userMsg.id}
          >
            {block}
          </StickyChatHeader>
        );
      }
      const userMsg = messages[turn.userIndex];
      if (!userMsg || userMsg.type !== "user") {
        return null;
      }
      const inner = (
        <UserMessage
          content={userMsg.content}
          segments={userMsg.segments}
          attachments={userMsg.attachments}
          showReplyCue={userMsg.showReplyCue}
          highlight={userMsg.isHandoffMessage}
          onFork={onForkMessage ? () => onForkMessage(userMsg.id) : undefined}
        />
      );
      return (
        <StickyChatHeader
          enabled={!!stickyUserHeader}
          stackOrder={stackOrder}
          pushUpPx={pushFor(stackOrder)}
          registerStickyEl={registerStickyEl}
          dataChatMessageId={userMsg.id}
        >
          {inner}
        </StickyChatHeader>
      );
    },
    [messages, onForkMessage, pushFor, registerStickyEl, stickyUserHeader]
  );

  const renderSegment = useCallback(
    (segment: MessageThreadSegment): ReactNode => {
      if (segment.type === "preamble") {
        return (
          <div
            key={segment.key}
            className="flex min-w-0 w-full flex-col gap-[10px] [&>*]:shrink-0"
          >
            {segment.messageIndices.map((i) => renderMessageAtIndex(i))}
          </div>
        );
      }
      return (
        <div
          key={segment.key}
          className="flex min-w-0 w-full flex-col gap-[10px] [&>*]:shrink-0"
        >
          {renderUserTurnHeader(segment)}
          {segment.tailIndices.map((i) => renderMessageAtIndex(i))}
        </div>
      );
    },
    [renderMessageAtIndex, renderUserTurnHeader]
  );

  const useVirtualList =
    virtualize && messages.length >= 16 && scrollRootRef != null;

  const virtualizer = useVirtualizer({
    count: useVirtualList ? segments.length : 0,
    getScrollElement: () => scrollRootRef?.current ?? null,
    estimateSize: (index) => {
      const seg = segments[index];
      if (!seg) {
        return 180;
      }
      if (seg.type === "preamble") {
        return Math.min(2400, 80 + seg.messageIndices.length * 72);
      }
      return Math.min(16000, 200 + (seg.tailIndices.length + 1) * 100);
    },
    overscan: 4,
    getItemKey: (index) => `${conversationId ?? "none"}:${segments[index]?.key ?? String(index)}`,
  });

  if (useVirtualList) {
    const items = virtualizer.getVirtualItems();
    return (
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {items.map((item) => {
          const seg = segments[item.index];
          if (!seg) {
            return null;
          }
          return (
            <div
              key={seg.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 w-full pb-[10px] [&>*]:shrink-0"
              style={{ top: item.start }}
            >
              {renderSegment(seg)}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[10px] [&>*]:shrink-0">
      {segments.map((seg) => renderSegment(seg))}
    </div>
  );
}
