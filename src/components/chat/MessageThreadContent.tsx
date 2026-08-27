"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { StickyChatHeader } from "./StickyChatHeader";
import { getChatStickyRailInsetPx } from "./chat-sticky-rail";
import { useChatStickyPush } from "@/hooks/useChatStickyPush";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { TodoStatusCard } from "./TodoStatusCard";
import { TodoCard } from "./TodoCard";
import { TodoUpdateCard } from "./TodoUpdateCard";
import { LiveSubagentCard } from "./LiveSubagentCard";
import { ActivityLabel } from "./ActivityLabel";
import { WorkedSessionCard } from "./WorkedSessionCard";
import { ShellCommandCard } from "./ShellCommandCard";
import { PermissionRequestCard } from "./PermissionRequestCard";
import { HandoffDivider } from "./HandoffDivider";
import { ForkDivider } from "./ForkDivider";
import { TurnCompletionFooter } from "./TurnCompletionFooter";
import {
  buildMessageThreadSegments,
  findUserTurnSegmentIndex,
  type MessageThreadSegment,
  type UserTurnSegment,
} from "./message-thread-rows";
import {
  getSettledTurnContext,
  isSettledWorkIndex,
  extractFinalAssistantResponseForTurn,
} from "./turn-settle";
import type { ChatMessage } from "@/lib/types";
import { stripAgentTodoJsonAssistantContent } from "@/lib/agent-chat";
import { shouldHideCompletionFailureInThread } from "@/lib/agent-completion-error";
import {
  contentTopOfElementInScrollRoot,
  findChatMessageElement,
  notifyScrollElementLayout,
  scrollTopForAnchor,
} from "@/lib/chat-scroll-anchor";
import type { ChatScrollAnchor } from "@/lib/workspace-session";

/**
 * Types that end the “live tail” worked-session; later messages must not keep prior cards in
 * loading UI.
 *
 * `permission-request` is intentionally omitted: permissions usually follow the same tool burst and
 * are often embedded in the worked card - treating them as chain-breaking flipped `loading` off and
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
  "turn-footer",
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
   * each turn's `position: sticky` user header pins against the main scrollport, clamped inside
   * its own absolutely-positioned row (which is the header's containing block).
   */
  virtualize?: boolean;
  /** Callback when user clicks the fork button on a user message. messageId is the ChatMessage.id. */
  onForkMessage?: (messageId: string) => void;
  /** Callback when user clicks the return arrow on a user message. */
  onRedoMessage?: (message: ChatMessage) => void;
  /** Render an inline composer for the user message currently being redone. */
  renderUserMessageEditor?: (message: ChatMessage) => ReactNode;
  editingUserMessageId?: string | null;
  /** Active chat composer draft; enables cite-from-selection into the composer. */
  composerDraftId?: string | null;
  /** Imperative turn navigation requested by the message ticker. */
  userMessageNavigation?: { messageId: string; requestId: number } | null;
  /** Imperative scroll anchor restore requested after older-history prepends. */
  scrollAnchorRequest?: {
    anchor: ChatScrollAnchor;
    requestId: number;
  } | null;
}

/** Stable identity for the non-virtualized case so downstream memos don't re-fire every render. */
const EMPTY_VIRTUAL_ITEMS: never[] = [];

/**
 * Memoized rows. Projection reconciliation (`projectAgentEventsToChatMessages`)
 * keeps `ChatMessage` object identity stable across streaming flushes, so a
 * shallow prop comparison skips re-rendering every row whose message did not
 * change. Callbacks that would otherwise be fresh inline closures each render
 * are built inside the wrappers from stable handler props.
 */
const UserMessageRow = memo(function UserMessageRow({
  message,
  composerDraftId,
  onRedoMessage,
}: {
  message: ChatMessage;
  composerDraftId?: string | null;
  onRedoMessage?: (message: ChatMessage) => void;
}) {
  const onRedo = useMemo(
    () => (onRedoMessage ? () => onRedoMessage(message) : undefined),
    [message, onRedoMessage]
  );
  return (
    <UserMessage
      content={message.content}
      segments={message.segments}
      attachments={message.attachments}
      showReplyCue={message.showReplyCue}
      highlight={message.isHandoffMessage}
      composerDraftId={composerDraftId}
      onRedo={onRedo}
    />
  );
});

