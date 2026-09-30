import { createHash } from "node:crypto";
import { asRecord, asString } from "./cesium/cesium-coerce.js";
import { goalContinuationContext } from "./goal-steering.js";
import { goalHasRunnableWork, type GoalRecord } from "./goal-types.js";
import type { AgentConversationRecord, AgentStoredEvent } from "./types.js";

/** Continuation turns in a row without the user writing. */
export const GOAL_AUTO_CONTINUE_MAX = 8;
/** Continuations in a row that left the Goal, the tools used and the files unchanged. */
export const GOAL_NO_PROGRESS_LIMIT = 2;
/** `goal_complete` rejections by the verifier before it lets the Goal close with the findings listed. */
export const GOAL_VERIFIER_MAX_REJECTIONS = 2;

export type GoalContinuationState = {
  /** Continuations since the user last wrote. */
  count: number;
  /** User message each decision was made for, so a turn is continued at most once. */
  handledUserMessageId: string | null;
  lastProgressHash: string | null;
  noProgressStreak: number;
};

export function freshGoalContinuationState(): GoalContinuationState {
  return { count: 0, handledUserMessageId: null, lastProgressHash: null, noProgressStreak: 0 };
}

export type GoalContinuationDecision =
  | { kind: "continue"; text: string; displayContent: string; progressHash: string }
  | { kind: "stop"; notice?: string; budgetLimited?: boolean };

function toolNameOf(event: Extract<AgentStoredEvent, { kind: "tool_call" }>): string {
  const raw = asRecord(event.raw);
  return asString(asRecord(raw?.request)?.name) ?? asString(raw?.name) ?? event.title;
}

/** Events of the newest turn: everything after its opening user message. */
function latestTurn(events: AgentStoredEvent[]): {
  userMessageId: string | null;
  events: AgentStoredEvent[];
} {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let start = -1;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    if (sorted[index]!.kind === "user_message") {
      start = index;
      break;
    }
  }
  const opener = start >= 0 ? sorted[start] : undefined;
  return {
    userMessageId: opener?.kind === "user_message" ? opener.messageId : null,
    events: start >= 0 ? sorted.slice(start + 1) : sorted,
  };
}

/**
 * What changed in a turn: the Goal's items, snapshots and evidence, plus the
 * tool calls it made (name and arguments). Two continuations with the same
 * hash made no progress.
 */
export function goalProgressHash(goal: GoalRecord, turnEvents: AgentStoredEvent[]): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(goal.milestones.map((item) => [item.id, item.status, item.evidence ?? ""])));
  hash.update(JSON.stringify(goal.todos.map((item) => [item.id, item.status, item.evidence ?? ""])));
  hash.update(JSON.stringify(goal.verificationEvidence.map((item) => [item.requirement, item.status])));
  hash.update(String(goal.snapshots.length));
  for (const event of turnEvents) {
    if (event.kind === "tool_call") {
      hash.update(`${toolNameOf(event)}:${event.detail ?? ""}`);
    }
  }
  return hash.digest("hex");
}

/**
 * Whether a Goal conversation whose turn just ended should keep going on its
 * own, and with what prompt. Stops when the Goal is not runnable, its token
 * budget is spent, it has continued too many times without the user, or two
 * continuations in a row changed nothing.
 */
