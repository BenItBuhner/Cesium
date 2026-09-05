import { randomUUID } from "node:crypto";
import type { WorkspaceRecord } from "../../workspace-registry.js";
import { generateTranscriptFromEvents } from "../event-log-read.js";
import {
  appendConversationEvents,
  listWorkspaceConversationRecords,
  readConversationEvents,
  readConversationEventsSince,
  readConversationRecord,
  readRecentConversationEvents,
} from "../session-store.js";
import type {
  AgentConversationCreateInput,
  AgentConversationRecord,
  AgentEventInput,
  AgentStoredEvent,
} from "../types.js";
import {
  DEFAULT_MAX_SIDE_CHATS_PER_PARENT,
  DEFAULT_SIDE_CHAT_DELTA_MAX_CHARS,
  DEFAULT_SIDE_CHAT_SEED_MAX_CHARS,
} from "../cesium/features/limits.js";
import type { CesiumHarnessLimits } from "../cesium/features/types.js";
import {
  SIDE_CHAT_REMINDER_REASON,
  buildSideChatReminderRaw,
  formatPrimaryChatDelta,
  formatPrimaryChatSeed,
  formatPrimaryChatUnavailable,
  maxEventSeq,
  sideChatDeliveryStateFromEvents,
  type PrimaryChatDescriptor,
} from "./side-chat-context.js";

/** Placeholder title until the first prompt generates a real one. */
export const SIDE_CHAT_INITIAL_TITLE = "Side chat";
/** How many recent parent turns the seed transcript covers before char truncation. */
const SEED_TRANSCRIPT_TURNS = 40;

export type SideChatOrigin = Extract<
  NonNullable<AgentConversationRecord["origin"]>,
  { kind: "side-chat" }
>;

export type SideChatLimits = Pick<
  CesiumHarnessLimits,
  "maxSideChatsPerParent" | "sideChatSeedMaxChars" | "sideChatDeltaMaxChars"
>;

export const DEFAULT_SIDE_CHAT_LIMITS: SideChatLimits = {
  maxSideChatsPerParent: DEFAULT_MAX_SIDE_CHATS_PER_PARENT,
  sideChatSeedMaxChars: DEFAULT_SIDE_CHAT_SEED_MAX_CHARS,
  sideChatDeltaMaxChars: DEFAULT_SIDE_CHAT_DELTA_MAX_CHARS,
};

export function sideChatOriginOf(
  record: Pick<AgentConversationRecord, "origin"> | null | undefined
): SideChatOrigin | null {
  const origin = record?.origin;
  return origin && origin.kind === "side-chat" ? origin : null;
}

export function isSideChatConversation(
  record: Pick<AgentConversationRecord, "origin"> | null | undefined
): boolean {
  return sideChatOriginOf(record) !== null;
}

/**
 * A freshly created side chat carries only its seed reminder. The first user
 * prompt should still trigger title generation, exactly like a brand-new chat.
 */
export function isSideChatAwaitingFirstPrompt(
  record: Pick<AgentConversationRecord, "origin" | "title" | "lastEventSeq">
): boolean {
  return (
    isSideChatConversation(record) &&
    record.title === SIDE_CHAT_INITIAL_TITLE &&
    record.lastEventSeq <= 1
  );
}