const PermissionRequestRow = memo(function PermissionRequestRow({
  message,
  onResolvePermission,
}: {
  message: ChatMessage;
  onResolvePermission?: (requestId: string, optionId: string, commandHint?: string) => void;
}) {
  const handleSelect = useCallback(
    (optionId: string) => {
      if (!message.permissionRequestId) {
        return;
      }
      onResolvePermission?.(message.permissionRequestId, optionId, message.permissionDetail);
    },
    [message, onResolvePermission]
  );
  return (
    <PermissionRequestCard
      title={message.permissionTitle ?? "Permission required"}
      detail={message.permissionDetail}
      options={message.permissionOptions ?? []}
      resolved={message.permissionResolved}
      selectedOptionId={message.permissionSelectedOptionId}
      onSelect={handleSelect}
    />
  );
});

const WorkedSessionRow = memo(function WorkedSessionRow({
  message,
  scopedKey,
  open,
  onWorkedSessionOpenChange,
  loading,
  isLiveWorkedTail,
  workspaceRoot,
  embeddedPermission,
  onResolvePermission,
  contentRail,
  settled,
}: {
  message: ChatMessage;
  scopedKey: string | null;
  open: boolean | undefined;
  onWorkedSessionOpenChange?: (scopedKey: string, open: boolean) => void;
  loading: boolean;
  isLiveWorkedTail: boolean;
  workspaceRoot: string | null;
  embeddedPermission: ChatMessage | null;
  onResolvePermission?: (requestId: string, optionId: string, commandHint?: string) => void;
  contentRail: boolean;
  settled: boolean;
}) {
  const handleOpenChange = useMemo(
    () =>
      scopedKey != null && onWorkedSessionOpenChange
        ? (value: boolean) => onWorkedSessionOpenChange(scopedKey, value)
        : undefined,
    [scopedKey, onWorkedSessionOpenChange]
  );
  return (
    <WorkedSessionCard
      label={message.workedLabel!}
      entries={message.workedEntries!}
      highlightedEntry={message.workedHighlightedEntry}
      open={open}
      onOpenChange={handleOpenChange}
      defaultOpen={message.workedDefaultOpen}
      loading={loading}
      isLiveWorkedTail={isLiveWorkedTail}
      workspaceRoot={workspaceRoot}
      toolDetailsInWorkedCard
      embeddedPermission={embeddedPermission}
      onResolvePermission={onResolvePermission}
      contentRail={contentRail}
      settled={settled}
    />
  );
});

export function scrollTopForVirtualUserTurnAnchor(
  segments: MessageThreadSegment[],
  messages: ChatMessage[],
  anchor: ChatScrollAnchor,
  getOffsetForIndex: (index: number) => number | null | undefined
): number | null {
  const segmentIndex = findUserTurnSegmentIndex(segments, messages, anchor.messageId);
  if (segmentIndex < 0) {
    return null;
  }
  const offset = getOffsetForIndex(segmentIndex);
  return offset == null ? null : Math.max(0, offset + anchor.delta);
}

