import { randomUUID } from "node:crypto";
import type { AgentEventInput, AgentStoredEvent } from "../types.js";
import { asRecord, asString } from "./cesium-coerce.js";

/** Why a Cesium turn stopped without settling. */
export type CesiumInterruptionCause = "shutdown" | "restart" | "runtime_lost";

export const USER_REFUSED_TOOL_CALL_RESULT =
  "The user refused this tool call. Continue in a different fashion that is either less intrusive or destructive.";

export const INTERRUPTED_TOOL_CALL_RESULT =
  "Interrupted: the agent stopped before this tool call returned, so it may or may not have taken effect. Re-verify its effects before relying on it.";

const UNANSWERED_PERMISSION_RESULT =
  "Not run: the agent was interrupted while this call waited for permission, and the request was never answered.";

const UNANSWERED_QUESTION_RESULT =
  "Not answered: the agent was interrupted while this question waited for the user, and it was never answered.";

const ALLOWED_AFTER_INTERRUPTION_RESULT =
  "Not run: the user allowed this call, but the agent was interrupted before the answer arrived. Call the tool again to run it now.";

const DISMISSED_AFTER_INTERRUPTION_RESULT =
  "Not run: the user dismissed this permission request after the agent was interrupted.";

/** The user message a Continue press sends; the chat shows "Continue". */
export const CESIUM_CONTINUE_PROMPT_TEXT = "Continue from where you left off.";

export const CESIUM_TURN_INTERRUPTED_REMINDER_REASON = "turn_interrupted" as const;

type PermissionRequestEvent = Extract<AgentStoredEvent, { kind: "permission_request" }>;
type QuestionEvent = Extract<AgentStoredEvent, { kind: "question" }>;

export type CesiumOpenToolCall = {
  toolCallId: string;
  title: string;
  toolKind?: string;
  name: string | null;
  /** A permission card or question still waiting on the user holds this call. */
  awaiting: "permission" | "question" | null;
};

export type CesiumPendingPermission = {
  request: PermissionRequestEvent;
  toolKey: string | null;
  toolLabel: string | null;
  permissionCategory: string | null;
};

export type CesiumPendingQuestion = {
  question: QuestionEvent;
  /** The open `ask_question` call this question belongs to. */
  toolCallId: string | null;
};

/** What the newest turn left behind: tool calls and messages that never settled. */
export type CesiumTurnTail = {
  openToolCalls: CesiumOpenToolCall[];
  danglingAssistantMessageIds: string[];
  pendingPermissions: CesiumPendingPermission[];
  pendingQuestions: CesiumPendingQuestion[];
  /** Tool keys the user allowed once after the interruption; the next turn may run them without asking again. */
  grantedToolKeys: string[];
};

function toolNameOf(event: Extract<AgentStoredEvent, { kind: "tool_call" }>): string | null {
  const raw = asRecord(event.raw);
  const request = asRecord(raw?.request) ?? raw;
  return asString(request?.name) ?? null;
}

/** Events after the newest user message: the turn that is (or was) running. */
function latestTurnEvents(events: AgentStoredEvent[]): AgentStoredEvent[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let start = 0;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    if (sorted[index]!.kind === "user_message") {
      start = index + 1;
      break;
    }
  }
  return sorted.slice(start);
}

function flushesToolBatch(event: AgentStoredEvent): boolean {
  switch (event.kind) {
    case "user_message":
    case "assistant_message_end":
    case "compression_summary":
    case "agent_handoff":
    case "chat_fork":
      return true;
    case "system_reminder":
      return event.placement === "inline" && event.text.trim().length > 0;
    default:
      return false;
  }
}

