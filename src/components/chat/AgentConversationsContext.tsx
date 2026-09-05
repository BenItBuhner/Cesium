"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  buildConversationModeOptions,
  buildConversationModelOptions,
  dedupeAgentStoredEvents,
  getConversationLatestSeq,
  isAgentConversationBusy,
  mergeAgentConversationStatusFromEvent,
  isIncomingEventDroppedByAcpToolStrip,
  resolveConversationModel,
} from "@/lib/agent-chat";
import { isAgentComposerBusy } from "@/lib/agent-completion-error";
import { pickAvailableBackend } from "@cesium/core";
import { safeReadLocationSearchParam } from "@/lib/safe-url";
import { DEFAULT_MODE_OPTIONS, resolveCanonicalModeId } from "@/lib/chat-modes";
import { listSupplementaryAgentConfigOptions } from "@/lib/agent-config-option-utils";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConfigOption,
  AgentConversationCreateInput,
  AgentConversationEventWindow,
  AgentConversationRecord,
  AgentConversationSnapshot,
  AgentConversationSnapshotHead,
  AgentSocketServerMessage,
  AgentStoredEvent,
} from "@/lib/agent-types";
import type {
  AgentModeOption,
  EditorMode,
  ImageAttachment,
  ModelInfo,
  PlanBuildHandoff,
  QueuedPromptConfigOverride,
} from "@/lib/types";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { nextUnreadCompletionMap } from "@/lib/chat-unread-completion";
import { nextAcknowledgedFailureMap } from "@/lib/chat-acknowledged-failure";
import {
  AGENT_NEW_CHAT_SESSION_ID,
  createEmptyEditorSession,
  getAgentSidePaneSessionScopeId,
  type WorkspaceSessionState,
} from "@/lib/workspace-session";
import { resolveEffectiveConfig } from "@/lib/queued-prompt-utils";
import { useShellView } from "@/components/layout/ShellViewContext";
import { normalizeEditorPanelState } from "@/components/editor/editor-panel-state";
import { JsonWebSocket } from "@/lib/ws-client";
import {
  ConversationEventsStore,
  EMPTY_CONVERSATION_EVENTS,
} from "@/lib/conversation-events-store";
import { recentMainThreadCongestionMs } from "@/lib/main-thread-congestion";
import { devPerfEnabled, recordPerfSample } from "@/lib/dev-perf";
import {
  KeyedEventBatcher,
  STREAM_EVENT_BATCH_WINDOW_MS,
  type EventBatchMap,
} from "@/lib/stream-event-batcher";
import {
  dispatchAgentConversationDeleted,
  dispatchAgentConversationUpserted,
  dispatchAgentConversationsUpsertedBatch,
} from "@/lib/agent-conversation-events";
import { AGENT_BACKENDS_CHANGED_EVENT } from "@/lib/agent-backend-events";
import {
  answerAgentPermission,
  answerAgentQuestion,
  buildAgentWebSocketUrl,
  cancelAgentConversation,
  createAgentSideChat,
  createAndPromptAgentConversation,
  createAndPromptStandaloneAgentConversation,
  createAgentConversation,
  fetchAgentConversationSnapshot,
  forkAgentConversation,
  handoffAgentConversation,
  listAgentConversations,
  listCrossWorkspaceAgentConversations,
  pauseAgentConversation,
  promptAgentConversation,
  resumeAgentConversation,
  retryAgentConversation,
  sendAgentConversationQueueItem,
  updateAgentConversationConfig,
  updateAgentConversationQueueItem,
} from "@/lib/server-api";
import {
  endQueuedPromptFlush,
  tryBeginQueuedPromptFlush,
} from "@/lib/queued-prompt-flush-guard";

function toConversationMap(
  conversations: AgentConversationRecord[]
): Record<string, AgentConversationRecord> {
  return Object.fromEntries(
    conversations.map((conversation) => [conversation.id, conversation])
  );
}

function agentSocketMessageWorkspaceScope(
  message: AgentSocketServerMessage
): string | null {
  switch (message.type) {
    case "conversation":
    case "conversation_upserted":
      return message.conversation.workspaceId;
    case "snapshot":
    case "snapshot_head":
      return message.snapshot.conversation.workspaceId;
    case "history_page":
    case "event":
    case "event_batch":
    case "events_dropped":
    case "events_delta_done":
    case "conversation_deleted":
      return message.workspaceId;
    default:
      return null;
  }
}

/**
 * Structural equality for record meta fields (pending permission/question,
 * queued prompts). Reference and empty checks short-circuit the overwhelmingly
 * common cases (null / empty) so record-batch merges stay cheap with
 * thousands of running conversations; only genuinely differing values pay for
 * a stringify compare.
 */
function conversationMetaFieldEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  const aEmpty = a == null || (Array.isArray(a) && a.length === 0);
  const bEmpty = b == null || (Array.isArray(b) && b.length === 0);
  if (aEmpty || bEmpty) {
    return aEmpty === bEmpty;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function conversationMetaChanged(
  existing: AgentConversationRecord,
  incoming: AgentConversationRecord
): boolean {
  return (
    existing.status !== incoming.status ||
    existing.title !== incoming.title ||
    existing.lastError !== incoming.lastError ||
    existing.archivedAt !== incoming.archivedAt ||
    !conversationMetaFieldEqual(existing.pendingPermission, incoming.pendingPermission) ||
    !conversationMetaFieldEqual(existing.pendingQuestion, incoming.pendingQuestion) ||
    !conversationMetaFieldEqual(existing.queuedPrompts ?? [], incoming.queuedPrompts ?? [])
  );
}

function mergeConversationByRecency(
  existing: AgentConversationRecord | undefined,
  incoming: AgentConversationRecord
): AgentConversationRecord {
  const incomingWithQueue: AgentConversationRecord = {
    ...incoming,
    queuedPrompts: incoming.queuedPrompts ?? [],
  };
  if (!existing) {
    return incomingWithQueue;
  }
  if (incomingWithQueue.updatedAt > existing.updatedAt) {
    return incomingWithQueue;
  }
  if (incomingWithQueue.updatedAt < existing.updatedAt) {
    if (incomingWithQueue.lastEventSeq > existing.lastEventSeq) {
      return { ...incomingWithQueue, updatedAt: existing.updatedAt };
    }
    if (conversationMetaChanged(existing, incomingWithQueue)) {
      return {
        ...existing,
        ...incomingWithQueue,
        updatedAt: existing.updatedAt,
      };
    }
    return existing;
  }
  const metaChanged = conversationMetaChanged(existing, incomingWithQueue);
  if (metaChanged || incomingWithQueue.lastEventSeq !== existing.lastEventSeq) {
    const lastError = incomingWithQueue.lastError ?? existing.lastError;
    const status =
      incomingWithQueue.status === "failed" || existing.status === "failed"
        ? "failed"
        : incomingWithQueue.lastEventSeq >= existing.lastEventSeq
          ? incomingWithQueue.status
          : existing.status;
    return {
      ...existing,
      ...incomingWithQueue,
      lastError,
      status,
      updatedAt: existing.updatedAt,
    };
  }
  return existing;
}

/**
 * Folds one upserted conversation into the workspace session (unread map,
 * acknowledged-failure map, chat tab titles). Returns the same session object
 * when nothing changed so batched folds stay cheap.
 */
function foldWorkspaceSessionAfterConversationUpsert(
  current: WorkspaceSessionState,
  prev: AgentConversationRecord | undefined,
  merged: AgentConversationRecord
): WorkspaceSessionState {
  const unreadMap = nextUnreadCompletionMap(current, prev, merged);
  const ackMap = nextAcknowledgedFailureMap(current, prev, merged);
  const nextTabs = current.chat.tabs.map((tab) =>
    tab.id === merged.id
      ? {
          ...tab,
          title:
            merged.lastEventSeq > 0 && tab.isDraft
              ? merged.title
              : tab.isDraft
                ? tab.title
                : merged.title,
          isDraft: merged.lastEventSeq > 0 ? undefined : tab.isDraft,
        }
      : tab
  );
  const tabUnchanged = nextTabs.every(
    (tab, index) =>
      tab.id === current.chat.tabs[index]?.id &&
      tab.title === current.chat.tabs[index]?.title &&
      Boolean(tab.active) === Boolean(current.chat.tabs[index]?.active) &&
      Boolean(tab.isDraft) === Boolean(current.chat.tabs[index]?.isDraft)
  );
  if (unreadMap === null && ackMap === null && tabUnchanged) {
    return current;
  }
  return {
    ...current,
    chat: {
      ...current.chat,
      ...(unreadMap === null ? {} : { unreadChatCompletionByConversationId: unreadMap }),
      ...(ackMap === null ? {} : { acknowledgedFailureByConversationId: ackMap }),
      ...(!tabUnchanged ? { tabs: nextTabs } : {}),
    },
  };
}

function conversationNeedsRuntimeHydration(
  conversation: AgentConversationRecord | null | undefined
): conversation is AgentConversationRecord {
  if (!conversation) {
    return false;
  }
  return (
    conversation.configOptions.length === 0 ||
    conversation.providerSessionId == null ||
    !conversation.capabilities.supportsLoadSession ||
    (conversation.config.backendId === "cursor-sdk" &&
      !conversation.capabilities.supportsSessionResume) ||
    ((conversation.status === "running" ||
      conversation.status === "awaiting_permission") &&
      conversation.providerSessionId == null)
  );
}

function runtimeHydrationSignature(conversation: AgentConversationRecord): string {
  return [
    conversation.updatedAt,
    conversation.status,
    conversation.lastEventSeq,
    conversation.providerSessionId ?? "",
    conversation.config.backendId,
    conversation.config.mode,
    conversation.configOptions.length,
    conversation.capabilities.supportsLoadSession ? 1 : 0,
    conversation.capabilities.supportsPermissions ? 1 : 0,
    conversation.capabilities.supportsSessionResume ? 1 : 0,
  ].join(":");
}

type ConversationComposerState = {
  conversation: AgentConversationRecord | null;
  backendId: AgentBackendId;
  models: ModelInfo[];
  model: ModelInfo;
  modeOptions: AgentModeOption[];
  mode: EditorMode;
  sessionConfigOptions: AgentConfigOption[];
  busy: boolean;
};

type ConversationLoadStatus = "idle" | "loading" | "ready" | "error";

const BACKGROUND_SNAPSHOT_COOLDOWN_MS = 60_000;

export type ConversationHistoryCursor = {
  hasOlder: boolean;
  loadingOlder: boolean;
};

type AgentConversationsContextValue = {
  backends: AgentBackendInfo[];
  conversationsById: Record<string, AgentConversationRecord>;
  conversations: AgentConversationRecord[];
  /**
   * Per-conversation event logs live outside React state so a streaming flush
   * only re-renders subscribers of that conversation. Subscribe with
   * `useConversationEvents(conversationId)`; for non-reactive reads use
   * `getConversationEvents`.
   */
  conversationEventsStore: ConversationEventsStore;
  /** Non-reactive read of a conversation's current event log. */
  getConversationEvents: (conversationId: string) => AgentStoredEvent[];
  bootstrapped: boolean;
  getConversationLoadStatus: (conversationId: string) => ConversationLoadStatus;
  createConversation: (
    input?: AgentConversationCreateInput
  ) => Promise<AgentConversationRecord>;
  createAndPromptConversation: (
    input: AgentConversationCreateInput,
    text: string,
    attachments?: ImageAttachment[]
  ) => Promise<AgentConversationRecord | null>;
  /** Create a no-workspace chat (temp sandbox) and send the first prompt. */
  createAndPromptStandaloneConversation: (
    input: AgentConversationCreateInput,
    text: string,
    attachments?: ImageAttachment[]
  ) => Promise<{ conversation: AgentConversationRecord; workspaceId: string } | null>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  /** Merge a conversation record from push/HTTP (title, status, unread, tab strip). */
  upsertConversation: (conversation: AgentConversationRecord) => void;
  answerPermissionForConversation: (
    conversationId: string,
    requestId: string,
    optionId: string
  ) => Promise<void>;
  cancelPermissionForConversation: (
    conversationId: string,
    requestId: string
  ) => Promise<void>;
  answerQuestionForConversation: (
    conversationId: string,
    questionId: string,
    answer: string
  ) => Promise<void>;
  setConversationMode: (
    conversationId: string,
    mode: EditorMode
  ) => Promise<void>;
  setConversationModel: (
    conversationId: string,
    model: ModelInfo
  ) => Promise<void>;
  setConversationBackend: (
    conversationId: string,
    backendId: AgentBackendId
  ) => Promise<void>;
  setConversationConfigOption: (
    conversationId: string,
    configId: string,
    value: string
  ) => Promise<void>;
  promptConversation: (
    conversationId: string,
    text: string,
    attachments?: ImageAttachment[],
    configOverride?: QueuedPromptConfigOverride,
    delivery?: "normal" | "steer",
    planHandoff?: PlanBuildHandoff
  ) => Promise<boolean>;
  sendQueuedPromptNow: (conversationId: string, itemId: string) => Promise<boolean>;
  setQueuedPromptDelivery: (
    conversationId: string,
    itemId: string,
    delivery: "normal" | "steer"
  ) => Promise<boolean>;
  retryConversation: (conversationId: string) => Promise<boolean>;
  cancelConversation: (conversationId: string) => Promise<void>;
  pauseConversation: (conversationId: string) => Promise<void>;
  resumeConversation: (conversationId: string) => Promise<void>;
  pendingConfigByConversationId: Record<string, QueuedPromptConfigOverride>;
  setPendingConfigForConversation: (conversationId: string, patch: Partial<QueuedPromptConfigOverride>) => void;
  clearPendingConfigForConversation: (conversationId: string) => void;
  getConversationComposerState: (
    conversationId: string
  ) => ConversationComposerState | null;
  syncConversationSnapshot: (
    conversationId: string,
    options?: { hydrateRuntime?: boolean }
  ) => Promise<void>;
  /** Subscribe immediately (no debounce) so new turns do not miss early events. */
  flushAgentSubscription: (extraConversationIds?: string[]) => void;
  /** Merge a snapshot from HTTP or WebSocket (prompt result, snapshot_head, etc.). */
  mergeConversationSnapshot: (
    snapshot: AgentConversationSnapshot | AgentConversationSnapshotHead
  ) => void;
  /** Re-fetch conversation list + backends (e.g. after visibility change). */
  refreshConversations: () => Promise<AgentConversationRecord[]>;
  forkConversation: (
    conversationId: string,
    options?: { upToMessageId?: string; beforeMessageId?: string }
  ) => Promise<AgentConversationRecord>;
  /**
   * Open a side chat attached to `parentConversationId` (Cesium harness).
   * Non-empty `text`/attachments are sent as the child's first prompt. Throws
   * with the server's policy message (cap, nesting, empty parent) on refusal.
   */
  createSideChat: (
    parentConversationId: string,
    text?: string,
    attachments?: ImageAttachment[]
  ) => Promise<AgentConversationRecord>;
  getConversationHistoryCursor: (conversationId: string) => ConversationHistoryCursor;
  loadOlderConversationHistory: (conversationId: string) => void;
};

const AgentConversationsContext =
  createContext<AgentConversationsContextValue | null>(null);

const MAX_CLIENT_EVENTS_PER_CONVERSATION = 6_000;
/**
 * Pushed `conversation_upserted` records coalesce for this long client-side.
 * Status changes for the ACTIVE conversation still land instantly through the
 * event stream (`status` events); this only paces rail/tab metadata churn.
 */
const CONVERSATION_UPSERT_COALESCE_MS = 250;
/** Stream commit window while the tab is hidden - nobody sees the frames. */
const HIDDEN_STREAM_BATCH_WINDOW_MS = 1_000;
/** At most one gap-recovery delta request per conversation per window. */
const EVENT_DELTA_REQUEST_COOLDOWN_MS = 2_000;
/** Grace before treating record.lastEventSeq > local tail as lost frames. */
const EVENT_CONSISTENCY_GRACE_MS = 2_000;
/**
 * Base wait for the `events_delta_done` ack before re-requesting a recovery
 * delta (scaled by attempt count - generous on purpose so very-high-latency
 * links get their replay through before the watchdog fires again).
 */
const EVENT_DELTA_ACK_TIMEOUT_MS = 10_000;
/** Bounded watchdog retries; past this, reconnect subscribe cursors take over. */
const EVENT_DELTA_MAX_ATTEMPTS = 5;
/** Heartbeat cadence on the agent socket (visible tabs only). */
const AGENT_SOCKET_PING_INTERVAL_MS = 15_000;
/**
 * No inbound frame (of any kind) for this long on a connected, visible socket
 * means the connection is half-open - the TCP session died without a FIN/RST
 * reaching us (common on flaky Wi-Fi / mobile handoffs). Force-close so the
 * reconnect + gap-aware subscribe cursor path replays what was missed.
 */
const AGENT_SOCKET_STALE_MS = 45_000;
/** How often the heartbeat timer wakes to ping / check staleness. */
const AGENT_SOCKET_HEARTBEAT_TICK_MS = 5_000;
/**
 * Very long transcripts make each commit expensive (full projection +
 * reconciliation downstream), so the batch window stretches with the largest
 * pending log to bound the projection work per second.
 */
function resolveStreamBatchWindowMs(largestPendingLogLength: number): number {
  if (typeof document !== "undefined" && document.hidden) {
    return HIDDEN_STREAM_BATCH_WINDOW_MS;
  }
  if (largestPendingLogLength >= 3_000) {
    return 250;
  }
  if (largestPendingLogLength >= 1_200) {
    return 150;
  }
  return STREAM_EVENT_BATCH_WINDOW_MS;
}
const BATCHABLE_STREAM_EVENT_KINDS = new Set<AgentStoredEvent["kind"]>([
  "assistant_message_chunk",
  "reasoning",
]);

type StreamRenderPerfSnapshot = {
  batchingEnabled: boolean;
  receivedEvents: number;
  flushes: number;
  stateUpdates: number;
  committedEvents: number;
  maxBatchEvents: number;
  pendingEvents: number;
};

type StreamRenderPerfControl = {
  ingest: (conversationId: string, events: AgentStoredEvent[]) => void;
  setBatchingEnabled: (enabled: boolean | null) => void;
  flush: () => void;
  reset: () => void;
  snapshot: () => StreamRenderPerfSnapshot;
  /** Diagnostics: committed tail seq of a conversation's local event log. */
  tailSeq: (conversationId: string) => number;
};

declare global {
  interface Window {
    __opencursorStreamRenderPerf?: StreamRenderPerfControl;
  }
}

export function shouldFlushAgentEventRenderBatch(
  events: readonly AgentStoredEvent[]
): boolean {
  return events.some((event) => {
    if (BATCHABLE_STREAM_EVENT_KINDS.has(event.kind)) {
      return false;
    }
    if (event.kind === "tool_call_update") {
      return event.status !== "pending" && event.status !== "in_progress";
    }
    return true;
  });
}

/**
 * Adjacent assistant deltas are observationally equivalent to one concatenated
 * delta. Keep the newest sequence/id so reconnect cursors still advance to the
 * last event represented by the compacted row, and record the oldest swallowed
 * seq as `firstSeq` so the row still declares the full seq range it covers -
 * without it, a recovery replay overlapping the compacted range would not be
 * recognized as duplicate and its text would be inserted a second time.
 */
export function compactAdjacentAgentMessageChunks(
  events: AgentStoredEvent[]
): AgentStoredEvent[] {
  let compacted: AgentStoredEvent[] | null = null;
  for (let index = 1; index < events.length; index += 1) {
    const previous = compacted
      ? compacted[compacted.length - 1]
      : events[index - 1];
    const event = events[index]!;
    if (
      previous?.kind === "assistant_message_chunk" &&
      event.kind === "assistant_message_chunk" &&
      previous.messageId === event.messageId &&
      // Only stream-adjacent chunks may merge. Array-adjacent rows can sit on
      // either side of a sequence hole (dropped frames); gluing across it
      // would claim coverage of seqs this client never received and block the
      // recovery replay from inserting them.
      eventCoverageStart(event) === previous.seq + 1
    ) {
      if (!compacted) {
        compacted = events.slice(0, index);
      }
      compacted[compacted.length - 1] = {
        ...previous,
        ...event,
        firstSeq: eventCoverageStart(previous),
        text: previous.text + event.text,
      };
      continue;
    }
    compacted?.push(event);
  }
  return compacted ?? events;
}

/** Oldest seq a (possibly compacted) row represents; rows cover `[start, seq]` inclusive. */
function eventCoverageStart(event: AgentStoredEvent): number {
  const firstSeq = event.firstSeq;
  return typeof firstSeq === "number" && firstSeq > 0 && firstSeq < event.seq
    ? firstSeq
    : event.seq;
}

/**
 * Whether `seq` is already represented by a row in the log, either exactly or
 * inside a compacted row's covered range. `sortedBySeq` must be ascending by
 * `seq` (the merge layer's invariant); lookup is a binary search for the first
 * row whose tail seq reaches `seq`.
 */
export function isSeqCoveredByEvents(
  sortedBySeq: readonly AgentStoredEvent[],
  seq: number
): boolean {
  if (seq <= 0) {
    return false;
  }
  let lo = 0;
  let hi = sortedBySeq.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedBySeq[mid]!.seq < seq) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const candidate = sortedBySeq[lo];
  if (!candidate || candidate.seq < seq) {
    return false;
  }
  return candidate.seq === seq || eventCoverageStart(candidate) <= seq;
}

