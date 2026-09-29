import { randomUUID } from "node:crypto";
import {
  appendConversationEvents,
  readConversationEvents,
  updateConversationRecord,
} from "./session-store.js";
import {
  analyzeCesiumTurnTail,
  cesiumInterruptionRepairEvents,
  type CesiumInterruptionCause,
} from "./cesium/cesium-turn-recovery.js";
import type { AgentConversationStatus } from "./types.js";

/**
 * A permission or question answer reached no running turn: the runtime that
 * asked is gone, or the request was already settled.
 */
export class AgentRequestNotLiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRequestNotLiveError";
  }
}

/** Cesium rebuilds every turn from the log, so its interrupted turns can be continued in place. */
export function continuesInterruptedTurns(backendId: string): boolean {
  return backendId === "cesium-agent";
}

export function interruptionStatusDetail(reason: string, backendId: string): string {
  return continuesInterruptedTurns(backendId)
    ? `${reason} Press Continue to pick up where it left off, or send a new message.`
    : `${reason} The run was marked as interrupted; send a new message to continue.`;
}

/**
 * Flips a conversation whose turn can no longer finish to "interrupted",
 * guarded inside the per-conversation write queue: a status that raced out of
 * `eligibleStatuses` is left alone. For Cesium the log is repaired first so
 * the next rebuild keeps the interrupted work where the model saw it. The
 * provider session id is kept, so the next runtime reloads the same session.
 *
 * Returns true when the conversation was actually interrupted.
 */
export async function markTurnInterrupted(
  workspaceId: string,
  conversationId: string,
  input: {
    reason: string;
    cause: CesiumInterruptionCause;
    eligibleStatuses: ReadonlySet<AgentConversationStatus>;
  }
): Promise<boolean> {
  const flipped: { backendId?: string } = {};
  await updateConversationRecord(workspaceId, conversationId, (current) => {
    if (!input.eligibleStatuses.has(current.status)) {
      return current;
    }
    flipped.backendId = current.config.backendId;
    return {
      ...current,
      status: "interrupted",
      pendingPermission: null,
      pendingQuestion: null,
    };
  });
  const backendId = flipped.backendId;
  if (backendId === undefined) {
    return false;
  }
  const repairs = continuesInterruptedTurns(backendId)
    ? cesiumInterruptionRepairEvents(
        conversationId,
        analyzeCesiumTurnTail(await readConversationEvents(workspaceId, conversationId)),
        input.cause
      )
    : [];
  await appendConversationEvents(workspaceId, conversationId, [
    ...repairs,
    {
      eventId: randomUUID(),
      conversationId,
      kind: "status",
      status: "interrupted",
      detail: interruptionStatusDetail(input.reason, backendId),
      raw: { interruption: { cause: input.cause } },
    },
  ]);
  return true;
}
