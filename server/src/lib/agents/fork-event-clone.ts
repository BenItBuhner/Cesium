import { randomUUID } from "node:crypto";
import type { AgentEventInput, AgentStoredEvent } from "./types.js";

const SKIP_KINDS = new Set<AgentStoredEvent["kind"]>(["status", "chat_fork"]);

/**
 * Deep-clone events from a source conversation into a forked conversation with fresh
 * ids so the forked thread can render the same UI as the source. `user_message` rows
 * get `inheritedInFork: true` so `resolvePendingForkContext` still treats the first
 * new post-fork prompt as needing fork seed text.
 */
export function remapSourceEventsForFork(
  sourceEvents: AgentStoredEvent[],
  newConversationId: string
): AgentEventInput[] {
  const byMessageId = new Map<string, string>();
  const byToolCallId = new Map<string, string>();
  const byRequestId = new Map<string, string>();
  const byPlanId = new Map<string, string>();

  const mapMessageId = (id: string): string => {
    let next = byMessageId.get(id);
    if (!next) {
      next = randomUUID();
      byMessageId.set(id, next);
    }
    return next;
  };
  const mapToolCallId = (id: string): string => {
    let next = byToolCallId.get(id);
    if (!next) {
      next = randomUUID();
      byToolCallId.set(id, next);
    }
    return next;
  };
  const mapRequestId = (id: string): string => {
    let next = byRequestId.get(id);
    if (!next) {
      next = randomUUID();
      byRequestId.set(id, next);
    }
    return next;
  };
  const mapPlanId = (id: string): string => {
    let next = byPlanId.get(id);
    if (!next) {
      next = randomUUID();
      byPlanId.set(id, next);
    }
    return next;
  };

  const sorted = [...sourceEvents].sort((a, b) => a.seq - b.seq);
  const out: AgentEventInput[] = [];

  for (const e of sorted) {
    if (SKIP_KINDS.has(e.kind)) {
      continue;
    }
    switch (e.kind) {
      case "user_message":
        out.push({
          eventId: randomUUID(),
          conversationId: newConversationId,
          kind: "user_message",
          messageId: mapMessageId(e.messageId),
          content: e.content,
          displayContent: e.displayContent,
          attachments: e.attachments,
          raw: e.raw,
          inheritedInFork: true,
        });
        break;
      case "assistant_message_chunk":
        out.push({
          eventId: randomUUID(),
          conversationId: newConversationId,
          kind: "assistant_message_chunk",
          messageId: mapMessageId(e.messageId),
          text: e.text,
          raw: e.raw,
        });
        break;
      case "assistant_message_end":
        out.push({
          eventId: randomUUID(),
          conversationId: newConversationId,
          kind: "assistant_message_end",
          messageId: mapMessageId(e.messageId),
          stopReason: e.stopReason,
          raw: e.raw,
        });
        break;
      case "reasoning":
        out.push({
          eventId: randomUUID(),
          conversationId: newConversationId,
          kind: "reasoning",
          messageId: mapMessageId(e.messageId),
          text: e.text,
          raw: e.raw,
        });
        break;
      case "tool_call":
        out.push({
          eventId: randomUUID(),
          conversationId: newConversationId,
          kind: "tool_call",
          toolCallId: mapToolCallId(e.toolCallId),
          title: e.title,
          toolKind: e.toolKind,
          status: e.status,
          detail: e.detail,
          locations: e.locations,
          editPreview: e.editPreview,
          raw: e.raw,
        });
        break;
      case "tool_call_update":
        out.push({
          eventId: randomUUID(),
          conversationId: newConversationId,
          kind: "tool_call_update",
          toolCallId: mapToolCallId(e.toolCallId),
          title: e.title,
          toolKind: e.toolKind,
          status: e.status,
          detail: e.detail,
          locations: e.locations,
          editPreview: e.editPreview,
          raw: e.raw,
        });
        break;
      case "plan": {
        const newPlanId = mapPlanId(e.planId);
        out.push({
          eventId: randomUUID(),
          conversationId: newConversationId,
          kind: "plan",
          planId: newPlanId,
          entries: e.entries.map((entry) => ({
            ...entry,
            id: `${newPlanId}-${entry.id}`,
          })),
          raw: e.raw,
        });
        break;
      }
      case "permission_request": {
        const newRequestId = mapRequestId(e.requestId);
        out.push({
          eventId: randomUUID(),
          conversationId: newConversationId,
          kind: "permission_request",
          requestId: newRequestId,
          title: e.title,
          detail: e.detail,
          toolCallId: e.toolCallId ? mapToolCallId(e.toolCallId) : undefined,
          options: e.options,
          raw: e.raw,
        });
        break;
      }
      case "permission_resolved":
        out.push({
          eventId: randomUUID(),
          conversationId: newConversationId,
          kind: "permission_resolved",
          requestId: mapRequestId(e.requestId),
          outcome: e.outcome,
          optionId: e.optionId,
          raw: e.raw,
        });
        break;
      case "system":
        out.push({
          eventId: randomUUID(),
          conversationId: newConversationId,
          kind: "system",
          level: e.level,
          text: e.text,
          raw: e.raw,
        });
        break;
      case "agent_handoff":
        out.push({
          eventId: randomUUID(),
          conversationId: newConversationId,
          kind: "agent_handoff",
          fromAgent: e.fromAgent,
          toAgent: e.toAgent,
          handoffMessageId: e.handoffMessageId
            ? mapMessageId(e.handoffMessageId)
            : undefined,
          turnCount: e.turnCount,
          toolCallCount: e.toolCallCount,
          raw: e.raw,
        });
        break;
    }
  }

  return out;
}