function isSortedBySeq(events: readonly AgentStoredEvent[]): boolean {
  for (let i = 1; i < events.length; i += 1) {
    if (events[i]!.seq < events[i - 1]!.seq) {
      return false;
    }
  }
  return true;
}

function compactConversationEvents(events: AgentStoredEvent[]): AgentStoredEvent[] {
  if (events.length <= MAX_CLIENT_EVENTS_PER_CONVERSATION) {
    return events;
  }
  return events.slice(events.length - MAX_CLIENT_EVENTS_PER_CONVERSATION);
}

export function mergeAgentConversationEventBatch(
  existing: AgentStoredEvent[],
  incoming: AgentStoredEvent[]
): AgentStoredEvent[] {
  if (incoming.length === 0) {
    return existing;
  }
  // Fast path - pure tail append (the overwhelmingly common streaming case):
  // every incoming seq is strictly beyond the existing tail and strictly
  // increasing. Skipping the two full-log Set rebuilds turns the per-flush
  // merge from O(existing + incoming) into O(incoming), which is what keeps
  // thousands of long conversations streaming concurrently cheap.
  const tailSeq = existing.at(-1)?.seq ?? Number.NEGATIVE_INFINITY;
  let pureAppend = existing.length > 0;
  let previousSeq = tailSeq;
  for (let i = 0; pureAppend && i < incoming.length; i += 1) {
    const seq = incoming[i]!.seq;
    if (!(seq > previousSeq) || seq <= 0) {
      pureAppend = false;
      break;
    }
    previousSeq = seq;
  }
  if (pureAppend) {
    // Optimistic local events (client-guessed seq, shared eventId with the
    // real event the server later assigns) always live near the tail; a
    // duplicate eventId there must take the slow path's full dedupe.
    const tailIds = new Set<string>();
    for (let i = Math.max(0, existing.length - 8); i < existing.length; i += 1) {
      tailIds.add(existing[i]!.eventId);
    }
    const tailDuplicate = incoming.some((event) => tailIds.has(event.eventId));
    if (!tailDuplicate) {
      let next = existing;
      for (const event of incoming) {
        if (isIncomingEventDroppedByAcpToolStrip(next, event)) {
          continue;
        }
        if (next === existing) {
          next = [...existing];
        }
        next.push(event);
      }
      if (next === existing) {
        return existing;
      }
      return compactConversationEvents(compactAdjacentAgentMessageChunks(next));
    }
  }
  // Coverage-aware dedupe: compacted chunk rows swallow their predecessors'
  // seq/eventId, so a plain seq Set would fail to recognize replayed chunks
  // whose text already lives inside a compacted row - re-inserting them
  // garbles the assistant message. Rows are matched by their covered seq
  // range instead.
  const existingSorted = isSortedBySeq(existing)
    ? existing
    : [...existing].sort((a, b) => a.seq - b.seq);
  const seenEventIds = new Set(existing.map((event) => event.eventId));
  const addedSeq = new Set<number>();
  let next: AgentStoredEvent[] = existing;
  for (const event of incoming) {
    const seqDuplicate =
      event.seq > 0 &&
      (addedSeq.has(event.seq) || isSeqCoveredByEvents(existingSorted, event.seq));
    if (seqDuplicate || seenEventIds.has(event.eventId)) {
      continue;
    }
    if (isIncomingEventDroppedByAcpToolStrip(next, event)) {
      continue;
    }
    if (next === existing) {
      next = [...existing];
    }
    next.push(event);
    if (event.seq > 0) {
      addedSeq.add(event.seq);
    }
    seenEventIds.add(event.eventId);
  }
  if (next === existing) {
    return existing;
  }
  const ordered = next.every(
    (event, index) => index === 0 || event.seq >= (next[index - 1]?.seq ?? 0)
  )
    ? next
    : [...next].sort((a, b) => a.seq - b.seq);
  return compactConversationEvents(compactAdjacentAgentMessageChunks(ordered));
}

export function mergeAgentConversationEventMap(
  current: Record<string, AgentStoredEvent[]>,
  batches: ReadonlyMap<string, AgentStoredEvent[]>
): Record<string, AgentStoredEvent[]> {
  let next = current;
  for (const [conversationId, incoming] of batches) {
    const existing = current[conversationId] ?? [];
    const merged = mergeAgentConversationEventBatch(existing, incoming);
    if (merged === existing) {
      continue;
    }
    if (next === current) {
      next = { ...current };
    }
    next[conversationId] = merged;
  }
  return next;
}

export function mergeAgentConversationSnapshotHeadEvents(
  existing: AgentStoredEvent[],
  incoming: AgentStoredEvent[],
  window: Pick<AgentConversationEventWindow, "oldestSeq" | "newestSeq">
): AgentStoredEvent[] {
  // A prompt ACK can carry an older head than events already delivered over
  // the socket. Treat only the advertised window as authoritative: retain
  // loaded history before it and live events that raced ahead of it. Rows are
  // matched by covered seq range: a compacted chunk row overlapping the
  // window must be replaced by the window's raw rows or its text duplicates.
  const kept = existing.filter(
    (event) =>
      event.seq < window.oldestSeq || eventCoverageStart(event) > window.newestSeq
  );
  const bySeq = new Map<number, AgentStoredEvent>();
  for (const event of kept) {
    bySeq.set(event.seq, event);
  }
  for (const event of incoming) {
    bySeq.set(event.seq, event);
  }
  return compactConversationEvents(
    dedupeAgentStoredEvents([...bySeq.values()].sort((a, b) => a.seq - b.seq))
  );
}

