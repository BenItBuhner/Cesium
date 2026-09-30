"use client";

import { useEffect, useRef } from "react";
import type { AgentStoredEvent } from "@/lib/agent-types";
import { listOrchestrationBoards } from "@/lib/server-api";
import { useEditorBridgeRefMaybe } from "@/components/ide/EditorBridgeContext";

/** Conversations whose board this window already opened on its own. */
const autoOpenedConversationIds = new Set<string>();

function isOrchestrationToolResult(event: AgentStoredEvent): boolean {
  if (event.kind !== "tool_call_update" || event.status !== "completed") {
    return false;
  }
  const raw = event.raw as { request?: { name?: unknown } } | undefined;
  const name = typeof raw?.request?.name === "string" ? raw.request.name : "";
  return name.startsWith("orchestration_");
}

/**
 * Opens the conversation's orchestration board the first time an
 * orchestration tool finishes while the chat is open. Events already in the
 * log when the conversation was opened never trigger it.
 */
export function useOrchestrationBoardAutoOpen(input: {
  conversationId: string | null | undefined;
  events: readonly AgentStoredEvent[] | undefined;
  openRightPane: () => void;
}): void {
  const { conversationId, events, openRightPane } = input;
  const bridgeRef = useEditorBridgeRefMaybe();
  const baselineRef = useRef<{ conversationId: string; seq: number } | null>(null);

  useEffect(() => {
    if (!conversationId || !events) {
      return;
    }
    const latestSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);
    if (baselineRef.current?.conversationId !== conversationId) {
      baselineRef.current = { conversationId, seq: latestSeq };
      return;
    }
    if (autoOpenedConversationIds.has(conversationId)) {
      return;
    }
    const baseline = baselineRef.current.seq;
    const result = events.find((event) => event.seq > baseline && isOrchestrationToolResult(event));
    if (!result) {
      return;
    }
    // One lookup per new orchestration result, whatever it finds.
    baselineRef.current = { conversationId, seq: latestSeq };
    void listOrchestrationBoards()
      .then(({ boards }) => {
        const board = boards.find(
          (candidate) => candidate.headConversationId === conversationId && !candidate.archivedAt
        );
        const bridge = bridgeRef?.current;
        if (!board || !bridge || autoOpenedConversationIds.has(conversationId)) {
          return;
        }
        autoOpenedConversationIds.add(conversationId);
        bridge.openOrchestrationBoardTab(board.id, board.title);
        openRightPane();
      })
      .catch(() => undefined);
  }, [bridgeRef, conversationId, events, openRightPane]);
}