export function analyzeCesiumTurnTail(events: AgentStoredEvent[]): CesiumTurnTail {
  const tail = latestTurnEvents(events);
  const open = new Map<string, CesiumOpenToolCall>();
  // Mirrors `normalizeEventsToHistory`: streamed text is claimed by the next
  // tool batch, and whatever no message end closed is left dangling.
  const assistantText = new Map<string, string>();
  let batchSize = 0;
  const requests = new Map<string, PermissionRequestEvent>();
  const resolvedRequests = new Map<string, Extract<AgentStoredEvent, { kind: "permission_resolved" }>>();
  const questions = new Map<string, { latest: QuestionEvent; toolCallId: string | null }>();
  let lastOpenToolCallId: string | null = null;
  for (const event of tail) {
    if (flushesToolBatch(event)) {
      batchSize = 0;
    }
    switch (event.kind) {
      case "assistant_message_chunk":
        assistantText.set(event.messageId, `${assistantText.get(event.messageId) ?? ""}${event.text}`);
        break;
      case "assistant_message_end":
        assistantText.delete(event.messageId);
        break;
      case "tool_call":
        if (batchSize === 0) {
          assistantText.clear();
        }
        batchSize += 1;
        open.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          title: event.title,
          toolKind: event.toolKind,
          name: toolNameOf(event),
          awaiting: null,
        });
        lastOpenToolCallId = event.toolCallId;
        break;
      case "tool_call_update":
        // A "cancelled" update carries no result for the rebuild, so the call stays open.
        if (event.status === "completed" || event.status === "failed") {
          if (!open.delete(event.toolCallId)) {
            batchSize += 1;
          }
        }
        break;
      case "permission_request":
        requests.set(event.requestId, event);
        break;
      case "permission_resolved":
        resolvedRequests.set(event.requestId, event);
        break;
      case "question": {
        const existing = questions.get(event.questionId);
        questions.set(event.questionId, {
          latest: event,
          toolCallId:
            existing?.toolCallId ??
            (lastOpenToolCallId && open.get(lastOpenToolCallId)?.name === "ask_question"
              ? lastOpenToolCallId
              : null),
        });
        break;
      }
      default:
        break;
    }
  }

  const pendingPermissions: CesiumPendingPermission[] = [];
  const grantedToolKeys: string[] = [];
  for (const request of requests.values()) {
    const raw = asRecord(request.raw);
    const permission: CesiumPendingPermission = {
      request,
      toolKey: asString(raw?.toolKey) ?? null,
      toolLabel: asString(raw?.toolLabel) ?? null,
      permissionCategory: asString(raw?.permissionCategory) ?? null,
    };
    const resolved = resolvedRequests.get(request.requestId);
    if (!resolved) {
      if (!request.toolCallId || open.has(request.toolCallId)) {
        pendingPermissions.push(permission);
        if (request.toolCallId) {
          open.get(request.toolCallId)!.awaiting = "permission";
        }
      }
      continue;
    }
    const resolvedRaw = asRecord(resolved.raw);
    if (
      resolvedRaw?.afterInterruption === true &&
      resolved.outcome === "selected" &&
      resolved.optionId === "allow_once" &&
      permission.toolKey
    ) {
      grantedToolKeys.push(permission.toolKey);
    }
  }
  const pendingQuestions: CesiumPendingQuestion[] = [];
  for (const { latest, toolCallId } of questions.values()) {
    if (latest.status !== "pending" || (toolCallId && !open.has(toolCallId))) {
      continue;
    }
    pendingQuestions.push({ question: latest, toolCallId });
    if (toolCallId) {
      open.get(toolCallId)!.awaiting = "question";
    }
  }

  return {
    openToolCalls: [...open.values()],
    danglingAssistantMessageIds: [...assistantText.entries()]
      .filter(([, text]) => text.trim().length > 0)
      .map(([messageId]) => messageId),
    pendingPermissions,
    pendingQuestions,
    grantedToolKeys,
  };
}

function questionUpdate(
  conversationId: string,
  question: QuestionEvent,
  patch: { status: "answered" | "cancelled"; answer?: string }
): AgentEventInput {
  return {
    eventId: randomUUID(),
    conversationId,
    kind: "question",
    questionId: question.questionId,
    prompt: question.prompt,
    options: question.options,
    questions: question.questions,
    allowMultiple: question.allowMultiple,
    ...patch,
    raw: question.raw,
  };
}

function failedToolUpdate(
  conversationId: string,
  call: CesiumOpenToolCall,
  detail: string,
  raw: Record<string, unknown>
): AgentEventInput {
  return {
    eventId: randomUUID(),
    conversationId,
    kind: "tool_call_update",
    toolCallId: call.toolCallId,
    title: call.title,
    toolKind: call.toolKind,
    status: "failed",
    detail,
    raw,
  };
}

/**
 * Closes what an interrupted turn left open, in the order the model would
 * have seen it: running tool calls get a "re-verify" result and half-streamed
 * assistant text gets its message end, so the next rebuild keeps both at
 * their position instead of moving the text to the tail. Calls parked on a
 * permission card or question stay open so the user can still answer them.
 */
export function cesiumInterruptionRepairEvents(
  conversationId: string,
  tail: CesiumTurnTail,
  cause: CesiumInterruptionCause
): AgentEventInput[] {
  return [
    ...tail.openToolCalls
      .filter((call) => call.awaiting === null)
      .map((call) =>
        failedToolUpdate(conversationId, call, INTERRUPTED_TOOL_CALL_RESULT, {
          interrupted: { cause },
        })
      ),
    ...tail.danglingAssistantMessageIds.map(
      (messageId): AgentEventInput => ({
        eventId: randomUUID(),
        conversationId,
        kind: "assistant_message_end",
        messageId,
        stopReason: "interrupted",
      })
    ),
  ];
}

/**
 * Everything that must be settled before the turn after an interruption
 * starts: leftover repairs plus the permission cards and questions nobody
 * answered, which close as "not answered" so the model does not wait on them.
 */