export function AgentConversationsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const {
    activeWorkspaceId,
    markWorkspaceActivity,
    workspaceSession,
    updateWorkspaceSession,
  } = useWorkspace();
  const { activeServer } = useServerConnections();
  const agentSocketServerKey = activeServer.baseUrl;
  const activeWorkspaceIdRef = useRef<string | null>(activeWorkspaceId);
  activeWorkspaceIdRef.current = activeWorkspaceId;
  const { settings: globalSettings, refreshModels, refreshSettings } = useGlobalSettings();
  const [backends, setBackends] = useState<AgentBackendInfo[]>([]);
  const [conversationsById, setConversationsById] = useState<
    Record<string, AgentConversationRecord>
  >({});
  const [eventsStore] = useState(() => new ConversationEventsStore());
  // Load-status readiness depends on whether a conversation's log has been
  // loaded at all; that key-set changes rarely (snapshot arrival, deletion,
  // workspace switch), unlike the logs themselves which change every flush.
  const eventsKeysVersion = useSyncExternalStore(
    useCallback((onChange) => eventsStore.subscribeKeys(onChange), [eventsStore]),
    () => eventsStore.getKeysVersion(),
    () => 0
  );
  const [bootstrapped, setBootstrapped] = useState(false);
  const [conversationLoadStatusById, setConversationLoadStatusById] = useState<
    Record<string, ConversationLoadStatus>
  >({});
  const [historyMetaById, setHistoryMetaById] = useState<
    Record<string, { hasOlder: boolean }>
  >({});
  const [loadingOlderById, setLoadingOlderById] = useState<Record<string, boolean>>({});
 const [pendingConfigByConversationId, setPendingConfigByConversationId] = useState<Record<string, QueuedPromptConfigOverride>>({});
  const pendingConfigRef = useRef(pendingConfigByConversationId);
  pendingConfigRef.current = pendingConfigByConversationId;
  const historyMetaRef = useRef(historyMetaById);
  const loadingOlderRef = useRef<Record<string, boolean>>({});
  const socketRef = useRef<JsonWebSocket<AgentSocketServerMessage> | null>(null);
  const subscribeDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushAgentSubscriptionRef = useRef<(extraConversationIds?: string[]) => void>(() => {});
  const scheduleConversationCatchUpRef = useRef<(conversationId: string) => void>(() => {});
  const openConversationsSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composerDefaultsRef = useRef(globalSettings.composer);
  const loadedSnapshotConversationIdsRef = useRef(new Set<string>());
  const backgroundSnapshotCooldownUntilRef = useRef<Record<string, number>>({});
  const openConversationIdsRef = useRef<string[]>([]);
  const snapshotPrimeInFlightRef = useRef(new Set<string>());
  const hydratingConversationIdsRef = useRef(new Set<string>());
  const runtimeHydrationSignatureByIdRef = useRef<Record<string, string>>({});
  /** Successful `history_page` responses per conversation (first fetch asks for a larger page). */
  const historyOlderPagesFetchedRef = useRef<Record<string, number>>({});
  const conversationsByIdRef = useRef(conversationsById);
  conversationsByIdRef.current = conversationsById;
  const commitEventBatchesRef = useRef<
    (batches: EventBatchMap<AgentStoredEvent>) => void
  >(() => {});
  const ingestConversationEventsRef = useRef<
    (conversationId: string, events: AgentStoredEvent[]) => void
  >(() => {});
  const configuredBatchingEnabledRef = useRef(
    globalSettings.general.batchStreamEvents
  );
  const batchingOverrideRef = useRef<boolean | null>(null);
  const streamRenderPerfRef = useRef({
    receivedEvents: 0,
    flushes: 0,
    stateUpdates: 0,
    committedEvents: 0,
    maxBatchEvents: 0,
  });
  const [eventRenderBatcher] = useState(
    () =>
      new KeyedEventBatcher<AgentStoredEvent>({
        enabled: globalSettings.general.batchStreamEvents,
        onFlush: (batches) => commitEventBatchesRef.current(batches),
        // Slow or artificially throttled devices can't hold the frame budget
        // at the default commit cadence - instead of dropping frames, commits
        // get rarer: the window stretches with main-thread congestion and
        // relaxes as it drains.
        resolveWindowMs: (pendingKeys) => {
          let largest = 0;
          for (const key of pendingKeys) {
            const length = eventsStore.get(key).length;
            if (length > largest) {
              largest = length;
            }
          }
          const base = resolveStreamBatchWindowMs(largest);
          const congestion = recentMainThreadCongestionMs();
          if (congestion <= 60) {
            return base;
          }
          return Math.min(
            1_200,
            Math.round(base * Math.min(6, 1 + congestion / 200))
          );
        },
        // Tool completions force an immediate commit for visible feedback;
        // with the tab hidden there is nothing to see, so let them coalesce.
        // Under main-thread congestion they coalesce too - an immediate
        // commit would only widen the frame gap it is trying to explain.
        allowImmediateFlush: () =>
          (typeof document === "undefined" || !document.hidden) &&
          recentMainThreadCongestionMs() <= 250,
      })
  );

  // Returning to a hidden tab commits whatever accumulated at the slow hidden
  // cadence right away, so the transcript is current the moment it is seen.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (!document.hidden) {
        eventRenderBatcher.flush();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [eventRenderBatcher]);

  useEffect(() => {
    composerDefaultsRef.current = globalSettings.composer;
  }, [globalSettings.composer]);

  useEffect(() => {
    historyMetaRef.current = historyMetaById;
  }, [historyMetaById]);

  const { shellView } = useShellView();
  const isAgentRoute = shellView === "agent";
  const requestedConversationIdFromLocation =
    isAgentRoute && typeof window !== "undefined"
      ? safeReadLocationSearchParam("conversationId")
      : null;
  const activeSelectedConversationId =
    requestedConversationIdFromLocation &&
    requestedConversationIdFromLocation !== AGENT_NEW_CHAT_SESSION_ID
      ? requestedConversationIdFromLocation
      : workspaceSession.agentView.selectedConversationId &&
          workspaceSession.agentView.selectedConversationId !== AGENT_NEW_CHAT_SESSION_ID
        ? workspaceSession.agentView.selectedConversationId
        : null;
  const activeAgentSidePaneEditor = useMemo(() => {
    const scopeId = getAgentSidePaneSessionScopeId(
      requestedConversationIdFromLocation ?? workspaceSession.agentView.selectedConversationId
    );
    return (
      workspaceSession.agentView.sidePaneSessionsByConversationId?.[scopeId]?.editor ??
      null
    );
  }, [
    requestedConversationIdFromLocation,
    workspaceSession.agentView.sidePaneSessionsByConversationId,
    workspaceSession.agentView.selectedConversationId,
  ]);
  const scopedEditorSession =
    isAgentRoute
      ? activeAgentSidePaneEditor ??
        (Object.keys(workspaceSession.agentView.sidePaneSessionsByConversationId ?? {}).length ===
        0
          ? workspaceSession.editor
          : createEmptyEditorSession())
      : workspaceSession.editor;

  const conversations = useMemo(
    () =>
      Object.values(conversationsById).sort((a, b) => b.updatedAt - a.updatedAt),
    [conversationsById]
  );

  const openConversationIds = useMemo(() => {
    const ids = new Set<string>();
    if (activeSelectedConversationId) {
      ids.add(activeSelectedConversationId);
    }
    for (const tab of scopedEditorSession.leftTabs) {
      if (tab.conversationId) {
        ids.add(tab.conversationId);
      }
      // Subagent transcript tabs replay their parent conversation's events;
      // keep that parent subscribed even when no chat pane has it open.
      if (tab.transcriptLiveConversationId) {
        ids.add(tab.transcriptLiveConversationId);
      }
    }
    for (const tab of scopedEditorSession.rightTabs) {
      if (tab.conversationId) {
        ids.add(tab.conversationId);
      }
      if (tab.transcriptLiveConversationId) {
        ids.add(tab.transcriptLiveConversationId);
      }
    }
    // IDE chat tabs (session.chat.tabs) are separate from editor tabs; include them
    // so the agent socket subscribes without needing a second WebSocket in ChatPanel.
    for (const tab of workspaceSession.chat.tabs) {
      if (tab.id) {
        ids.add(tab.id);
      }
    }
    return [...ids];
  }, [
    activeSelectedConversationId,
    scopedEditorSession.leftTabs,
    scopedEditorSession.rightTabs,
    workspaceSession.chat.tabs,
  ]);

  useEffect(() => {
    openConversationIdsRef.current = openConversationIds;
  }, [openConversationIds]);

  const visibleConversationIds = useMemo(() => {
    const ids = new Set<string>();
    if (activeSelectedConversationId) {
      ids.add(activeSelectedConversationId);
    }
    const leftActive = scopedEditorSession.leftTabs.find(
      (tab) => tab.id === scopedEditorSession.leftActiveId
    );
    if (leftActive?.conversationId) {
      ids.add(leftActive.conversationId);
    }
    if (leftActive?.transcriptLiveConversationId) {
      ids.add(leftActive.transcriptLiveConversationId);
    }

    const rightActive = scopedEditorSession.rightTabs.find(
      (tab) => tab.id === scopedEditorSession.rightActiveId
    );
    if (rightActive?.conversationId) {
      ids.add(rightActive.conversationId);
    }
    if (rightActive?.transcriptLiveConversationId) {
      ids.add(rightActive.transcriptLiveConversationId);
    }

    return [...ids];
  }, [
    activeSelectedConversationId,
    scopedEditorSession.leftActiveId,
    scopedEditorSession.leftTabs,
    scopedEditorSession.rightActiveId,
    scopedEditorSession.rightTabs,
  ]);

  /** Keep background snapshot work off the critical path; selected/visible panes load explicitly. */
  const prefetchTargetConversationIds = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const id of visibleConversationIds) {
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }, [visibleConversationIds]);

  const mergeConversationSnapshot = useCallback(
    (snapshot: AgentConversationSnapshot | AgentConversationSnapshotHead) => {
      const incoming = snapshot.conversation;
      const prev = conversationsByIdRef.current[incoming.id];
      const merged = mergeConversationByRecency(prev, incoming);
      setConversationsById((current) => ({
        ...current,
        [incoming.id]: mergeConversationByRecency(current[incoming.id], incoming),
      }));

      const isHead =
        "window" in snapshot &&
        snapshot.window != null &&
        typeof snapshot.window.oldestSeq === "number";
      if (isHead) {
        const head = snapshot;
        eventsStore.update(incoming.id, (existing) =>
          mergeAgentConversationSnapshotHeadEvents(existing, head.events, head.window)
        );
        setHistoryMetaById((c) => ({
          ...c,
          [incoming.id]: { hasOlder: head.window.hasOlder },
        }));
      } else {
        const full = snapshot as AgentConversationSnapshot;
        eventsStore.update(full.conversation.id, (current) => {
          const existing = dedupeAgentStoredEvents(current);
          const existingSeq = existing.at(-1)?.seq ?? 0;
          const incomingDeduped = dedupeAgentStoredEvents(full.events);
          const incomingSeq = incomingDeduped.at(-1)?.seq ?? 0;
          return compactConversationEvents(
            incomingSeq >= existingSeq ? incomingDeduped : existing
          );
        });
        setHistoryMetaById((c) => ({
          ...c,
          [incoming.id]: { hasOlder: false },
        }));
      }
      // Snapshots reset the gap-detection baseline to the merged tail. Any
      // outstanding hole bookkeeping is superseded: the snapshot window is
      // authoritative for the range it covers.
      {
        const ledger = lastSeenSeqByConversationRef.current;
        const tailSeq = getConversationLatestSeq(eventsStore.get(incoming.id));
        if (tailSeq > (ledger.get(incoming.id) ?? 0)) {
          ledger.set(incoming.id, tailSeq);
        }
        gapSinceSeqByConversationRef.current.delete(incoming.id);
        const recovery = deltaRecoveryRef.current.get(incoming.id);
        if (recovery?.timer != null) {
          clearTimeout(recovery.timer);
        }
        deltaRecoveryRef.current.delete(incoming.id);
      }

updateWorkspaceSession((current) => {
      const unreadMap = nextUnreadCompletionMap(current, prev, merged);
      const ackMap = nextAcknowledgedFailureMap(current, prev, merged);
      const nextTabs = current.chat.tabs.map((tab) =>
        tab.id === incoming.id
          ? {
              ...tab,
              title: incoming.lastEventSeq > 0 && tab.isDraft ? incoming.title : tab.isDraft ? tab.title : incoming.title,
              isDraft: incoming.lastEventSeq > 0 ? undefined : tab.isDraft,
            }
          : tab
      );
      const tabUnchanged = nextTabs.every(
        (tab, index) =>
          tab.id === current.chat.tabs[index]?.id &&
          tab.title === current.chat.tabs[index]?.title &&
          Boolean(tab.active) === Boolean(current.chat.tabs[index]?.active) &&
          Boolean(tab.isDraft) === Boolean(current.chat.tabs[index]?.isDraft)
      );
      if (unreadMap === null && ackMap === null && tabUnchanged) {
        return current;
      }
        return {
          ...current,
          chat: {
            ...current.chat,
            ...(unreadMap === null
              ? {}
              : { unreadChatCompletionByConversationId: unreadMap }),
            ...(ackMap === null ? {} : { acknowledgedFailureByConversationId: ackMap }),
            ...(!tabUnchanged ? { tabs: nextTabs } : {}),
          },
        };
      });
      setConversationLoadStatusById((current) =>
        current[incoming.id] === "ready"
          ? current
          : {
              ...current,
              [incoming.id]: "ready",
            }
      );
      delete historyOlderPagesFetchedRef.current[incoming.id];
      dispatchAgentConversationUpserted(merged);
      loadedSnapshotConversationIdsRef.current.add(incoming.id);
    },
    [eventsStore, updateWorkspaceSession]
  );

  const primeConversationSnapshotIfEmpty = useCallback(
    async (conversationId: string) => {
      if (!conversationId || conversationId === AGENT_NEW_CHAT_SESSION_ID) {
        return;
      }
      if (conversationId.startsWith("draft-")) {
        return;
      }
      if (loadedSnapshotConversationIdsRef.current.has(conversationId)) {
        return;
      }
      if ((backgroundSnapshotCooldownUntilRef.current[conversationId] ?? 0) > Date.now()) {
        return;
      }
      if (eventsStore.has(conversationId)) {
        loadedSnapshotConversationIdsRef.current.add(conversationId);
        return;
      }
      if (snapshotPrimeInFlightRef.current.has(conversationId)) {
        return;
      }
      snapshotPrimeInFlightRef.current.add(conversationId);
      backgroundSnapshotCooldownUntilRef.current[conversationId] =
        Date.now() + BACKGROUND_SNAPSHOT_COOLDOWN_MS;
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 55_000);
      try {
        const result = await fetchAgentConversationSnapshot(conversationId, {
          signal: controller.signal,
        });
        mergeConversationSnapshot(result.snapshot);
      } catch {
        /* background prime */
      } finally {
        window.clearTimeout(timer);
        snapshotPrimeInFlightRef.current.delete(conversationId);
      }
    },
    [eventsStore, mergeConversationSnapshot]
  );

  const prependHistoryPage = useCallback(
    (
      conversationId: string,
      pageEvents: AgentStoredEvent[],
      window: AgentConversationEventWindow
    ) => {
      loadingOlderRef.current[conversationId] = false;
      setLoadingOlderById((c) => ({ ...c, [conversationId]: false }));
      eventsStore.update(conversationId, (existing) => {
        const bySeq = new Map<number, AgentStoredEvent>();
        for (const e of existing) {
          bySeq.set(e.seq, e);
        }
        for (const e of pageEvents) {
          bySeq.set(e.seq, e);
        }
        const merged = dedupeAgentStoredEvents(
          [...bySeq.values()].sort((a, b) => a.seq - b.seq)
        );
        return compactConversationEvents(merged);
      });
      setHistoryMetaById((c) => ({
        ...c,
        [conversationId]: { hasOlder: window.hasOlder },
      }));
      historyOlderPagesFetchedRef.current[conversationId] =
        (historyOlderPagesFetchedRef.current[conversationId] ?? 0) + 1;
    },
    [eventsStore]
  );

  const loadOlderConversationHistory = useCallback((conversationId: string) => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      return;
    }
    const meta = historyMetaRef.current[conversationId];
    if (!meta?.hasOlder) {
      return;
    }
    if (loadingOlderRef.current[conversationId]) {
      return;
    }
    const events = eventsStore.get(conversationId);
    const oldest = events[0]?.seq;
    if (!oldest) {
      return;
    }
    loadingOlderRef.current[conversationId] = true;
    setLoadingOlderById((c) => ({ ...c, [conversationId]: true }));
    const pagesDone = historyOlderPagesFetchedRef.current[conversationId] ?? 0;
    socket.send({
      type: "request_history",
      conversationId,
      beforeSeq: oldest,
      ...(pagesDone === 0
        ? { limitTurns: 160, limitEvents: 4000 }
        : {}),
    });
    window.setTimeout(() => {
      if (loadingOlderRef.current[conversationId]) {
        loadingOlderRef.current[conversationId] = false;
        setLoadingOlderById((c) => ({ ...c, [conversationId]: false }));
      }
    }, 18_000);
  }, [eventsStore]);

  const getConversationHistoryCursor = useCallback(
    (conversationId: string): ConversationHistoryCursor => ({
      hasOlder: historyMetaById[conversationId]?.hasOlder ?? false,
      loadingOlder: loadingOlderById[conversationId] ?? false,
    }),
    [historyMetaById, loadingOlderById]
  );

  const patchConversationStatus = useCallback(
    (conversationId: string, status: AgentConversationRecord["status"]) => {
      setConversationsById((current) => {
        const conversation = current[conversationId];
        if (!conversation || conversation.status === status) {
          return current;
        }
        return {
          ...current,
          [conversationId]: {
            ...conversation,
            status,
            updatedAt: Math.max(conversation.updatedAt, Date.now()),
          },
        };
      });
    },
    []
  );

  const commitConversationEventBatches = useCallback(
    (batches: EventBatchMap<AgentStoredEvent>) => {
      let eventCount = 0;
      let maxConversationBatch = 0;
      let hasStatusEvents = false;
      for (const events of batches.values()) {
        eventCount += events.length;
        maxConversationBatch = Math.max(maxConversationBatch, events.length);
        hasStatusEvents ||= events.some((event) => event.kind === "status");
      }
      if (eventCount === 0) {
        return;
      }

      const perf = streamRenderPerfRef.current;
      perf.flushes += 1;
      perf.stateUpdates += 1;
      perf.committedEvents += eventCount;
      perf.maxBatchEvents = Math.max(perf.maxBatchEvents, maxConversationBatch);

      if (hasStatusEvents) {
        setConversationsById((current) => {
          let next = current;
          for (const [conversationId, events] of batches) {
            let conversation = next[conversationId];
            if (!conversation) {
              continue;
            }
            for (const event of events) {
              if (event.kind !== "status") {
                continue;
              }
              const merged = mergeAgentConversationStatusFromEvent(conversation, event);
              if (!merged) {
                continue;
              }
              if (next === current) {
                next = { ...current };
              }
              conversation = merged;
              next[conversationId] = merged;
            }
          }
          return next;
        });
      }

      for (const [conversationId, incoming] of batches) {
        eventsStore.update(conversationId, (existing) =>
          mergeAgentConversationEventBatch(existing, incoming)
        );
      }
    },
    [eventsStore]
  );

  useEffect(() => {
    commitEventBatchesRef.current = commitConversationEventBatches;
  }, [commitConversationEventBatches]);

  /**
   * Highest event seq seen per conversation (including events still pending
   * in the render batcher). Live stream frames are droppable under socket
   * backpressure by design; this is the ledger that lets the client notice a
   * hole and request a delta instead of silently rendering a stale transcript.
   */
  const lastSeenSeqByConversationRef = useRef(new Map<string, number>());
  const deltaRequestCooldownUntilRef = useRef(new Map<string, number>());
  const consistencyCheckTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /**
   * Safe resume cursor per conversation while a sequence hole is outstanding:
   * the highest seq up to which the local log was known contiguous when the
   * hole appeared. Recovery requests and reconnect subscribe cursors must
   * start here, not at the (post-hole) tail, or the hole survives forever.
   * Cleared when a recovery ack (`events_delta_done`) covers it or a fresh
   * snapshot resets the log.
   */
  const gapSinceSeqByConversationRef = useRef(new Map<string, number>());
  /**
   * In-flight delta recovery awaiting its `events_delta_done` ack. On a lossy
   * link the request or the replay itself can be lost; without an ack-driven
   * retry the transcript stays holed until some unrelated frame re-exposes
   * the gap. Attempts back off linearly and are bounded - a reconnect's
   * subscribe cursor (gap-aware) is the recovery path of last resort.
   */
  const deltaRecoveryRef = useRef(
    new Map<string, { timer: ReturnType<typeof setTimeout> | null; attempts: number }>()
  );
  const requestEventsDeltaRef = useRef<(conversationId: string) => void>(() => {});

  const recordEventGap = useCallback((conversationId: string, safeSinceSeq: number) => {
    if (safeSinceSeq <= 0) {
      return;
    }
    const gaps = gapSinceSeqByConversationRef.current;
    const existing = gaps.get(conversationId);
    gaps.set(
      conversationId,
      existing == null ? safeSinceSeq : Math.min(existing, safeSinceSeq)
    );
  }, []);

  const clearDeltaRecovery = useCallback((conversationId: string) => {
    const recovery = deltaRecoveryRef.current.get(conversationId);
    if (recovery?.timer != null) {
      clearTimeout(recovery.timer);
    }
    deltaRecoveryRef.current.delete(conversationId);
  }, []);

  const requestEventsDelta = useCallback((conversationId: string) => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      // The reconnect subscribe cursor (gap-aware) takes over once the
      // socket is back; an offline retry loop would be wasted work.
      return;
    }
    const now = Date.now();
    const cooldownUntil = deltaRequestCooldownUntilRef.current.get(conversationId) ?? 0;
    if (cooldownUntil > now) {
      return;
    }
    const lastSeen = lastSeenSeqByConversationRef.current.get(conversationId) ?? 0;
    const gapSince = gapSinceSeqByConversationRef.current.get(conversationId);
    const sinceSeq = gapSince == null ? lastSeen : Math.min(gapSince, lastSeen);
    if (sinceSeq <= 0) {
      // Nothing local yet - first hydration belongs to the snapshot path,
      // not a full-log delta replay.
      return;
    }
    deltaRequestCooldownUntilRef.current.set(
      conversationId,
      now + EVENT_DELTA_REQUEST_COOLDOWN_MS
    );
    socket.send({
      type: "request_events_since",
      conversationId,
      sinceSeq,
    });
    // Arm the ack watchdog: if no events_delta_done lands, re-request.
    const recovery = deltaRecoveryRef.current;
    const entry = recovery.get(conversationId) ?? { timer: null, attempts: 0 };
    if (entry.timer != null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.attempts += 1;
    if (entry.attempts <= EVENT_DELTA_MAX_ATTEMPTS) {
      entry.timer = setTimeout(() => {
        entry.timer = null;
        requestEventsDeltaRef.current(conversationId);
      }, EVENT_DELTA_ACK_TIMEOUT_MS * entry.attempts);
    }
    recovery.set(conversationId, entry);
  }, []);

  useEffect(() => {
    requestEventsDeltaRef.current = requestEventsDelta;
  }, [requestEventsDelta]);

  /**
   * A pushed record / heartbeat pong whose latest seq runs ahead of the local
   * log means frames were lost (or never subscribed-through). Give in-flight
   * batches a grace period, then heal with a delta if the hole is still there.
   */
  const scheduleEventConsistencyCheck = useCallback(
    (conversationId: string, targetSeq?: number) => {
      if (consistencyCheckTimersRef.current.has(conversationId)) {
        return;
      }
      const timer = setTimeout(() => {
        consistencyCheckTimersRef.current.delete(conversationId);
        const record = conversationsByIdRef.current[conversationId];
        const target = Math.max(targetSeq ?? 0, record?.lastEventSeq ?? 0);
        const lastSeen = lastSeenSeqByConversationRef.current.get(conversationId) ?? 0;
        if (target > lastSeen && lastSeen > 0) {
          recordEventGap(conversationId, lastSeen);
          requestEventsDelta(conversationId);
        }
      }, EVENT_CONSISTENCY_GRACE_MS);
      consistencyCheckTimersRef.current.set(conversationId, timer);
    },
    [recordEventGap, requestEventsDelta]
  );

  const ingestConversationEvents = useCallback(
    (conversationId: string, incoming: AgentStoredEvent[]) => {
      if (incoming.length === 0) {
        return;
      }
      const ledger = lastSeenSeqByConversationRef.current;
      const lastSeen = ledger.get(conversationId) ?? 0;
      let minIncoming = Number.POSITIVE_INFINITY;
      let maxIncoming = lastSeen;
      for (const event of incoming) {
        if (event.seq < minIncoming) {
          minIncoming = event.seq;
        }
        if (event.seq > maxIncoming) {
          maxIncoming = event.seq;
        }
      }
      if (lastSeen > 0 && minIncoming > lastSeen + 1) {
        // Sequence hole: frames between lastSeen and this batch were dropped.
        // Pin the safe cursor before the ledger advances past the hole so
        // retries and reconnect subscribes keep replaying from solid ground.
        recordEventGap(conversationId, lastSeen);
        requestEventsDelta(conversationId);
      }
      ledger.set(conversationId, maxIncoming);
      streamRenderPerfRef.current.receivedEvents += incoming.length;
      eventRenderBatcher.enqueue(
        conversationId,
        incoming,
        shouldFlushAgentEventRenderBatch(incoming)
      );
    },
    [eventRenderBatcher, recordEventGap, requestEventsDelta]
  );

  useEffect(() => {
    ingestConversationEventsRef.current = ingestConversationEvents;
  }, [ingestConversationEvents]);

  useEffect(() => {
    configuredBatchingEnabledRef.current =
      globalSettings.general.batchStreamEvents;
    if (batchingOverrideRef.current == null) {
      eventRenderBatcher.setEnabled(globalSettings.general.batchStreamEvents);
    }
  }, [eventRenderBatcher, globalSettings.general.batchStreamEvents]);

  useEffect(() => {
    if (!devPerfEnabled()) {
      return;
    }
    const control: StreamRenderPerfControl = {
      ingest: (conversationId, events) =>
        ingestConversationEventsRef.current(conversationId, events),
      setBatchingEnabled: (enabled) => {
        batchingOverrideRef.current = enabled;
        eventRenderBatcher.setEnabled(
          enabled ?? configuredBatchingEnabledRef.current
        );
      },
      flush: () => eventRenderBatcher.flush(),
      reset: () => {
        eventRenderBatcher.flush();
        streamRenderPerfRef.current = {
          receivedEvents: 0,
          flushes: 0,
          stateUpdates: 0,
          committedEvents: 0,
          maxBatchEvents: 0,
        };
      },
      snapshot: () => ({
        batchingEnabled: eventRenderBatcher.isEnabled(),
        ...streamRenderPerfRef.current,
        pendingEvents: eventRenderBatcher.pendingEventCount(),
      }),
      tailSeq: (conversationId) =>
        getConversationLatestSeq(eventsStore.get(conversationId)),
    };
    window.__opencursorStreamRenderPerf = control;
    return () => {
      if (window.__opencursorStreamRenderPerf === control) {
        delete window.__opencursorStreamRenderPerf;
      }
    };
  }, [eventRenderBatcher, eventsStore]);

  useEffect(
    () => () => {
      eventRenderBatcher.dispose();
    },
    [eventRenderBatcher]
  );

  const upsertConversation = useCallback(
    (conversation: AgentConversationRecord) => {
      applyConversationRecordBatchRef.current([conversation], { dispatch: false });
    },
    []
  );

  /**
   * Applies a window's worth of pushed conversation records in ONE
   * conversations-map update, ONE workspace-session fold, and ONE batched
   * window event. The server broadcasts a record update for every running
   * agent's event append; applying them one-by-one meant hundreds of full
   * context re-renders per second once many agents ran in parallel.
   */
  const applyConversationRecordBatch = useCallback(
    (
      records: AgentConversationRecord[],
      options: { dispatch: boolean }
    ) => {
      if (records.length === 0) {
        return;
      }
      const prevById = conversationsByIdRef.current;
      const applied = records.map((record) => {
        const prev = prevById[record.id];
        return { prev, merged: mergeConversationByRecency(prev, record) };
      });
      setConversationsById((current) => {
        let next = current;
        for (const record of records) {
          const merged = mergeConversationByRecency(current[record.id], record);
          if (merged === current[record.id]) {
            continue;
          }
          if (next === current) {
            next = { ...current };
          }
          next[record.id] = merged;
        }
        return next;
      });
      updateWorkspaceSession((current) => {
        let session = current;
        for (const { prev, merged } of applied) {
          session = foldWorkspaceSessionAfterConversationUpsert(session, prev, merged);
        }
        return session;
      });
      // Record pushes double as a consistency signal: for subscribed
      // conversations, a lastEventSeq ahead of the local log means live
      // frames were dropped - heal with a delta after a short grace.
      const openIds = new Set(openConversationIdsRef.current);
      for (const { merged } of applied) {
        if (!openIds.has(merged.id)) {
          continue;
        }
        const lastSeen = lastSeenSeqByConversationRef.current.get(merged.id) ?? 0;
        if (lastSeen > 0 && merged.lastEventSeq > lastSeen) {
          scheduleEventConsistencyCheck(merged.id);
        }
      }
      if (options.dispatch) {
        dispatchAgentConversationsUpsertedBatch(applied.map((entry) => entry.merged));
      }
    },
    [scheduleEventConsistencyCheck, updateWorkspaceSession]
  );
  const applyConversationRecordBatchRef = useRef(applyConversationRecordBatch);
  useEffect(() => {
    applyConversationRecordBatchRef.current = applyConversationRecordBatch;
  }, [applyConversationRecordBatch]);

  /** Pushed record updates coalesce for this long before one batched apply. */
  const pendingSocketUpsertsRef = useRef(new Map<string, AgentConversationRecord>());
  /**
   * Records pushed for OTHER workspaces: never merged into the (workspace-
   * scoped) conversations map, only dispatched so the cross-workspace rail
   * stays live without polling.
   */
  const pendingForeignUpsertsRef = useRef(new Map<string, AgentConversationRecord>());
  const socketUpsertFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSocketUpsertFlushAtRef = useRef(0);

  const flushPendingSocketUpserts = useCallback(() => {
    if (socketUpsertFlushTimerRef.current != null) {
      clearTimeout(socketUpsertFlushTimerRef.current);
      socketUpsertFlushTimerRef.current = null;
    }
    const pendingLocal = pendingSocketUpsertsRef.current;
    const pendingForeign = pendingForeignUpsertsRef.current;
    if (pendingLocal.size === 0 && pendingForeign.size === 0) {
      return;
    }
    const localRecords = [...pendingLocal.values()];
    const foreignRecords = [...pendingForeign.values()];
    pendingLocal.clear();
    pendingForeign.clear();
    lastSocketUpsertFlushAtRef.current = Date.now();
    if (localRecords.length > 0) {
      applyConversationRecordBatchRef.current(localRecords, { dispatch: true });
    }
    if (foreignRecords.length > 0) {
      dispatchAgentConversationsUpsertedBatch(foreignRecords);
    }
  }, []);

  const scheduleSocketUpsertFlush = useCallback(() => {
    if (socketUpsertFlushTimerRef.current != null) {
      return;
    }
    // Leading edge: after a quiet period the first record applies almost
    // immediately (snappy single-agent UX); under sustained load flushes
    // settle to one per window.
    const elapsed = Date.now() - lastSocketUpsertFlushAtRef.current;
    const delay = Math.max(0, CONVERSATION_UPSERT_COALESCE_MS - elapsed);
    socketUpsertFlushTimerRef.current = setTimeout(() => {
      socketUpsertFlushTimerRef.current = null;
      flushPendingSocketUpserts();
    }, delay);
  }, [flushPendingSocketUpserts]);

  const queueSocketConversationUpsert = useCallback(
    (record: AgentConversationRecord) => {
      pendingSocketUpsertsRef.current.set(record.id, record);
      scheduleSocketUpsertFlush();
    },
    [scheduleSocketUpsertFlush]
  );

  const queueForeignConversationUpsert = useCallback(
    (record: AgentConversationRecord) => {
      pendingForeignUpsertsRef.current.set(record.id, record);
      scheduleSocketUpsertFlush();
    },
    [scheduleSocketUpsertFlush]
  );

  const syncSnapshotPromisesRef = useRef(
    new Map<string, Promise<void>>()
  );

  const syncConversationSnapshot = useCallback(
    async (conversationId: string, options?: { hydrateRuntime?: boolean }) => {
      const inFlight = syncSnapshotPromisesRef.current.get(conversationId);
      if (inFlight) {
        return inFlight;
      }
      const run = (async () => {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 55_000);
        try {
          const result = await fetchAgentConversationSnapshot(conversationId, {
            ...options,
            signal: controller.signal,
          });
          mergeConversationSnapshot(result.snapshot);
        } catch (error) {
          const conv = conversationsByIdRef.current[conversationId];
          const ev = eventsStore.has(conversationId)
            ? eventsStore.get(conversationId)
            : null;
          const usable =
            Boolean(conv) &&
            (conv!.lastEventSeq === 0 || (ev != null && ev.length > 0));
          setConversationLoadStatusById((current) => ({
            ...current,
            [conversationId]: usable ? "ready" : "error",
          }));
          if (!usable) {
            throw error;
          }
        } finally {
          window.clearTimeout(timer);
        }
      })();
      syncSnapshotPromisesRef.current.set(conversationId, run);
      try {
        await run;
      } finally {
        syncSnapshotPromisesRef.current.delete(conversationId);
      }
    },
    [eventsStore, mergeConversationSnapshot]
  );

  const scheduleConversationCatchUp = useCallback(
    (conversationId: string) => {
      const delaysMs = [0, 250, 1500, 5000];
      for (const delayMs of delaysMs) {
        window.setTimeout(() => {
          const current = conversationsByIdRef.current[conversationId];
          if (!current) {
            return;
          }
          if (
            current.status !== "running" &&
            current.status !== "awaiting_permission" &&
            current.status !== "awaiting_question"
          ) {
            return;
          }
          void syncConversationSnapshot(conversationId, { hydrateRuntime: true }).catch(
            () => undefined
          );
        }, delayMs);
      }
    },
    [syncConversationSnapshot]
  );

  useEffect(() => {
    scheduleConversationCatchUpRef.current = scheduleConversationCatchUp;
  }, [scheduleConversationCatchUp]);

  const renameConversation = useCallback(
    async (conversationId: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) {
        return;
      }
      const result = await updateAgentConversationConfig(conversationId, {
        title: trimmed,
      });
      upsertConversation(result.conversation);
      dispatchAgentConversationUpserted(result.conversation);
    },
    [upsertConversation]
  );

  /**
   * Answering a permission used to refetch the FULL conversation snapshot
   * inline, replacing the whole event array in one shot while tools were still
   * streaming. On large transcripts (base64 image attachments, long tool
   * output) that parse + merge + re-render spike is exactly when low-memory
   * WebViews got killed. The `permission_resolved` event arrives over the
   * WebSocket within milliseconds anyway, so only fall back to a snapshot sync
   * when that confirmation does not show up in time.
   */
  const verifyPermissionResolutionSoon = useCallback(
    (conversationId: string, requestId: string) => {
      window.setTimeout(() => {
        const events = eventsStore.get(conversationId);
        const resolved = events.some(
          (event) =>
            event.kind === "permission_resolved" && event.requestId === requestId
        );
        if (!resolved) {
          void syncConversationSnapshot(conversationId).catch(() => undefined);
        }
      }, 2_500);
    },
    [eventsStore, syncConversationSnapshot]
  );

  const answerPermissionForConversation = useCallback(
    async (conversationId: string, requestId: string, optionId: string) => {
      try {
        await answerAgentPermission(conversationId, {
          requestId,
          optionId,
        });
        verifyPermissionResolutionSoon(conversationId, requestId);
        if (optionId === "allow_always" || optionId === "reject_always" || optionId === "acceptForSession") {
          void refreshSettings().catch(() => undefined);
        }
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
    [refreshSettings, syncConversationSnapshot, verifyPermissionResolutionSoon]
  );

  const cancelPermissionForConversation = useCallback(
    async (conversationId: string, requestId: string) => {
      try {
        await answerAgentPermission(conversationId, {
          requestId,
          cancelled: true,
        });
        verifyPermissionResolutionSoon(conversationId, requestId);
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
    [syncConversationSnapshot, verifyPermissionResolutionSoon]
  );

  const answerQuestionForConversation = useCallback(
    async (conversationId: string, questionId: string, answer: string) => {
      try {
        await answerAgentQuestion(conversationId, {
          questionId,
          answer,
        });
        const result = await fetchAgentConversationSnapshot(conversationId);
        mergeConversationSnapshot(result.snapshot);
        dispatchAgentConversationUpserted(result.snapshot.conversation);
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
    [mergeConversationSnapshot, syncConversationSnapshot]
  );

  const setConversationMode = useCallback(
    async (conversationId: string, next: EditorMode) => {
      setConversationsById((current) => {
        const conversation = current[conversationId];
        if (!conversation) {
          return current;
        }
        return {
          ...current,
          [conversationId]: {
            ...conversation,
            config: { ...conversation.config, mode: next },
          },
        };
      });
      try {
        const updated = await updateAgentConversationConfig(conversationId, {
          mode: next,
        });
        upsertConversation(updated.conversation);
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
    [syncConversationSnapshot, upsertConversation]
  );

  const setConversationModel = useCallback(
    async (conversationId: string, next: ModelInfo) => {
      const modelId = next.modelValue ?? next.id;
      setConversationsById((current) => {
        const conversation = current[conversationId];
        if (!conversation) {
          return current;
        }
        return {
          ...current,
          [conversationId]: {
            ...conversation,
            config: {
              ...conversation.config,
              modelId,
              modelName: next.name,
            },
          },
        };
      });
      try {
        const updated = await updateAgentConversationConfig(conversationId, {
          modelId,
          modelName: next.name,
          setConfigOptions: next.configSelections,
        });
        upsertConversation(updated.conversation);
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
    [syncConversationSnapshot, upsertConversation]
  );

  const setConversationBackend = useCallback(
    async (conversationId: string, nextBackendId: AgentBackendId) => {
      try {
        const result = await handoffAgentConversation(conversationId, nextBackendId);
        await syncConversationSnapshot(result.newConversationId, {
          hydrateRuntime: true,
        });
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
    [syncConversationSnapshot]
  );

  const setConversationConfigOption = useCallback(
    async (conversationId: string, configId: string, value: string) => {
      try {
        const updated = await updateAgentConversationConfig(conversationId, {
          setConfigOption: { configId, value },
        });
        upsertConversation(updated.conversation);
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
[syncConversationSnapshot, upsertConversation]
);

const setPendingConfigForConversation = useCallback(
(conversationId: string, patch: Partial<QueuedPromptConfigOverride>) => {
setPendingConfigByConversationId((current) => {
const existing = current[conversationId];
const next: QueuedPromptConfigOverride = { ...existing, ...patch };
return { ...current, [conversationId]: next };
});
},
[]
);

const clearPendingConfigForConversation = useCallback(
(conversationId: string) => {
setPendingConfigByConversationId((current) => {
if (!current[conversationId]) return current;
const next = { ...current };
delete next[conversationId];
return next;
});
},
[]
);

const executePrompt = useCallback(
    async (
      conversationId: string,
      text: string,
      attachments?: ImageAttachment[],
      configOverride?: QueuedPromptConfigOverride,
      delivery: "normal" | "steer" = "normal",
      planHandoff?: PlanBuildHandoff
    ) => {
      const startedAt = performance.now();
      const clientEventId =
        globalThis.crypto?.randomUUID?.() ?? `local-user-event-${Date.now()}`;
      const clientMessageId =
        globalThis.crypto?.randomUUID?.() ?? `local-user-message-${Date.now()}`;
      const createdAt = Date.now();
      const currentConversation = conversationsByIdRef.current[conversationId];
      const canOptimisticallyAppend =
        delivery !== "steer" &&
        currentConversation?.status !== "running" &&
        currentConversation?.status !== "awaiting_permission";
      if (canOptimisticallyAppend) {
        const optimisticConversation: AgentConversationRecord | null = currentConversation
          ? {
              ...currentConversation,
              status: "running",
              // Sending a new message always unsettles the conversation.
              settledAt: null,
              settledUntil: null,
              updatedAt: Math.max(currentConversation.updatedAt + 1, Date.now()),
            }
          : null;
        eventsStore.update(conversationId, (existing) => {
          if (existing.some((event) => event.eventId === clientEventId)) {
            return existing;
          }
          return [
            ...existing,
            {
              seq: getConversationLatestSeq(existing) + 1,
              eventId: clientEventId,
              conversationId,
              createdAt,
              kind: "user_message",
              messageId: clientMessageId,
              content: text,
              displayContent: planHandoff
                ? `Build: ${planHandoff.planTitle ?? planHandoff.planPath}`
                : undefined,
              attachments,
            },
          ];
        });
        setConversationsById((current) => {
          if (!optimisticConversation || !current[conversationId]) {
            return current;
          }
          return {
            ...current,
            [conversationId]: optimisticConversation,
          };
        });
        if (optimisticConversation) {
          dispatchAgentConversationUpserted(optimisticConversation);
          recordPerfSample("rail.position_after_prompt_optimistic", startedAt, {
            conversationId,
          });
        }
        recordPerfSample("conversation.prompt.optimistic_visible", startedAt, {
          conversationId,
        });
      }
      // A just-created conversation may not be present in React's committed
      // tab state yet. Subscribe by explicit id before starting the turn so a
      // fast provider cannot finish entirely inside that render gap.
      flushAgentSubscriptionRef.current([conversationId]);
      try {
        const snapshot = await promptAgentConversation(
          conversationId,
          text,
          attachments,
          configOverride,
          { clientEventId, clientMessageId, delivery, planHandoff }
        );
        recordPerfSample("conversation.prompt.ack", startedAt, {
          conversationId,
        });
        mergeConversationSnapshot(snapshot.snapshot);
        dispatchAgentConversationUpserted(snapshot.snapshot.conversation);
        flushAgentSubscriptionRef.current([conversationId]);
        scheduleConversationCatchUpRef.current(conversationId);
        void markWorkspaceActivity(snapshot.snapshot.conversation.workspaceId).catch(
          () => undefined
        );
        return true;
      } catch (error) {
        if (canOptimisticallyAppend) {
          eventsStore.update(conversationId, (existing) =>
            existing.filter((event) => event.eventId !== clientEventId)
          );
          if (currentConversation) {
            setConversationsById((current) => ({
              ...current,
              [conversationId]: currentConversation,
            }));
          }
        }
        const message =
          error instanceof Error ? error.message : "Failed to start the agent turn.";
        eventsStore.update(conversationId, (existing) => [
          ...existing,
          {
            seq: getConversationLatestSeq(existing) + 1,
            eventId:
              globalThis.crypto?.randomUUID?.() ?? `local-error-${Date.now()}`,
            conversationId,
            createdAt: Date.now(),
            kind: "system",
            level: "error",
            text: message,
          },
        ]);
        return false;
      }
    },
    [eventsStore, markWorkspaceActivity, mergeConversationSnapshot]
  );

  const clearEditingQueuedPromptForConversation = useCallback(
    (conversationId: string) => {
      updateWorkspaceSession((current) => {
        const map = current.chat.editingQueuedPromptIdByConversationId ?? {};
        if (!map[conversationId]) {
          return current;
        }
        const nextMap = { ...map };
        delete nextMap[conversationId];
        return {
          ...current,
          chat: {
            ...current.chat,
            editingQueuedPromptIdByConversationId: nextMap,
          },
        };
      });
    },
    [updateWorkspaceSession]
  );

  const promptConversation = useCallback(
    async (
      conversationId: string,
      text: string,
      attachments?: ImageAttachment[],
      configOverride?: QueuedPromptConfigOverride,
      delivery?: "normal" | "steer",
      planHandoff?: PlanBuildHandoff
    ) => {
      const ok = await executePrompt(
        conversationId,
        text,
        attachments,
        configOverride,
        delivery,
        planHandoff
      );
      if (ok) {
        clearEditingQueuedPromptForConversation(conversationId);
      }
      return ok;
    },
    [clearEditingQueuedPromptForConversation, executePrompt]
  );

  const setQueuedPromptDelivery = useCallback(
    async (
      conversationId: string,
      itemId: string,
      delivery: "normal" | "steer"
    ) => {
      try {
        const { conversation } = await updateAgentConversationQueueItem(
          conversationId,
          itemId,
          { delivery }
        );
        upsertConversation(conversation);
        dispatchAgentConversationUpserted(conversation);
        return true;
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
        return false;
      }
    },
    [syncConversationSnapshot, upsertConversation]
  );

  const sendQueuedPromptNow = useCallback(
    async (conversationId: string, itemId: string) => {
      if (!tryBeginQueuedPromptFlush(conversationId)) {
        return false;
      }
      const startedAt = performance.now();
      flushAgentSubscriptionRef.current([conversationId]);
      try {
        const snapshot = await sendAgentConversationQueueItem(conversationId, itemId);
        recordPerfSample("conversation.queue_send.ack", startedAt, {
          conversationId,
        });
        mergeConversationSnapshot(snapshot.snapshot);
        dispatchAgentConversationUpserted(snapshot.snapshot.conversation);
        flushAgentSubscriptionRef.current([conversationId]);
        scheduleConversationCatchUpRef.current(conversationId);
        void markWorkspaceActivity(snapshot.snapshot.conversation.workspaceId).catch(
          () => undefined
        );
        clearEditingQueuedPromptForConversation(conversationId);
        return true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to send the queued message.";
        eventsStore.update(conversationId, (existing) => [
          ...existing,
          {
            seq: getConversationLatestSeq(existing) + 1,
            eventId:
              globalThis.crypto?.randomUUID?.() ?? `local-error-${Date.now()}`,
            conversationId,
            createdAt: Date.now(),
            kind: "system",
            level: "error",
            text: message,
          },
        ]);
        return false;
      } finally {
        endQueuedPromptFlush(conversationId);
      }
    },
    [
      clearEditingQueuedPromptForConversation,
      eventsStore,
      markWorkspaceActivity,
      mergeConversationSnapshot,
    ]
  );

  const retryConversation = useCallback(
    async (conversationId: string) => {
      try {
        const snapshot = await retryAgentConversation(conversationId);
        mergeConversationSnapshot(snapshot.snapshot);
        dispatchAgentConversationUpserted(snapshot.snapshot.conversation);
        void markWorkspaceActivity(snapshot.snapshot.conversation.workspaceId).catch(
          () => undefined
        );
        return true;
      } catch {
        return false;
      }
    },
    [markWorkspaceActivity, mergeConversationSnapshot]
  );

  const createConversation = useCallback(
    async (input?: AgentConversationCreateInput) => {
      const result = await createAgentConversation(input ?? {});
      upsertConversation(result.conversation);
      dispatchAgentConversationUpserted(result.conversation);
      setConversationLoadStatusById((current) => ({
        ...current,
        [result.conversation.id]: "ready",
      }));
      return result.conversation;
    },
    [upsertConversation]
  );

  const createAndPromptConversation = useCallback(
    async (
      input: AgentConversationCreateInput,
      text: string,
      attachments?: ImageAttachment[]
    ) => {
      const startedAt = performance.now();
      const clientEventId =
        globalThis.crypto?.randomUUID?.() ?? `local-user-event-${Date.now()}`;
      const clientMessageId =
        globalThis.crypto?.randomUUID?.() ?? `local-user-message-${Date.now()}`;
      try {
        const result = await createAndPromptAgentConversation(input, text, attachments, {
          clientEventId,
          clientMessageId,
        });
        mergeConversationSnapshot(result.snapshot);
        dispatchAgentConversationUpserted(result.snapshot.conversation);
        flushAgentSubscriptionRef.current([result.snapshot.conversation.id]);
        scheduleConversationCatchUpRef.current(result.snapshot.conversation.id);
        recordPerfSample("conversation.create_and_prompt.ack", startedAt, {
          conversationId: result.snapshot.conversation.id,
        });
        void markWorkspaceActivity(result.snapshot.conversation.workspaceId).catch(
          () => undefined
        );
        return result.snapshot.conversation;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to create the agent turn.";
        console.warn("[agent] create-and-prompt failed:", message);
        return null;
      }
    },
    [markWorkspaceActivity, mergeConversationSnapshot]
  );

  const createAndPromptStandaloneConversation = useCallback(
    async (
      input: AgentConversationCreateInput,
      text: string,
      attachments?: ImageAttachment[]
    ) => {
      const startedAt = performance.now();
      const clientEventId =
        globalThis.crypto?.randomUUID?.() ?? `local-user-event-${Date.now()}`;
      const clientMessageId =
        globalThis.crypto?.randomUUID?.() ?? `local-user-message-${Date.now()}`;
      try {
        const result = await createAndPromptStandaloneAgentConversation(
          input,
          text,
          attachments,
          { clientEventId, clientMessageId }
        );
        dispatchAgentConversationUpserted(result.snapshot.conversation);
        recordPerfSample("conversation.create_and_prompt_standalone.ack", startedAt, {
          conversationId: result.snapshot.conversation.id,
        });
        return {
          conversation: result.snapshot.conversation,
          workspaceId: result.workspace.id,
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to create the standalone chat.";
        console.warn("[agent] standalone create-and-prompt failed:", message);
        return null;
      }
    },
    []
  );

  const cancelConversation = useCallback(
    async (conversationId: string) => {
      patchConversationStatus(conversationId, "cancelled");
      try {
        const result = await cancelAgentConversation(conversationId);
        upsertConversation(result.conversation);
        dispatchAgentConversationUpserted(result.conversation);
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
    [patchConversationStatus, syncConversationSnapshot, upsertConversation]
  );

  const pauseConversation = useCallback(
    async (conversationId: string) => {
      patchConversationStatus(conversationId, "pause_requested");
      try {
        const result = await pauseAgentConversation(conversationId);
        upsertConversation(result.conversation);
        dispatchAgentConversationUpserted(result.conversation);
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
    [patchConversationStatus, syncConversationSnapshot, upsertConversation]
  );

  const resumeConversation = useCallback(
    async (conversationId: string) => {
      patchConversationStatus(conversationId, "running");
      try {
        const result = await resumeAgentConversation(conversationId);
        upsertConversation(result.conversation);
        dispatchAgentConversationUpserted(result.conversation);
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
    [patchConversationStatus, syncConversationSnapshot, upsertConversation]
  );

useEffect(() => {
const pendingIds = Object.keys(pendingConfigByConversationId);
if (pendingIds.length === 0) return;
const toClear: string[] = [];
for (const id of pendingIds) {
const conv = conversationsById[id];
if (conv && !isAgentConversationBusy(conv.status) && conv.status !== "paused") {
toClear.push(id);
}
}
if (toClear.length > 0) {
setPendingConfigByConversationId((current) => {
const next = { ...current };
for (const id of toClear) {
delete next[id];
}
return next;
});
}
}, [conversationsById, pendingConfigByConversationId]);

const getConversationComposerState = useCallback(
(conversationId: string): ConversationComposerState | null => {
const conversation = conversationsById[conversationId] ?? null;
if (!conversation) {
return null;
}
const busy = isAgentComposerBusy(conversation, eventsStore.get(conversationId));
const pending = pendingConfigByConversationId[conversationId];
const effectiveConfig = busy && pending
? resolveEffectiveConfig(conversation.config, pending)
: conversation.config;
const backend = pickAvailableBackend(backends, effectiveConfig.backendId);
const models = buildConversationModelOptions(
{ ...conversation, config: effectiveConfig },
backends,
globalSettings.models.byBackend
);
const model = resolveConversationModel(
{ ...conversation, config: effectiveConfig },
backends
);
const modeOptions = buildConversationModeOptions(
{ ...conversation, config: effectiveConfig },
backends
);
const mode = resolveCanonicalModeId(
String(effectiveConfig.mode ?? ""),
modeOptions
) as EditorMode;
return {
conversation,
backendId:
effectiveConfig.backendId ??
backend?.id ??
composerDefaultsRef.current.backendId,
models,
model,
modeOptions:
modeOptions.length > 0
? modeOptions
: DEFAULT_MODE_OPTIONS,
mode,
sessionConfigOptions: listSupplementaryAgentConfigOptions(conversation),
busy,
};
},
[backends, conversationsById, eventsStore, globalSettings.models.byBackend, pendingConfigByConversationId]
  );

  const getConversationLoadStatus = useCallback(
    (conversationId: string): ConversationLoadStatus => {
      const row = conversationLoadStatusById[conversationId];
      if (row === "error") {
        return "error";
      }
      const conv = conversationsById[conversationId];
      if (!conv) {
        return row ?? "idle";
      }
      if (conv.lastEventSeq === 0) {
        return "ready";
      }
      if (eventsStore.has(conversationId)) {
        return "ready";
      }
      return "loading";
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- eventsKeysVersion re-derives readiness when a log is first loaded or dropped.
    [conversationLoadStatusById, conversationsById, eventsStore, eventsKeysVersion]
  );

  const flushAgentSubscription = useCallback((extraConversationIds: string[] = []) => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      return;
    }
    const ws = activeWorkspaceIdRef.current;
    if (!ws) {
      return;
    }
    const convMap = conversationsByIdRef.current;
    const extraIds = extraConversationIds.filter(Boolean);
    const conversationIds = [
      ...new Set([
        ...openConversationIdsRef.current
          .filter(Boolean)
          .filter((id) => convMap[id]?.workspaceId === ws),
        ...extraIds,
      ]),
    ];
    const sinceByConversationId = Object.fromEntries(
      conversationIds.map((conversationId) => {
        const tailSeq = getConversationLatestSeq(eventsStore.get(conversationId));
        // An unhealed sequence hole caps the resume cursor: subscribing from
        // the post-hole tail would replay nothing and fossilize the gap.
        const gapSince = gapSinceSeqByConversationRef.current.get(conversationId);
        return [
          conversationId,
          gapSince == null ? tailSeq : Math.min(gapSince, tailSeq),
        ];
      })
    );
    socket.send({
      type: "subscribe",
      conversationIds,
      sinceByConversationId,
    });
  }, [eventsStore]);

  useEffect(() => {
    flushAgentSubscriptionRef.current = flushAgentSubscription;
  }, [flushAgentSubscription]);

  const scheduleSubscription = useCallback(() => {
    if (subscribeDebounceTimerRef.current != null) {
      clearTimeout(subscribeDebounceTimerRef.current);
    }
    subscribeDebounceTimerRef.current = setTimeout(() => {
      subscribeDebounceTimerRef.current = null;
      flushAgentSubscription();
    }, 100);
  }, [flushAgentSubscription]);

  const refreshConversations = useCallback(async () => {
    const result = await listAgentConversations({ cache: "no-store" });
    setBackends(result.backends);
    setConversationsById(toConversationMap(result.conversations));
    return result.conversations;
  }, []);

  useEffect(() => {
    const onBackendsChanged = () => {
      void refreshModels()
        .then(() => refreshConversations())
        .catch(() => refreshConversations().catch(() => undefined));
    };
    window.addEventListener(AGENT_BACKENDS_CHANGED_EVENT, onBackendsChanged);
    return () => {
      window.removeEventListener(AGENT_BACKENDS_CHANGED_EVENT, onBackendsChanged);
    };
  }, [refreshConversations, refreshModels]);

  const forkConversation = useCallback(
    async (
      conversationId: string,
      options?: { upToMessageId?: string; beforeMessageId?: string }
    ): Promise<AgentConversationRecord> => {
      const result = await forkAgentConversation(conversationId, options);
      upsertConversation(result.conversation);
      dispatchAgentConversationUpserted(result.conversation);
      try {
        const snapshot = await fetchAgentConversationSnapshot(result.conversation.id);
        mergeConversationSnapshot(snapshot.snapshot);
      } catch {
        void syncConversationSnapshot(result.conversation.id).catch(() => undefined);
      }
      return result.conversation;
    },
    [mergeConversationSnapshot, syncConversationSnapshot, upsertConversation]
  );

  const createSideChat = useCallback(
    async (
      parentConversationId: string,
      text?: string,
      attachments?: ImageAttachment[]
    ): Promise<AgentConversationRecord> => {
      const startedAt = performance.now();
      const hasPrompt = Boolean(text?.trim()) || (attachments?.length ?? 0) > 0;
      const result = await createAgentSideChat(parentConversationId, {
        ...(hasPrompt
          ? {
              text: text ?? "",
              attachments,
              clientEventId:
                globalThis.crypto?.randomUUID?.() ?? `local-user-event-${Date.now()}`,
              clientMessageId:
                globalThis.crypto?.randomUUID?.() ?? `local-user-message-${Date.now()}`,
              clientTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }
          : {}),
      });
      mergeConversationSnapshot(result.snapshot);
      dispatchAgentConversationUpserted(result.snapshot.conversation);
      // Subscribe right away so the child's first turn streams into its tab
      // without waiting for the debounced subscription sweep.
      flushAgentSubscriptionRef.current([result.snapshot.conversation.id]);
      scheduleConversationCatchUpRef.current(result.snapshot.conversation.id);
      recordPerfSample("conversation.create_side_chat.ack", startedAt, {
        conversationId: result.snapshot.conversation.id,
      });
      void markWorkspaceActivity(result.snapshot.conversation.workspaceId).catch(
        () => undefined
      );
      return result.snapshot.conversation;
    },
    [markWorkspaceActivity, mergeConversationSnapshot]
  );

  useEffect(() => {
    eventRenderBatcher.clear();
    if (!activeWorkspaceId) {
      if (subscribeDebounceTimerRef.current != null) {
        clearTimeout(subscribeDebounceTimerRef.current);
        subscribeDebounceTimerRef.current = null;
      }
      setBackends([]);
      setConversationsById({});
      eventsStore.clear();
      lastSeenSeqByConversationRef.current.clear();
      loadedSnapshotConversationIdsRef.current.clear();
      backgroundSnapshotCooldownUntilRef.current = {};
      setConversationLoadStatusById({});
      setHistoryMetaById({});
      setLoadingOlderById({});
      loadingOlderRef.current = {};
      runtimeHydrationSignatureByIdRef.current = {};
      setBootstrapped(false);
      socketRef.current?.disconnect();
      socketRef.current = null;
      // Fresh installs run without any workspace, but the landing composer
      // still needs the backend catalog to submit standalone (no-workspace)
      // chats. `/api/agents/conversations/all` serves it workspace-free.
      let cancelled = false;
      void listCrossWorkspaceAgentConversations({ limit: 1 })
        .then((result) => {
          if (!cancelled) {
            setBackends(result.backends);
          }
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }

    let cancelled = false;
    setBootstrapped(false);
    setConversationsById({});
    eventsStore.clear();
      lastSeenSeqByConversationRef.current.clear();
    loadedSnapshotConversationIdsRef.current.clear();
    backgroundSnapshotCooldownUntilRef.current = {};
    setHistoryMetaById({});
    setLoadingOlderById({});
    loadingOlderRef.current = {};
    runtimeHydrationSignatureByIdRef.current = {};
    setConversationLoadStatusById({});

    void (async () => {
      let result: Awaited<ReturnType<typeof listAgentConversations>>;
      try {
        result = await listAgentConversations();
      } catch {
        // The active engine may not know this workspace (e.g. right after a
        // device switch, before the workspace context settles on the new
        // engine). Still refresh the backend catalog so composer pickers and
        // settings reflect the engine that is actually connected.
        const fallback = await listCrossWorkspaceAgentConversations({ limit: 1 }).catch(
          () => null
        );
        if (!cancelled && fallback) {
          setBackends(fallback.backends);
        }
        return;
      }
      if (cancelled) {
        return;
      }

      const nextConversations = result.conversations;
      setBackends(result.backends);

      setConversationsById(toConversationMap(nextConversations));
      eventsStore.clear();
      lastSeenSeqByConversationRef.current.clear();
      loadedSnapshotConversationIdsRef.current.clear();
      backgroundSnapshotCooldownUntilRef.current = {};
      setHistoryMetaById({});
      setLoadingOlderById({});
      loadingOlderRef.current = {};
      runtimeHydrationSignatureByIdRef.current = {};
      setConversationLoadStatusById(() => {
        const next: Record<string, ConversationLoadStatus> = {};
        for (const conversation of nextConversations) {
          next[conversation.id] = "ready";
        }
        return next;
      });
      const validIds = new Set(nextConversations.map((conversation) => conversation.id));
      updateWorkspaceSession((current) => {
        const pruneGroup = (tabs: typeof current.editor.leftTabs, activeId: string | null) => {
          const nextTabs = tabs.filter(
            (tab) => !tab.conversationId || validIds.has(tab.conversationId)
          );
          const nextActiveId =
            activeId && nextTabs.some((tab) => tab.id === activeId)
              ? activeId
              : nextTabs[0]?.id ?? null;
          return { nextTabs, nextActiveId };
        };

        const pruneEditorSession = (editor: typeof current.editor) => {
          const left = pruneGroup(editor.leftTabs, editor.leftActiveId);
          const right = pruneGroup(editor.rightTabs, editor.rightActiveId);
          const validTabIds = new Set([
            ...left.nextTabs.map((tab) => tab.id),
            ...right.nextTabs.map((tab) => tab.id),
          ]);
          const viewStateByTabId = Object.fromEntries(
            Object.entries(editor.viewStateByTabId).filter(([tabId]) =>
              validTabIds.has(tabId)
            )
          );
          const normalized = normalizeEditorPanelState({
            split: editor.split,
            splitOrientation: editor.splitOrientation,
            splitLayout: editor.splitLayout,
            focusedGroup: editor.focusedGroup,
            leftTabs: left.nextTabs,
            rightTabs: right.nextTabs,
            leftActiveId: left.nextActiveId,
            rightActiveId: right.nextActiveId,
            leftTabGroups: editor.leftTabGroups,
            rightTabGroups: editor.rightTabGroups,
            leftStripItems: editor.leftStripItems,
            rightStripItems: editor.rightStripItems,
          });
          const nextEditor = {
            ...normalized,
            viewStateByTabId,
          };
          const changed =
            left.nextTabs.length !== editor.leftTabs.length ||
            right.nextTabs.length !== editor.rightTabs.length ||
            left.nextActiveId !== editor.leftActiveId ||
            right.nextActiveId !== editor.rightActiveId ||
            Object.keys(editor.viewStateByTabId).length !==
              Object.keys(viewStateByTabId).length ||
            JSON.stringify(normalized.leftStripItems) !==
              JSON.stringify(editor.leftStripItems) ||
            JSON.stringify(normalized.rightStripItems) !==
              JSON.stringify(editor.rightStripItems) ||
            JSON.stringify(normalized.leftTabGroups) !==
              JSON.stringify(editor.leftTabGroups) ||
            JSON.stringify(normalized.rightTabGroups) !==
              JSON.stringify(editor.rightTabGroups);
          return { nextEditor, changed };
        };

        const { nextEditor, changed: editorChanged } = pruneEditorSession(current.editor);
        const currentSidePaneSessions =
          current.agentView.sidePaneSessionsByConversationId ?? {};
        const nextSidePaneSessions = Object.fromEntries(
          Object.entries(currentSidePaneSessions)
            .filter(
              ([scopeId]) =>
                scopeId === AGENT_NEW_CHAT_SESSION_ID || validIds.has(scopeId)
            )
            .map(([scopeId, session]) => {
              const pruned = pruneEditorSession(session.editor);
              return [
                scopeId,
                {
                  ...session,
                  editor: pruned.nextEditor,
                },
              ];
            })
        );
        const nextChatTabs = current.chat.tabs.filter((tab) => validIds.has(tab.id));
        const normalizedChatTabs =
          nextChatTabs.length === 0 || nextChatTabs.some((tab) => tab.active)
            ? nextChatTabs
            : nextChatTabs.map((tab, index) => ({ ...tab, active: index === 0 }));
        const nextHiddenConversationIds = current.chat.hiddenConversationIds.filter((id) =>
          validIds.has(id)
        );

        const sidePaneSessionsUnchanged =
          JSON.stringify(currentSidePaneSessions) === JSON.stringify(nextSidePaneSessions);
        const chatUnchanged =
          normalizedChatTabs.length === current.chat.tabs.length &&
          normalizedChatTabs.every(
            (tab, index) =>
              tab.id === current.chat.tabs[index]?.id &&
              tab.title === current.chat.tabs[index]?.title &&
              Boolean(tab.active) === Boolean(current.chat.tabs[index]?.active)
          ) &&
          nextHiddenConversationIds.length === current.chat.hiddenConversationIds.length &&
          nextHiddenConversationIds.every(
            (id, index) => id === current.chat.hiddenConversationIds[index]
          );

        return !editorChanged && sidePaneSessionsUnchanged && chatUnchanged
          ? current
          : {
              ...current,
              editor: nextEditor,
              chat: {
                ...current.chat,
                tabs: normalizedChatTabs,
                hiddenConversationIds: nextHiddenConversationIds,
              },
              agentView: {
                ...current.agentView,
                sidePaneSessionsByConversationId: nextSidePaneSessions,
              },
            };
      });
      setBootstrapped(true);
    })().catch(() => undefined);

    return () => {
      cancelled = true;
    };
    // agentSocketServerKey: refetch conversations + the backend catalog when
    // the active engine changes (device switch), even if the workspace id is
    // unchanged - otherwise pickers keep showing the previous engine's
    // harnesses.
  }, [
    activeWorkspaceId,
    agentSocketServerKey,
    eventRenderBatcher,
    eventsStore,
    updateWorkspaceSession,
  ]);

  useEffect(() => {
    if (!activeWorkspaceId || !bootstrapped) {
      return;
    }
    if (openConversationsSyncTimerRef.current != null) {
      window.clearTimeout(openConversationsSyncTimerRef.current);
    }
    openConversationsSyncTimerRef.current = window.setTimeout(() => {
      openConversationsSyncTimerRef.current = null;
      for (const conversationId of openConversationIds) {
        if (
          loadedSnapshotConversationIdsRef.current.has(conversationId) ||
          (conversationsById[conversationId] && eventsStore.has(conversationId))
        ) {
          continue;
        }
        if ((backgroundSnapshotCooldownUntilRef.current[conversationId] ?? 0) > Date.now()) {
          continue;
        }
        backgroundSnapshotCooldownUntilRef.current[conversationId] =
          Date.now() + BACKGROUND_SNAPSHOT_COOLDOWN_MS;
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    }, 80) as unknown as ReturnType<typeof setTimeout>;
    return () => {
      if (openConversationsSyncTimerRef.current != null) {
        window.clearTimeout(openConversationsSyncTimerRef.current);
        openConversationsSyncTimerRef.current = null;
      }
    };
  }, [
    activeWorkspaceId,
    bootstrapped,
    conversationsById,
    eventsStore,
    openConversationIds,
    syncConversationSnapshot,
  ]);

  useEffect(() => {
    if (!activeWorkspaceId || !bootstrapped) {
      return;
    }
    let cancelled = false;
    const list = prefetchTargetConversationIds;
    let index = 0;
    const runWorker = async () => {
      while (!cancelled && index < list.length) {
        const i = index++;
        const cid = list[i]!;
        await primeConversationSnapshotIfEmpty(cid);
      }
    };
    void Promise.all([runWorker(), runWorker()]);
    return () => {
      cancelled = true;
    };
  }, [
    activeWorkspaceId,
    bootstrapped,
    prefetchTargetConversationIds,
    primeConversationSnapshotIfEmpty,
  ]);

  useEffect(() => {
    if (!bootstrapped) {
      return;
    }
    for (const conversationId of visibleConversationIds) {
      const conversation = conversationsById[conversationId];
      if (!conversationNeedsRuntimeHydration(conversation)) {
        continue;
      }
      const signature = runtimeHydrationSignature(conversation);
      if (runtimeHydrationSignatureByIdRef.current[conversation.id] === signature) {
        continue;
      }
      if ((backgroundSnapshotCooldownUntilRef.current[conversation.id] ?? 0) > Date.now()) {
        continue;
      }
      if (hydratingConversationIdsRef.current.has(conversation.id)) {
        continue;
      }
      const cid = conversation.id;
      runtimeHydrationSignatureByIdRef.current[cid] = signature;
      backgroundSnapshotCooldownUntilRef.current[cid] =
        Date.now() + BACKGROUND_SNAPSHOT_COOLDOWN_MS;
      hydratingConversationIdsRef.current.add(cid);
      const controller = new AbortController();
      const bgTimer = window.setTimeout(() => controller.abort(), 90_000);
      void fetchAgentConversationSnapshot(cid, {
        hydrateRuntime: true,
        signal: controller.signal,
      })
        .then((result) => {
          mergeConversationSnapshot(result.snapshot);
        })
        .catch(() => undefined)
        .finally(() => {
          window.clearTimeout(bgTimer);
          hydratingConversationIdsRef.current.delete(cid);
        });
    }
  }, [bootstrapped, conversationsById, mergeConversationSnapshot, visibleConversationIds]);

  useEffect(() => {
    if (!activeWorkspaceId || !bootstrapped) {
      return;
    }

    const socket = new JsonWebSocket<AgentSocketServerMessage>(() =>
      buildAgentWebSocketUrl(activeWorkspaceId)
    );
    socketRef.current = socket;
    // These maps live for the provider's lifetime (never reassigned), so the
    // cleanup below can safely drain the same instances it captured here.
    const pendingSocketUpserts = pendingSocketUpsertsRef.current;
    const pendingForeignUpserts = pendingForeignUpsertsRef.current;
    const consistencyCheckTimers = consistencyCheckTimersRef.current;
    const deltaRequestCooldownUntil = deltaRequestCooldownUntilRef.current;
    const deltaRecovery = deltaRecoveryRef.current;

    // App-level heartbeat: protocol-level pings keep middleboxes happy but a
    // half-open TCP session (flaky Wi-Fi, mobile network handoff) leaves the
    // browser believing it is connected while nothing arrives. Any inbound
    // frame counts as liveness; a stale connected socket is force-closed so
    // the reconnect + gap-aware subscribe cursor replays what was missed.
    let lastInboundAt = Date.now();
    let lastPingAt = 0;
    const heartbeatTimer = setInterval(() => {
      if (!socket.connected) {
        // Never count reconnect downtime against the next connection.
        lastInboundAt = Date.now();
        return;
      }
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        // Hidden tabs throttle timers hard enough to fake staleness, and
        // pinging from a backgrounded mobile WebView burns radio for nothing.
        lastInboundAt = Date.now();
        return;
      }
      const now = Date.now();
      if (now - lastInboundAt > AGENT_SOCKET_STALE_MS) {
        lastInboundAt = now;
        socket.forceCloseConnection();
        return;
      }
      if (now - lastPingAt >= AGENT_SOCKET_PING_INTERVAL_MS) {
        lastPingAt = now;
        socket.send({ type: "ping" });
      }
    }, AGENT_SOCKET_HEARTBEAT_TICK_MS);

    const disposeOpen = socket.onOpen(() => {
      lastInboundAt = Date.now();
      lastPingAt = 0;
      flushAgentSubscription();
    });
    const disposeClose = socket.onClose(() => {
      loadingOlderRef.current = {};
      setLoadingOlderById({});
    });
    const disposeMessage = socket.onMessage((message) => {
      lastInboundAt = Date.now();
      const expectWs = activeWorkspaceIdRef.current;
      const scoped = agentSocketMessageWorkspaceScope(message);
      if (scoped != null && scoped !== expectWs) {
        // Cross-workspace record pushes keep the rail live without polling;
        // everything else stays scoped to the active workspace.
        if (message.type === "conversation_upserted") {
          queueForeignConversationUpsert(message.conversation);
        } else if (message.type === "conversation_deleted") {
          pendingForeignUpsertsRef.current.delete(message.conversationId);
          dispatchAgentConversationDeleted({
            conversationId: message.conversationId,
            workspaceId: message.workspaceId,
          });
        }
        return;
      }
      switch (message.type) {
        case "conversation":
        case "conversation_upserted":
          queueSocketConversationUpsert(message.conversation);
          return;
        case "conversation_deleted": {
          const deletedId = message.conversationId;
          eventRenderBatcher.discard(deletedId);
          pendingSocketUpsertsRef.current.delete(deletedId);
          lastSeenSeqByConversationRef.current.delete(deletedId);
          deltaRequestCooldownUntilRef.current.delete(deletedId);
          gapSinceSeqByConversationRef.current.delete(deletedId);
          clearDeltaRecovery(deletedId);
          const consistencyTimer = consistencyCheckTimersRef.current.get(deletedId);
          if (consistencyTimer != null) {
            clearTimeout(consistencyTimer);
            consistencyCheckTimersRef.current.delete(deletedId);
          }
          setConversationsById((current) => {
            if (!current[deletedId]) {
              return current;
            }
            const next = { ...current };
            delete next[deletedId];
            return next;
          });
          eventsStore.delete(deletedId);
          setHistoryMetaById((current) => {
            if (!current[deletedId]) {
              return current;
            }
            const next = { ...current };
            delete next[deletedId];
            return next;
          });
          setLoadingOlderById((current) => {
            if (!current[deletedId]) {
              return current;
            }
            const next = { ...current };
            delete next[deletedId];
            return next;
          });
          loadedSnapshotConversationIdsRef.current.delete(deletedId);
          delete backgroundSnapshotCooldownUntilRef.current[deletedId];
          delete runtimeHydrationSignatureByIdRef.current[deletedId];
          updateWorkspaceSession((current) => {
            const nextTabs = current.chat.tabs.filter((tab) => tab.id !== deletedId);
            if (nextTabs.length === current.chat.tabs.length) {
              return current;
            }
            const normalizedTabs =
              nextTabs.length === 0 || nextTabs.some((tab) => tab.active)
                ? nextTabs
                : nextTabs.map((tab, index) => ({ ...tab, active: index === 0 }));
            return {
              ...current,
              chat: {
                ...current.chat,
                tabs: normalizedTabs,
              },
            };
          });
          dispatchAgentConversationDeleted({
            conversationId: deletedId,
            workspaceId: message.workspaceId,
          });
          return;
        }
        case "snapshot":
          mergeConversationSnapshot(message.snapshot);
          return;
        case "snapshot_head":
          mergeConversationSnapshot(message.snapshot);
          return;
        case "history_page":
          prependHistoryPage(
            message.conversationId,
            message.events,
            message.window
          );
          return;
        case "event":
          ingestConversationEvents(message.conversationId, [message.event]);
          return;
        case "event_batch":
          ingestConversationEvents(message.conversationId, message.events);
          return;
        case "events_dropped": {
          // The server explicitly told us live frames were dropped for this
          // socket - no grace period needed, pull the delta immediately.
          const cid = message.conversationId;
          const lastSeen = lastSeenSeqByConversationRef.current.get(cid) ?? 0;
          if (lastSeen <= 0 || message.throughSeq <= lastSeen) {
            return;
          }
          recordEventGap(cid, lastSeen);
          requestEventsDelta(cid);
          return;
        }
        case "events_delta_done": {
          // Recovery ack: everything the server has in (sinceSeq, throughSeq]
          // has been replayed on this socket. Seqs still missing in that
          // range are deleted rows - stop hunting for them.
          const cid = message.conversationId;
          clearDeltaRecovery(cid);
          const ledger = lastSeenSeqByConversationRef.current;
          if (message.throughSeq > (ledger.get(cid) ?? 0)) {
            ledger.set(cid, message.throughSeq);
          }
          const gapSince = gapSinceSeqByConversationRef.current.get(cid);
          if (gapSince != null && message.sinceSeq <= gapSince) {
            gapSinceSeqByConversationRef.current.delete(cid);
          }
          return;
        }
        case "pong": {
          // Heartbeat consistency probe: the server reports the latest seq of
          // every subscribed conversation, catching holes even when all
          // droppable frames AND all record pushes were lost.
          const latestByCid = message.latestSeqByConversationId;
          if (!latestByCid) {
            return;
          }
          for (const [cid, latest] of Object.entries(latestByCid)) {
            const lastSeen = lastSeenSeqByConversationRef.current.get(cid) ?? 0;
            if (lastSeen > 0 && latest > lastSeen) {
              scheduleEventConsistencyCheck(cid, latest);
            }
          }
          return;
        }
        case "error": {
          const forConv = message.conversationId;
          if (forConv) {
            loadingOlderRef.current[forConv] = false;
            setLoadingOlderById((c) => ({ ...c, [forConv]: false }));
            return;
          }
          loadingOlderRef.current = {};
          setLoadingOlderById({});
          return;
        }
        default:
          return;
      }
    });

    socket.connect();
    return () => {
      clearInterval(heartbeatTimer);
      disposeOpen();
      disposeClose();
      disposeMessage();
      socket.disconnect();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      if (socketUpsertFlushTimerRef.current != null) {
        clearTimeout(socketUpsertFlushTimerRef.current);
        socketUpsertFlushTimerRef.current = null;
      }
      pendingSocketUpserts.clear();
      pendingForeignUpserts.clear();
      for (const timer of consistencyCheckTimers.values()) {
        clearTimeout(timer);
      }
      consistencyCheckTimers.clear();
      deltaRequestCooldownUntil.clear();
      for (const recovery of deltaRecovery.values()) {
        if (recovery.timer != null) {
          clearTimeout(recovery.timer);
        }
      }
      deltaRecovery.clear();
    };
  }, [
    activeWorkspaceId,
    agentSocketServerKey,
    bootstrapped,
    clearDeltaRecovery,
    eventRenderBatcher,
    eventsStore,
    flushAgentSubscription,
    ingestConversationEvents,
    mergeConversationSnapshot,
    prependHistoryPage,
    queueForeignConversationUpsert,
    queueSocketConversationUpsert,
    recordEventGap,
    requestEventsDelta,
    scheduleEventConsistencyCheck,
    updateWorkspaceSession,
  ]);

  useEffect(() => {
    if (!activeWorkspaceId || !bootstrapped) {
      return;
    }
    scheduleSubscription();
    return () => {
      if (subscribeDebounceTimerRef.current != null) {
        clearTimeout(subscribeDebounceTimerRef.current);
        subscribeDebounceTimerRef.current = null;
      }
    };
  }, [activeWorkspaceId, bootstrapped, openConversationIds, scheduleSubscription]);

  const value = useMemo<AgentConversationsContextValue>(
    () => ({
      backends,
      conversationsById,
      conversations,
      conversationEventsStore: eventsStore,
      getConversationEvents: (conversationId: string) =>
        eventsStore.get(conversationId),
      bootstrapped,
      getConversationLoadStatus,
      createConversation,
      createAndPromptConversation,
      createAndPromptStandaloneConversation,
      renameConversation,
      upsertConversation,
      answerPermissionForConversation,
      cancelPermissionForConversation,
      answerQuestionForConversation,
      setConversationMode,
      setConversationModel,
      setConversationBackend,
      setConversationConfigOption,
      promptConversation,
      sendQueuedPromptNow,
      setQueuedPromptDelivery,
      retryConversation,
      cancelConversation,
      pauseConversation,
      resumeConversation,
getConversationComposerState,
syncConversationSnapshot,
flushAgentSubscription,
mergeConversationSnapshot,
refreshConversations,
forkConversation,
createSideChat,
getConversationHistoryCursor,
loadOlderConversationHistory,
pendingConfigByConversationId,
setPendingConfigForConversation,
clearPendingConfigForConversation,
}),
[
backends,
bootstrapped,
cancelConversation,
cancelPermissionForConversation,
answerQuestionForConversation,
clearPendingConfigForConversation,
createSideChat,
createConversation,
createAndPromptConversation,
createAndPromptStandaloneConversation,
conversations,
conversationsById,
eventsStore,
forkConversation,
getConversationLoadStatus,
getConversationComposerState,
mergeConversationSnapshot,
pendingConfigByConversationId,
promptConversation,
sendQueuedPromptNow,
setQueuedPromptDelivery,
pauseConversation,
resumeConversation,
retryConversation,
refreshConversations,
renameConversation,
upsertConversation,
setConversationBackend,
setConversationConfigOption,
setConversationMode,
setConversationModel,
setPendingConfigForConversation,
syncConversationSnapshot,
flushAgentSubscription,
answerPermissionForConversation,
getConversationHistoryCursor,
loadOlderConversationHistory,
]
  );

  return (
    <AgentConversationsContext.Provider value={value}>
      {children}
    </AgentConversationsContext.Provider>
  );
}

export function useOptionalAgentConversations(): AgentConversationsContextValue | null {
  return useContext(AgentConversationsContext);
}

export function useAgentConversations(): AgentConversationsContextValue {
  const context = useOptionalAgentConversations();
  if (!context) {
    throw new Error(
      "useAgentConversations must be used within AgentConversationsProvider"
    );
  }
  return context;
}

/**
 * Subscribe to a single conversation's event log. Re-renders only when THAT
 * conversation's events change; streams from other agents leave the component
 * untouched. Pass a falsy id (or render outside the provider) to opt out -
 * both return a stable empty array.
 */
export function useConversationEvents(
  conversationId: string | null | undefined
): AgentStoredEvent[] {
  const store = useOptionalAgentConversations()?.conversationEventsStore ?? null;
  return useSyncExternalStore(
    useCallback(
      (onChange) =>
        store && conversationId
          ? store.subscribe(conversationId, onChange)
          : () => {},
      [store, conversationId]
    ),
    () =>
      store && conversationId
        ? store.get(conversationId)
        : EMPTY_CONVERSATION_EVENTS,
    () => EMPTY_CONVERSATION_EVENTS
  );
}
