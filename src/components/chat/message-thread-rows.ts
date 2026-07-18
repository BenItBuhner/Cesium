import type { ChatMessage } from "@/lib/types";

/**
 * @deprecated Use {@link buildMessageThreadSegments} — flat rows break `position: sticky` for
 * user headers because the assistant lives in a sibling block; turns group user + tail together.
 */
export type MessageThreadRow =
  | {
      kind: "user_todo";
      key: string;
      userIndex: number;
      todoIndex: number;
      stackOrder: number;
    }
  | { kind: "user"; key: string; index: number; stackOrder: number }
  | { kind: "message"; key: string; index: number };

/** Message rows before the first `user` turn (rare, but may appear in some transcripts). */
export type PreambleSegment = {
  type: "preamble";
  key: string;
  messageIndices: number[];
};

/**
 * One user turn: sticky user header and every following message until the next user (exclusive).
 * `user_todo` includes the leading user + `todo-status` in the header; tail starts after both.
 */
export type UserTurnSegment =
  | {
      type: "turn";
      key: string;
      stackOrder: number;
      userKind: "user_todo";
      userIndex: number;
      todoIndex: number;
      tailIndices: number[];
    }
  | {
      type: "turn";
      key: string;
      stackOrder: number;
      userKind: "user";
      userIndex: number;
      tailIndices: number[];
    };

export type MessageThreadSegment = PreambleSegment | UserTurnSegment;

function collectTailFrom(messages: ChatMessage[], start: number): number[] {
  const tail: number[] = [];
  for (let j = start; j < messages.length; j += 1) {
    if (messages[j]!.type === "user") {
      break;
    }
    tail.push(j);
  }
  return tail;
}

/**
 * Splits the transcript into a preamble (non-`user` before the first user) and user turns. Each
 * turn wraps the user header + following assistant/tools so `position: sticky` can stay pinned
 * for the full reply.
 */
export function buildMessageThreadSegments(messages: ChatMessage[]): MessageThreadSegment[] {
  const segments: MessageThreadSegment[] = [];
  let i = 0;
  const preamble: number[] = [];
  while (i < messages.length) {
    const m = messages[i];
    if (m?.type === "user") {
      break;
    }
    if (m) {
      preamble.push(i);
    }
    i += 1;
  }
  if (preamble.length > 0) {
    segments.push({ type: "preamble", key: `pre-${preamble[0]!}`, messageIndices: preamble });
  }

  let userStickyStack = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (!msg) {
      i += 1;
      continue;
    }
    if (msg.type === "user" && (messages[i + 1]?.type === "todo-status" || messages[i + 1]?.type === "todo")) {
      const todoIndex = i + 1;
      const tail = collectTailFrom(messages, i + 2);
      const userMsg = messages[i]!;
      segments.push({
        type: "turn",
        key: `turn-${userMsg.id}`,
        stackOrder: userStickyStack++,
        userKind: "user_todo",
        userIndex: i,
        todoIndex,
        tailIndices: tail,
      });
      i = i + 2 + tail.length;
      continue;
    }
    if (msg.type === "user") {
      const tail = collectTailFrom(messages, i + 1);
      segments.push({
        type: "turn",
        key: `turn-${msg.id}`,
        stackOrder: userStickyStack++,
        userKind: "user",
        userIndex: i,
        tailIndices: tail,
      });
      i = i + 1 + tail.length;
      continue;
    }
    if (segments.length > 0 && segments[segments.length - 1]!.type === "preamble") {
      (segments[segments.length - 1] as PreambleSegment).messageIndices.push(i);
    } else {
      segments.push({ type: "preamble", key: `pre-${i}`, messageIndices: [i] });
    }
    i += 1;
  }
  return segments;
}

export function findUserTurnSegmentIndex(
  segments: MessageThreadSegment[],
  messages: ChatMessage[],
  messageId: string
): number {
  return segments.findIndex((segment) => {
    if (segment.type !== "turn") {
      return false;
    }
    return messages[segment.userIndex]?.id === messageId;
  });
}