export async function listSideChatsForParent(
  workspaceId: string,
  parentConversationId: string
): Promise<AgentConversationRecord[]> {
  const records = await listWorkspaceConversationRecords(workspaceId);
  return records
    .filter((record) => sideChatOriginOf(record)?.parentConversationId === parentConversationId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Validate a side-chat spawn request against the parent and the limits, and
 * return the creation input the runtime manager should use. Throws with a
 * user-facing message on any policy violation.
 */
export async function prepareSideChatCreation(input: {
  workspace: WorkspaceRecord;
  parent: AgentConversationRecord;
  limits?: Partial<SideChatLimits>;
  supportsSideChats: boolean;
}): Promise<{ createInput: AgentConversationCreateInput; origin: SideChatOrigin }> {
  const { parent } = input;
  if (!input.supportsSideChats) {
    throw new Error(
      `The ${parent.config.backendId} harness does not support side chats. Side chats are available for the Cesium agent.`
    );
  }
  if (isSideChatConversation(parent)) {
    throw new Error("Side chats cannot open their own side chats. Open one from the primary chat instead.");
  }
  if (parent.lastEventSeq === 0) {
    throw new Error("Send at least one message in the primary chat before opening a side chat.");
  }
  const maxSideChats = Math.max(
    1,
    Math.floor(input.limits?.maxSideChatsPerParent ?? DEFAULT_MAX_SIDE_CHATS_PER_PARENT)
  );
  const existing = (await listSideChatsForParent(input.workspace.id, parent.id)).filter(
    (record) => record.archivedAt == null
  );
  if (existing.length >= maxSideChats) {
    throw new Error(
      `This chat already has ${existing.length} open side chat(s) (limit ${maxSideChats}). Archive one before opening another.`
    );
  }
  const origin: SideChatOrigin = {
    kind: "side-chat",
    parentConversationId: parent.id,
    parentTitle: parent.title,
    createdAt: Date.now(),
  };
  return {
    origin,
    createInput: {
      backendId: parent.config.backendId,
      mode: parent.config.mode,
      modelId: parent.config.modelId,
      modelName: parent.config.modelName,
      ...(parent.config.profileId ? { profileId: parent.config.profileId } : {}),
      title: SIDE_CHAT_INITIAL_TITLE,
      origin,
    },
  };
}

/**
 * Write the hidden seed block into a freshly created side chat: the parent's
 * recent transcript at this instant, plus the cursor (`throughSeq`) every later
 * delta starts from.
 */
export async function seedSideChatFromParent(input: {
  workspace: WorkspaceRecord;
  sideChat: AgentConversationRecord;
  parent: AgentConversationRecord;
  limits?: Partial<SideChatLimits>;
}): Promise<AgentStoredEvent[]> {
  const parentEvents = await readRecentConversationEvents(
    input.workspace.id,
    input.parent.id,
    SEED_TRANSCRIPT_TURNS
  );
  const throughSeq = Math.max(input.parent.lastEventSeq, maxEventSeq(parentEvents));
  const text = formatPrimaryChatSeed({
    primary: describePrimary(input.parent),
    transcript: generateTranscriptFromEvents(parentEvents),
    throughSeq,
    maxChars: input.limits?.sideChatSeedMaxChars ?? DEFAULT_SIDE_CHAT_SEED_MAX_CHARS,
  });
  const seed: AgentEventInput = {
    eventId: randomUUID(),
    conversationId: input.sideChat.id,
    kind: "system_reminder",
    reminderId: "side-chat-seed",
    reason: SIDE_CHAT_REMINDER_REASON,
    placement: "inline",
    text,
    raw: buildSideChatReminderRaw({
      kind: "seed",
      parentConversationId: input.parent.id,
      fromSeq: 0,
      throughSeq,
    }),
  };
  return appendConversationEvents(input.workspace.id, input.sideChat.id, [seed]);
}

export function describePrimary(parent: AgentConversationRecord): PrimaryChatDescriptor {
  return { conversationId: parent.id, title: parent.title, status: parent.status };
}

export type SideChatReminderPayload = {
  text: string;
  raw: ReturnType<typeof buildSideChatReminderRaw>;
  fromSeq: number;
  throughSeq: number;
  kind: "delta" | "unavailable";
};

/** One-shot "parent is gone" payload, or `null` if it was already delivered. */
export function unavailablePayloadFor(input: {
  origin: SideChatOrigin;
  cursor: number;
  alreadyNoticed: boolean;
}): SideChatReminderPayload | null {
  if (input.alreadyNoticed) {
    return null;
  }
  const primary: PrimaryChatDescriptor = {
    conversationId: input.origin.parentConversationId,
    title: input.origin.parentTitle ?? "Primary chat",
    status: null,
  };
  return {
    kind: "unavailable",
    text: formatPrimaryChatUnavailable(primary),
    fromSeq: input.cursor,
    throughSeq: input.cursor,
    raw: buildSideChatReminderRaw({
      kind: "unavailable",
      parentConversationId: input.origin.parentConversationId,
      fromSeq: input.cursor,
      throughSeq: input.cursor,
    }),
  };
}

/** Format already-fetched parent events into a delta payload (or `null` for noise). */
export function deltaPayloadFor(input: {
  parent: AgentConversationRecord;
  parentEvents: AgentStoredEvent[];
  fromSeq: number;
  limits?: Partial<SideChatLimits>;
}): SideChatReminderPayload | null {
  const delta = formatPrimaryChatDelta({
    primary: describePrimary(input.parent),
    events: input.parentEvents,
    fromSeq: input.fromSeq,
    maxChars: input.limits?.sideChatDeltaMaxChars ?? DEFAULT_SIDE_CHAT_DELTA_MAX_CHARS,
  });
  if (!delta) {
    return null;
  }
  return {
    kind: "delta",
    text: delta.text,
    fromSeq: delta.fromSeq,
    throughSeq: delta.throughSeq,
    raw: buildSideChatReminderRaw({
      kind: "delta",
      parentConversationId: input.parent.id,
      fromSeq: delta.fromSeq,
      throughSeq: delta.throughSeq,
    }),
  };
}

export type SideChatDeltaResolution = {
  /** Block to deliver, or `null` when nothing new needs saying. */
  payload: SideChatReminderPayload | null;
  /** Cursor the side chat stands at before this resolution (from its own log). */
  cursor: number;
  /** Highest parent seq the resolution accounted for (>= cursor). */
  throughSeq: number;
  parent: AgentConversationRecord | null;
};

/**
 * Compute what the side chat should learn about its parent right now: the
 * parent events after the delivered cursor, formatted into one block. The
 * cursor is derived from the side chat's own persisted reminders, so nothing
 * else needs to be stored.
 */
export async function resolveSideChatDelta(input: {
  workspaceId: string;
  sideChat: AgentConversationRecord;
  sideChatEvents?: AgentStoredEvent[];
  limits?: Partial<SideChatLimits>;
}): Promise<SideChatDeltaResolution | null> {
  const origin = sideChatOriginOf(input.sideChat);
  if (!origin) {
    return null;
  }
  const sideChatEvents =
    input.sideChatEvents ??
    (await readConversationEvents(input.workspaceId, input.sideChat.id));
  const state = sideChatDeliveryStateFromEvents(sideChatEvents);
  const parent = await readConversationRecord(input.workspaceId, origin.parentConversationId);
  if (!parent) {
    return {
      payload: unavailablePayloadFor({
        origin,
        cursor: state.cursor,
        alreadyNoticed: state.parentUnavailableNoticed,
      }),
      cursor: state.cursor,
      throughSeq: state.cursor,
      parent: null,
    };
  }
  const parentEvents =
    parent.lastEventSeq > state.cursor
      ? await readConversationEventsSince(input.workspaceId, parent.id, state.cursor)
      : [];
  const payload = deltaPayloadFor({
    parent,
    parentEvents,
    fromSeq: state.cursor,
    limits: input.limits,
  });
  return {
    payload,
    cursor: state.cursor,
    throughSeq: Math.max(state.cursor, maxEventSeq(parentEvents, state.cursor)),
    parent,
  };
}

/** Reminder event input for a delta merged onto the user message that starts a turn. */
export function sideChatTurnStartReminderEvent(input: {
  sideChatId: string;
  userMessageId: string;
  payload: SideChatReminderPayload;
}): AgentEventInput {
  return {
    eventId: randomUUID(),
    conversationId: input.sideChatId,
    kind: "system_reminder",
    reminderId: `side-chat-${input.payload.kind}-${input.userMessageId}`,
    targetMessageId: input.userMessageId,
    reason: SIDE_CHAT_REMINDER_REASON,
    text: input.payload.text,
    raw: input.payload.raw,
  };
}

/** Reminder event input for a delta injected between tool iterations. */
export function sideChatInlineReminderEvent(input: {
  sideChatId: string;
  payload: SideChatReminderPayload;
}): AgentEventInput {
  return {
    eventId: randomUUID(),
    conversationId: input.sideChatId,
    kind: "system_reminder",
    reminderId: `side-chat-${input.payload.kind}-inline-${input.payload.throughSeq}`,
    reason: SIDE_CHAT_REMINDER_REASON,
    placement: "inline",
    text: input.payload.text,
    raw: input.payload.raw,
  };
}
