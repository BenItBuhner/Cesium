import type { AgentConversationRecord } from "@/lib/agent-types";
import type { WorkspaceSessionState } from "@/lib/workspace-session";
import { isAgentConversationTabVisible } from "@/lib/chat-unread-completion";

export type AcknowledgedFailureByConversationId = Record<string, true>;

function failureSignature(
  conversation: Pick<AgentConversationRecord, "status" | "updatedAt" | "lastError">
): string | null {
  if (conversation.status !== "failed") {
    return null;
  }
  return `${conversation.updatedAt}:${conversation.lastError ?? ""}`;
}

/**
 * Failed runs stay in Needs attention until the user actually sees them.
 * A new failure (status flip or a later error at a new `updatedAt`) clears the ack.
 */
export function nextAcknowledgedFailureMap(
  session: WorkspaceSessionState,
  previous: AgentConversationRecord | undefined,
  merged: AgentConversationRecord
): AcknowledgedFailureByConversationId | null {
  const id = merged.id;
  const before = session.chat.acknowledgedFailureByConversationId ?? {};
  const next = { ...before } as AcknowledgedFailureByConversationId;
  let dirty = false;

  const nextSig = failureSignature(merged);
  if (nextSig == null) {
    if (next[id]) {
      delete next[id];
      dirty = true;
    }
    return dirty ? next : null;
  }

  const prevSig = previous ? failureSignature(previous) : null;
  const isNewFailure = prevSig !== nextSig;
  const visible = isAgentConversationTabVisible(session, id);

  if (isNewFailure) {
    if (visible) {
      if (!next[id]) {
        next[id] = true;
        dirty = true;
      }
    } else if (next[id]) {
      delete next[id];
      dirty = true;
    }
  } else if (visible && !next[id]) {
    next[id] = true;
    dirty = true;
  }

  return dirty ? next : null;
}