export function cesiumSettleInterruptedTurnEvents(
  conversationId: string,
  tail: CesiumTurnTail,
  cause: CesiumInterruptionCause
): AgentEventInput[] {
  const events = cesiumInterruptionRepairEvents(conversationId, tail, cause);
  const byId = new Map(tail.openToolCalls.map((call) => [call.toolCallId, call]));
  for (const pending of tail.pendingPermissions) {
    events.push({
      eventId: randomUUID(),
      conversationId,
      kind: "permission_resolved",
      requestId: pending.request.requestId,
      outcome: "cancelled",
      raw: { afterInterruption: true, unanswered: true },
    });
    const call = pending.request.toolCallId ? byId.get(pending.request.toolCallId) : undefined;
    if (call) {
      events.push(
        failedToolUpdate(conversationId, call, UNANSWERED_PERMISSION_RESULT, {
          interrupted: { cause, unanswered: "permission" },
        })
      );
    }
  }
  for (const pending of tail.pendingQuestions) {
    events.push(questionUpdate(conversationId, pending.question, { status: "cancelled" }));
    const call = pending.toolCallId ? byId.get(pending.toolCallId) : undefined;
    if (call) {
      events.push(
        failedToolUpdate(conversationId, call, UNANSWERED_QUESTION_RESULT, {
          interrupted: { cause, unanswered: "question" },
        })
      );
    }
  }
  return events;
}

/** Tool result recorded when the user answers a permission card after its turn was interrupted. */
export function cesiumPermissionAnswerAfterInterruptionEvents(input: {
  conversationId: string;
  tail: CesiumTurnTail;
  pending: CesiumPendingPermission;
  optionId?: string;
  cancelled?: boolean;
  decision: "allow" | "reject";
}): AgentEventInput[] {
  const { conversationId, pending } = input;
  const events: AgentEventInput[] = [
    {
      eventId: randomUUID(),
      conversationId,
      kind: "permission_resolved",
      requestId: pending.request.requestId,
      outcome: input.cancelled ? "cancelled" : "selected",
      ...(input.cancelled ? {} : { optionId: input.optionId }),
      raw: { afterInterruption: true },
    },
  ];
  const call = input.tail.openToolCalls.find(
    (candidate) => candidate.toolCallId === pending.request.toolCallId
  );
  if (!call) {
    return events;
  }
  if (input.cancelled) {
    events.push(
      failedToolUpdate(conversationId, call, DISMISSED_AFTER_INTERRUPTION_RESULT, {
        answeredAfterInterruption: { outcome: "dismissed" },
      })
    );
  } else if (input.decision === "allow") {
    events.push(
      failedToolUpdate(conversationId, call, ALLOWED_AFTER_INTERRUPTION_RESULT, {
        answeredAfterInterruption: { outcome: "allowed", optionId: input.optionId },
      })
    );
  } else {
    events.push({
      eventId: randomUUID(),
      conversationId,
      kind: "tool_call_update",
      toolCallId: call.toolCallId,
      title: call.title,
      toolKind: call.toolKind,
      status: "completed",
      detail: USER_REFUSED_TOOL_CALL_RESULT,
      raw: { permissionRefused: true, answeredAfterInterruption: { outcome: "refused" } },
    });
  }
  return events;
}

/** The answer to a question whose turn was interrupted, recorded as the `ask_question` result the model would have received. */
export function cesiumQuestionAnswerAfterInterruptionEvents(input: {
  conversationId: string;
  tail: CesiumTurnTail;
  pending: CesiumPendingQuestion;
  answer: string;
}): AgentEventInput[] {
  const { conversationId, pending } = input;
  const events: AgentEventInput[] = [
    questionUpdate(conversationId, pending.question, { status: "answered", answer: input.answer }),
  ];
  const call = input.tail.openToolCalls.find(
    (candidate) => candidate.toolCallId === pending.toolCallId
  );
  if (call) {
    events.push({
      eventId: randomUUID(),
      conversationId,
      kind: "tool_call_update",
      toolCallId: call.toolCallId,
      title: call.title,
      toolKind: call.toolKind,
      status: "completed",
      detail: `User answer:\n${input.answer}`,
      raw: { answeredAfterInterruption: true },
    });
  }
  return events;
}

const CAUSE_PHRASES: Record<CesiumInterruptionCause, string> = {
  shutdown: "the Cesium server shut down",
  restart: "the Cesium server restarted",
  runtime_lost: "the agent runtime stopped",
};

export function interruptionCauseFromRaw(raw: unknown): CesiumInterruptionCause | null {
  const cause = asString(asRecord(asRecord(raw)?.interruption)?.cause);
  return cause === "shutdown" || cause === "restart" || cause === "runtime_lost" ? cause : null;
}

/** Newest interruption cause recorded on the log, when the conversation's latest status is an interruption. */
export function latestInterruptionCause(events: AgentStoredEvent[]): CesiumInterruptionCause {
  const sorted = [...events].sort((a, b) => b.seq - a.seq);
  for (const event of sorted) {
    if (event.kind === "status" && event.status === "interrupted") {
      const cause = interruptionCauseFromRaw(event.raw);
      if (cause) {
        return cause;
      }
    }
  }
  return "restart";
}

/** The notice the turn after an interruption carries, persisted on its user message. */
export function cesiumTurnInterruptedNotice(cause: CesiumInterruptionCause): string {
  return [
    "<system-reminder>",
    `Your previous turn was interrupted before it finished: ${CAUSE_PHRASES[cause]}.`,
    "The tool results above are what actually happened; do not redo completed work.",
    'A result starting with "Interrupted:" may or may not have taken effect, so re-verify it before relying on it.',
    "</system-reminder>",
  ].join("\n");
}