export function decideGoalContinuation(input: {
  record: Pick<AgentConversationRecord, "status" | "queuedPrompts" | "origin">;
  goal: GoalRecord | null;
  events: AgentStoredEvent[];
  state: GoalContinuationState;
}): GoalContinuationDecision {
  const { record, goal, state } = input;
  if (record.status !== "idle" || (record.queuedPrompts?.length ?? 0) > 0) {
    return { kind: "stop" };
  }
  if (record.origin?.kind?.startsWith("project")) {
    return { kind: "stop" };
  }
  const turn = latestTurn(input.events);
  if (!turn.userMessageId || turn.userMessageId === state.handledUserMessageId) {
    return { kind: "stop" };
  }
  const ended = turn.events.some(
    (event) => event.kind === "assistant_message_end" && event.stopReason === "end_turn"
  );
  if (!ended || !goal || !goalHasRunnableWork(goal)) {
    return { kind: "stop" };
  }
  if (goal.tokenBudget != null && goal.tokensUsed >= goal.tokenBudget) {
    return {
      kind: "stop",
      budgetLimited: true,
      notice: `The Goal used its token budget (${goal.tokensUsed.toLocaleString("en-US")} of ${goal.tokenBudget.toLocaleString("en-US")} tokens), so it stopped as budget_limited. Raise the budget with goal_set to continue.`,
    };
  }
  if (state.count >= GOAL_AUTO_CONTINUE_MAX) {
    return {
      kind: "stop",
      notice: `The Goal continued on its own ${GOAL_AUTO_CONTINUE_MAX} times in a row, so it is waiting for you before going further.`,
    };
  }
  const progressHash = goalProgressHash(goal, turn.events);
  const stalled = state.lastProgressHash === progressHash ? state.noProgressStreak + 1 : 0;
  if (stalled >= GOAL_NO_PROGRESS_LIMIT) {
    return {
      kind: "stop",
      notice: `The Goal made no progress in ${GOAL_NO_PROGRESS_LIMIT + 1} turns in a row, so it stopped continuing on its own.`,
    };
  }
  return {
    kind: "continue",
    progressHash,
    text: [
      goalContinuationContext(goal),
      "",
      "The previous turn ended with Goal work remaining. Take the next concrete step.",
    ].join("\n"),
    displayContent: `Continuing the Goal (${state.count + 1}/${GOAL_AUTO_CONTINUE_MAX})`,
  };
}

/** The state after acting on a decision for the newest user message. */
export function advanceGoalContinuationState(
  state: GoalContinuationState,
  userMessageId: string,
  decision: GoalContinuationDecision
): GoalContinuationState {
  if (decision.kind !== "continue") {
    return { ...state, handledUserMessageId: userMessageId };
  }
  return {
    count: state.count + 1,
    handledUserMessageId: userMessageId,
    noProgressStreak: state.lastProgressHash === decision.progressHash ? state.noProgressStreak + 1 : 0,
    lastProgressHash: decision.progressHash,
  };
}

export function latestUserMessageId(events: AgentStoredEvent[]): string | null {
  return latestTurn(events).userMessageId;
}

const EDIT_TOOLS = new Set(["edit_file", "write_file"]);
const COMMAND_TOOLS = new Set(["terminal"]);

/**
 * Scripted checks before a Goal may close: something ran after the last file
 * edit (tests, a build, the program), and at least one requirement is
 * recorded as passed. Returns the unmet checks.
 */
export function verifyGoalCompletion(goal: GoalRecord, events: AgentStoredEvent[]): string[] {
  const names = new Map<string, string>();
  let lastEdit = -1;
  let lastCommand = -1;
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.createdAt < goal.createdAt) {
      continue;
    }
    if (event.kind === "tool_call") {
      names.set(event.toolCallId, toolNameOf(event));
      continue;
    }
    if (event.kind !== "tool_call_update" || event.status !== "completed") {
      continue;
    }
    const name = names.get(event.toolCallId) ?? asString(asRecord(asRecord(event.raw)?.request)?.name) ?? "";
    if (EDIT_TOOLS.has(name)) lastEdit = event.seq;
    if (COMMAND_TOOLS.has(name)) lastCommand = event.seq;
  }
  const findings: string[] = [];
  if (lastEdit > lastCommand) {
    findings.push(
      "Files were edited after the last command ran: run the tests, build or program that proves the change works."
    );
  }
  if (!goal.verificationEvidence.some((item) => item.status === "passed")) {
    findings.push(
      "No requirement is recorded as passed: add each requirement with its evidence and status passed through goal_set verificationEvidence."
    );
  }
  return findings;
}
