"use client";

import { useCallback, useRef, type RefObject } from "react";
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

export interface MessageThreadContentProps {
  messages: ChatMessage[];
  /**
   * Main chat: every user turn is sticky; newer turns stack above and push older ones off.
   * Transcript tab: off.
   */
  stickyUserHeader?: boolean;
  /** Scrollport for progressive “push previous user up” math (main chat only). */
  scrollRootRef?: RefObject<HTMLElement | null>;
  /** When a subagent row has `subagentTranscript`, clicking opens this. */
  onOpenSubagent?: (title: string, transcript: ChatMessage[]) => void;
  onResolvePermission?: (requestId: string, optionId: string) => void;
}

export function MessageThreadContent({
  messages,
  stickyUserHeader = false,
  scrollRootRef,
  onOpenSubagent,
  onResolvePermission,
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
              meta={msg.subagentMeta!}
              complete={msg.subagentComplete !== false}
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
            meta={msg.subagentMeta!}
            complete={msg.subagentComplete !== false}
            interactive
            onOpen={() =>
              onOpenSubagent(msg.subagentTitle!, transcript)
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
      case "worked-session":
        nodes.push(
          <WorkedSessionCard
            key={msg.id}
            label={msg.workedLabel!}
            entries={msg.workedEntries!}
            defaultOpen={msg.workedDefaultOpen}
          />
        );
        break;
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
