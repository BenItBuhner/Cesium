"use client";

import { useCallback, useMemo, useRef, type RefObject } from "react";
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
}: MessageThreadContentProps) {
  const stickyElMapRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const registerStickyEl = useCallback((order: number, el: HTMLDivElement | null) => {
    const m = stickyElMapRef.current;
    if (el) m.set(order, el);
    else m.delete(order);
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

  const nodes: React.ReactNode[] = [];
  let userStickyStack = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const next = messages[i + 1];

    if (msg.type === "user" && next?.type === "todo-status") {
      const stackOrder = userStickyStack++;
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
      nodes.push(
        <StickyChatHeader
          key={`${msg.id}-${next.id}`}
          enabled={!!stickyUserHeader}
          stackOrder={stackOrder}
          pushUpPx={pushFor(stackOrder)}
          registerStickyEl={registerStickyEl}
        >
          {block}
        </StickyChatHeader>
      );
      i++;
      continue;
    }

    switch (msg.type) {
      case "user": {
        const stackOrder = userStickyStack++;
        const inner = (
          <UserMessage
            content={msg.content}
            segments={msg.segments}
            attachments={msg.attachments}
            showReplyCue={msg.showReplyCue}
          />
        );
        nodes.push(
          <StickyChatHeader
            key={msg.id}
            enabled={!!stickyUserHeader}
            stackOrder={stackOrder}
            pushUpPx={pushFor(stackOrder)}
            registerStickyEl={registerStickyEl}
          >
            {inner}
          </StickyChatHeader>
        );
        break;
      }
      case "assistant":
        nodes.push(<AssistantMessage key={msg.id} content={msg.content!} />);
        break;
      case "todo-status":
        nodes.push(<TodoStatusCard key={msg.id} content={msg.content!} />);
        break;
      case "todo":
        nodes.push(
          <TodoCard
            key={msg.id}
            label={msg.todoLabel!}
            todos={msg.todos!}
          />
        );
        break;
      case "subagent": {
        if (!onOpenSubagent) {
          nodes.push(
            <SubagentCard
              key={msg.id}
              title={msg.subagentTitle!}
              meta={msg.subagentMeta}
              recentActivity={msg.recentActivity}
              complete={msg.subagentStatus !== "running"}
            />
          );
          break;
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
        nodes.push(
          <SubagentCard
            key={msg.id}
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
        break;
      }
      case "ask-question": {
        const steps = askStepsFromMessage(msg);
        if (steps.length) {
          nodes.push(<AskQuestionCard key={msg.id} steps={steps} />);
        }
        break;
      }
      case "permission-request":
        nodes.push(
          <PermissionRequestCard
            key={msg.id}
            title={msg.permissionTitle ?? "Permission required"}
            detail={msg.permissionDetail}
            options={msg.permissionOptions ?? []}
            resolved={msg.permissionResolved}
            selectedOptionId={msg.permissionSelectedOptionId}
            onSelect={(optionId) => {
              if (!msg.permissionRequestId) return;
              onResolvePermission?.(msg.permissionRequestId, optionId);
            }}
            onCancel={
              msg.permissionRequestId && onCancelPermission
                ? () => onCancelPermission(msg.permissionRequestId!)
                : undefined
            }
          />
        );
        break;
      case "activity-label":
        nodes.push(
          <ActivityLabel
            key={msg.id}
            label={msg.activityLabel!}
            detail={msg.activityDetail}
            files={msg.activityFiles}
            defaultOpen={msg.activityDefaultOpen}
          />
        );
        break;
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
              : isTailForExpandDefault && (msg.workedDefaultOpen !== false)
                ? true
                : false;
          onOpenChange = (v: boolean) => {
            onWorkedSessionOpenChange(scopedKey, v);
          };
        }
        nodes.push(
          <WorkedSessionCard
            key={msg.id}
            label={msg.workedLabel!}
            entries={msg.workedEntries!}
            open={openProp}
            onOpenChange={onOpenChange}
            defaultOpen={msg.workedDefaultOpen}
            loading={chainLoading}
            isLiveWorkedTail={
              i === lastWorkedSessionIndex && chainLoading
            }
            surface={workedSessionSurface}
          />
        );
        break;
      }
      case "shell-run":
        nodes.push(<ShellCommandCard key={msg.id} title={msg.shellTitle!} />);
        break;
      default:
        break;
    }
  }

  return (
    <div className="flex flex-col gap-[10px] [&>*]:shrink-0">{nodes}</div>
  );
}