export function MessageThreadContent({
  messages,
  stickyUserHeader = false,
  scrollRootRef,
  onOpenSubagent,
  onResolvePermission,
  conversationId,
  conversationBusy = false,
  workedSessionOpenByScopedId,
  onWorkedSessionOpenChange,
  virtualize = false,
  workspaceRoot = null,
  onForkMessage,
  onRedoMessage,
  renderUserMessageEditor,
  editingUserMessageId,
  composerDraftId,
  userMessageNavigation,
  scrollAnchorRequest,
}: MessageThreadContentProps) {
  const { embeddedPermissionByWorkedId, skipPermissionMessageIndex } = useMemo(() => {
    const embedded = new Map<string, ChatMessage>();
    const skip = new Set<number>();
    const workedIdByToolCallId = new Map<string, string>();
    for (const message of messages) {
      if (message.type !== "worked-session") {
        continue;
      }
      for (const entry of message.workedEntries ?? []) {
        if (entry.kind === "tool" && entry.toolCallId) {
          workedIdByToolCallId.set(entry.toolCallId, message.id);
        }
      }
    }
    for (let i = 0; i < messages.length; i += 1) {
      const cur = messages[i];
      if (cur?.type !== "permission-request" || !cur.permissionRequestId) {
        continue;
      }
      if (cur.permissionResolved) {
        skip.add(i);
        continue;
      }
      const linkedWorkedId = cur.permissionLinkedToolCallId
        ? workedIdByToolCallId.get(cur.permissionLinkedToolCallId)
        : undefined;
      if (linkedWorkedId) {
        const existing = embedded.get(linkedWorkedId);
        if (!existing || existing.permissionResolved || !cur.permissionResolved) {
          embedded.set(linkedWorkedId, cur);
        }
        skip.add(i);
        continue;
      }
      const prev = messages[i - 1];
      if (prev?.type === "worked-session") {
        embedded.set(prev.id, cur);
        skip.add(i);
      }
    }
    return { embeddedPermissionByWorkedId: embedded, skipPermissionMessageIndex: skip };
  }, [messages]);

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

  const useVirtualList = virtualize && messages.length >= 16 && scrollRootRef != null;

  /**
   * Non-virtual threads stack every turn in one flow parent, so older headers must be pushed
   * off with scroll-driven math. Virtual rows are each their own containing block: CSS clamps
   * the sticky header inside its turn and hands off to the next turn natively (and entirely on
   * the compositor, which keeps slow WebViews in sync), so no push math is needed there.
   */
  const useScriptedStickyPush = !!stickyUserHeader && !useVirtualList;

  const pushFor = useChatStickyPush(
    scrollRootRef,
    stickyElMapRef,
    messages,
    useScriptedStickyPush
  );

  const lastWorkedSessionIndex = useMemo(
    () => findLastWorkedSessionIndex(messages),
    [messages]
  );

  const segments = useMemo(() => buildMessageThreadSegments(messages), [messages]);
  const lastUserMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.type === "user") {
        return message.id;
      }
    }
    return null;
  }, [messages]);
  const settledTurnContext = useMemo(
    () => getSettledTurnContext(segments, messages, conversationBusy),
    [conversationBusy, messages, segments]
  );
  const prevConversationBusyRef = useRef(conversationBusy);

  useEffect(() => {
    const wasBusy = prevConversationBusyRef.current;
    prevConversationBusyRef.current = conversationBusy;
    if (!wasBusy || conversationBusy || !settledTurnContext.settled) {
      return;
    }
    if (!conversationId || !onWorkedSessionOpenChange) {
      return;
    }
    for (const index of settledTurnContext.tailIndexSet) {
      if (index >= settledTurnContext.lastAssistantIndex) {
        continue;
      }
      const message = messages[index];
      if (message?.type !== "worked-session") {
        continue;
      }
      onWorkedSessionOpenChange(
        workedSessionScopedKey(conversationId, message.id),
        false
      );
    }
  }, [
    conversationBusy,
    conversationId,
    messages,
    onWorkedSessionOpenChange,
    settledTurnContext,
  ]);

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
              <AssistantMessage content={assistantBody} composerDraftId={composerDraftId} />
            </div>
          );
        }
        case "todo":
          return (
            <div key={rowKey} data-chat-message-id={msg.id} className="min-w-0 w-full">
              <TodoCard label={msg.todoLabel!} todos={msg.todos!} />
            </div>
          );
        case "todo-update":
          return (
            <div key={rowKey} data-chat-message-id={msg.id} className="min-w-0 w-full">
              <TodoUpdateCard todo={msg.todos![0]!} />
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
        case "ask-question":
          return null;
        case "permission-request":
          if (skipPermissionMessageIndex.has(i) || msg.permissionResolved) {
            return null;
          }
          return (
            <div key={rowKey} data-chat-message-id={msg.id} className="relative z-[3] min-w-0 w-full">
              <PermissionRequestRow
                message={msg}
                onResolvePermission={onResolvePermission}
              />
            </div>
          );
        case "activity-label":
          if (
            msg.activityLabel === "Permission resolved" ||
            msg.activityLabel === "Permission cancelled"
          ) {
            return null;
          }
          if (shouldHideCompletionFailureInThread(msg.activityLabel, msg.activityDetail)) {
            return null;
          }
          return (
            <div key={rowKey} data-chat-message-id={msg.id} className="min-w-0 w-full">
              <ActivityLabel
                label={msg.activityLabel!}
                detail={msg.activityDetail}
                files={msg.activityFiles}
                defaultOpen={msg.activityDefaultOpen}
                contentRail={!isSettledWorkIndex(i, settledTurnContext)}
                settled={isSettledWorkIndex(i, settledTurnContext)}
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
          if (scopedKey != null && onWorkedSessionOpenChange) {
            openProp =
              stored !== undefined
                ? stored
                : isTailForExpandDefault && msg.workedDefaultOpen !== false
                  ? true
                  : false;
          }
          const isSettledWork = isSettledWorkIndex(i, settledTurnContext);
          return (
            <div key={rowKey} data-chat-message-id={msg.id} className="relative z-[2] min-w-0 w-full">
              <WorkedSessionRow
                message={msg}
                scopedKey={scopedKey}
                open={openProp}
                onWorkedSessionOpenChange={onWorkedSessionOpenChange}
                loading={chainLoading}
                isLiveWorkedTail={i === lastWorkedSessionIndex && chainLoading}
                workspaceRoot={workspaceRoot}
                embeddedPermission={embeddedPermissionByWorkedId.get(msg.id) ?? null}
                onResolvePermission={onResolvePermission}
                contentRail={!isSettledWork}
                settled={isSettledWork}
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
        case "turn-footer": {
          if (
            conversationBusy &&
            msg.turnFooterUserMessageId &&
            msg.turnFooterUserMessageId === lastUserMessageId
          ) {
            return null;
          }
          if (msg.turnDurationMs == null || !msg.turnFooterUserMessageId) {
            return null;
          }
          return (
            <div key={rowKey} data-chat-message-id={msg.id} className="min-w-0 w-full">
              <TurnCompletionFooter
                durationMs={msg.turnDurationMs}
                onFork={
                  onForkMessage
                    ? () => onForkMessage(msg.turnFooterUserMessageId!)
                    : undefined
                }
                copyText={extractFinalAssistantResponseForTurn(
                  messages,
                  msg.turnFooterUserMessageId!
                )}
              />
            </div>
          );
        }
        default:
          return null;
      }
    },
    [
      composerDraftId,
      conversationBusy,
      conversationId,
      embeddedPermissionByWorkedId,
      lastUserMessageId,
      lastWorkedSessionIndex,
      messages,
      onForkMessage,
      onOpenSubagent,
      onResolvePermission,
      onWorkedSessionOpenChange,
      settledTurnContext,
      skipPermissionMessageIndex,
      workedSessionOpenByScopedId,
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
        const todoBlock =
          todoMsg.type === "todo" ? (
            <TodoCard
              label={todoMsg.todoLabel ?? "Todo list"}
              todos={todoMsg.todos ?? []}
              meldUserAbove
              embeddedInSticky
            />
          ) : (
            <TodoStatusCard content={todoMsg.content ?? ""} meldUserAbove />
          );
        const block = (
          <div className="flex flex-col">
            {editingUserMessageId === userMsg.id && renderUserMessageEditor ? (
              renderUserMessageEditor(userMsg)
            ) : (
              <UserMessageRow
                message={userMsg}
                composerDraftId={composerDraftId}
                onRedoMessage={onRedoMessage}
              />
            )}
            {todoBlock}
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
        editingUserMessageId === userMsg.id && renderUserMessageEditor ? (
          renderUserMessageEditor(userMsg)
        ) : (
          <UserMessageRow
            message={userMsg}
            composerDraftId={composerDraftId}
            onRedoMessage={onRedoMessage}
          />
        )
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
    [
      composerDraftId,
      editingUserMessageId,
      messages,
      onRedoMessage,
      pushFor,
      registerStickyEl,
      renderUserMessageEditor,
      stickyUserHeader,
    ]
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
      const todoItems =
        seg.userKind === "user_todo" && messages[seg.todoIndex]?.type === "todo"
          ? messages[seg.todoIndex]!.todos?.length ?? 0
          : 0;
      const userTextLength =
        messages[seg.userIndex]?.type === "user" ? messages[seg.userIndex]!.content?.length ?? 0 : 0;
      // Account for streamed assistant text: without it the estimate lags far
      // behind measured heights and each remeasure jolts the scroll position.
      let assistantTextLength = 0;
      for (const tailIndex of seg.tailIndices) {
        const tailMessage = messages[tailIndex];
        if (tailMessage?.type === "assistant") {
          assistantTextLength += tailMessage.content?.length ?? 0;
        }
      }
      return Math.min(
        16000,
        220 +
          Math.ceil(userTextLength / 160) * 22 +
          todoItems * 28 +
          seg.tailIndices.length * 110 +
          Math.ceil(assistantTextLength / 140) * 22
      );
    },
    overscan: 4,
    getItemKey: (index) => `${conversationId ?? "none"}:${segments[index]?.key ?? String(index)}`,
  });

  const handledScrollAnchorRequestRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (
      !scrollAnchorRequest ||
      handledScrollAnchorRequestRef.current === scrollAnchorRequest.requestId
    ) {
      return;
    }
    const root = scrollRootRef?.current;
    if (!root) {
      return;
    }

    const applyExactAnchor = () => {
      const exactTop = scrollTopForAnchor(root, scrollAnchorRequest.anchor);
      if (exactTop == null) {
        return false;
      }
      root.scrollTop = Math.max(0, exactTop);
      notifyScrollElementLayout(root);
      return true;
    };

    if (applyExactAnchor()) {
      handledScrollAnchorRequestRef.current = scrollAnchorRequest.requestId;
      return;
    }
    if (!useVirtualList) {
      return;
    }

    const anchoredTop = scrollTopForVirtualUserTurnAnchor(
      segments,
      messages,
      scrollAnchorRequest.anchor,
      (index) => virtualizer.getOffsetForIndex(index, "start")?.[0]
    );
    if (anchoredTop == null) {
      return;
    }

    handledScrollAnchorRequestRef.current = scrollAnchorRequest.requestId;
    root.scrollTop = anchoredTop;
    notifyScrollElementLayout(root);

    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        applyExactAnchor();
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [
    messages,
    scrollAnchorRequest,
    scrollRootRef,
    segments,
    useVirtualList,
    virtualizer,
  ]);

  const handledNavigationRequestRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (
      !userMessageNavigation ||
      handledNavigationRequestRef.current === userMessageNavigation.requestId
    ) {
      return;
    }
    const root = scrollRootRef?.current;
    if (!root) {
      return;
    }
    const segmentIndex = findUserTurnSegmentIndex(
      segments,
      messages,
      userMessageNavigation.messageId
    );
    if (segmentIndex < 0) {
      return;
    }

    handledNavigationRequestRef.current = userMessageNavigation.requestId;
    const scrollToExactMessage = (behavior: ScrollBehavior) => {
      const element = findChatMessageElement(root, userMessageNavigation.messageId);
      if (!element) {
        return false;
      }
      const top =
        contentTopOfElementInScrollRoot(element, root) - getChatStickyRailInsetPx();
      root.scrollTo({ top: Math.max(0, top), behavior });
      notifyScrollElementLayout(root);
      return true;
    };

    if (scrollToExactMessage("smooth")) {
      return;
    }
    if (!useVirtualList) {
      return;
    }

    virtualizer.scrollToIndex(segmentIndex, { align: "start" });
    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        scrollToExactMessage("smooth");
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [
    messages,
    scrollRootRef,
    segments,
    useVirtualList,
    userMessageNavigation,
    virtualizer,
  ]);

  const virtualItems = useVirtualList ? virtualizer.getVirtualItems() : EMPTY_VIRTUAL_ITEMS;

  if (useVirtualList) {
    return (
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualItems.map((item) => {
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
