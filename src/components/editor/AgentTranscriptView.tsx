"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef } from "react";
import { MessageThreadContent } from "@/components/chat/MessageThreadContent";
import type { ChatMessage } from "@/lib/types";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { EDITOR_CHAT_TRANSCRIPT_CONTAINER_CLASS } from "./agent-chat-layout";
import {
  useAgentConversations,
  useConversationEvents,
} from "@/components/chat/AgentConversationsContext";
import {
  extractLiveSubagentTranscriptFromMessages,
  projectAgentEventsToChatMessages,
} from "@/lib/agent-chat";

export function AgentTranscriptView({
  messages,
  sessionId,
  liveConversationId,
}: {
  messages: ChatMessage[];
  /** Retained for tab wiring and live lookup. */
  sessionId?: string;
  /** When set, replay this conversation so the tab tracks WebSocket / SSE updates. */
  liveConversationId?: string;
}) {
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const { workspaceInfo } = useWorkspace();
  const {
    conversationsById,
    answerPermissionForConversation,
  } = useAgentConversations();

  const conversation = liveConversationId ? conversationsById[liveConversationId] : undefined;
  const events = useConversationEvents(liveConversationId);
  const deferredEvents = useDeferredValue(events);
  const backendId = conversation?.config.backendId;
  const workspaceRoot = workspaceInfo?.root ?? null;

  const projectedThread = useMemo(
    () =>
      liveConversationId
        ? projectAgentEventsToChatMessages(deferredEvents, { backendId, workspaceRoot })
        : [],
    [liveConversationId, deferredEvents, backendId, workspaceRoot]
  );

  const liveSlice = useMemo(() => {
    if (!liveConversationId || !sessionId?.trim()) {
      return null;
    }
    return extractLiveSubagentTranscriptFromMessages(projectedThread, sessionId);
  }, [liveConversationId, sessionId, projectedThread]);

  const parentBusy =
    conversation?.status === "running" || conversation?.status === "awaiting_permission";

  // Stable identity so memoized permission rows don't re-render every flush.
  const handleResolvePermission = useCallback(
    (requestId: string, optionId: string) => {
      if (!liveConversationId) {
        return;
      }
      void answerPermissionForConversation(liveConversationId, requestId, optionId);
    },
    [answerPermissionForConversation, liveConversationId]
  );

  const conversationBusy =
    liveConversationId && sessionId?.trim()
      ? liveSlice != null
        ? liveSlice.subagentRunning
        : parentBusy
      : false;

  const baseTranscript = useMemo(() => {
    if (liveConversationId && sessionId?.trim() && liveSlice != null) {
      return liveSlice.transcript;
    }
    return messages;
  }, [liveConversationId, sessionId, liveSlice, messages]);

  const displayMessages = useMemo(() => {
    if (conversationBusy && baseTranscript.length === 0) {
      return [
        {
          id: `subagent-editor-working-${sessionId ?? "unknown"}`,
          type: "worked-session" as const,
          workedLabel: "Working",
          workedEntries: [],
          workedDefaultOpen: false,
          loading: true,
        },
      ];
    }
    return baseTranscript;
  }, [conversationBusy, baseTranscript, sessionId]);

  const workedScopeId =
    liveConversationId && sessionId?.trim()
      ? `${liveConversationId}::subagent::${sessionId}`
      : `subagent-editor::${sessionId ?? "local"}`;

  useEffect(() => {
    const el = scrollRootRef.current;
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [displayMessages]);

  return (
    <div
      ref={scrollRootRef}
      className="h-full min-h-0 overflow-y-auto overflow-x-hidden hide-scrollbar-y bg-[var(--bg-main)] [-webkit-overflow-scrolling:touch]"
    >
      <div className={EDITOR_CHAT_TRANSCRIPT_CONTAINER_CLASS}>
        <MessageThreadContent
          messages={displayMessages}
          stickyUserHeader={false}
          scrollRootRef={scrollRootRef}
          workspaceRoot={workspaceInfo?.root ?? null}
          conversationId={workedScopeId}
          conversationBusy={conversationBusy}
          onResolvePermission={liveConversationId ? handleResolvePermission : undefined}
        />
      </div>
    </div>
  );
}
