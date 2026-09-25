import { resolveModelDisplayName } from "@cesium/core/model-display-name";
import type { ProjectAgentDelivery } from "@cesium/core/projects";
import { agentRuntimeManager } from "../agents/runtime-manager.js";
import {
  readConversationRecord,
  readRecentConversationEvents,
} from "../agents/session-store.js";
import type {
  AgentBackendId,
  AgentConversationRecord,
  AgentConversationStatus,
  AgentStoredEvent,
} from "../agents/types.js";
import { createStandaloneChatWorkspace } from "../standalone-chats.js";
import {
  ensureWorkspaceRegistered,
  getWorkspaceById,
  type WorkspaceRecord,
} from "../workspace-registry.js";

export const TRANSCRIPT_DEFAULT_TURNS = 3;
export const TRANSCRIPT_MAX_TURNS = 20;
export const TRANSCRIPT_MAX_CHARS = 24_000;
const REPLY_PREVIEW_MAX_CHARS = 1_200;
const TRANSCRIPT_USER_MAX_CHARS = 2_000;
const TRANSCRIPT_TOOL_DETAIL_MAX_CHARS = 200;

export type ChildRef = { workspaceId: string; conversationId: string };

export type ChildAttentionObservation = {
  id: string;
  kind: "permission" | "question";
  title: string;
};

/** Point-in-time view of a child conversation, as the watcher and tools see it. */
export type ChildObservation = {
  exists: boolean;
  status: AgentConversationStatus | "unknown";
  lastEventSeq: number;
  queued: number;
  attention: ChildAttentionObservation | null;
  lastError: string | null;
  backendId: string | null;
  modelId: string | null;
  modelName: string | null;
  mode: string | null;
  title: string | null;
  updatedAt: number | null;
};

export type ChildTurnDigest = {
  /** True when a visible user message or assistant reply landed inside the window. */
  hadTurn: boolean;
  /** True when a visible user message (the start of a turn) landed inside the window. */
  startedTurn: boolean;
  replyPreview: string | null;
};

export type ChildCreateInput = {
  projectId: string;
  childId: string;
  name: string;
  /** Full first-turn text the model receives (brief plus instructions). */
  promptText: string;
  /** What the thread shows for the first turn. */
  displayText: string;
  placement:
    | { kind: "workspace"; workspaceId: string }
    | { kind: "root"; root: string }
    | { kind: "scratch"; label: string };
  backendId?: string | null;
  modelId?: string | null;
  mode?: string | null;
  peerTokenId?: string | null;
  homeLabel?: string;
};

export type ChildCreateResult = ChildRef & {
  backendId: string;
  modelId: string | null;
  mode: string;
};

export type ChildUpdatePatch = {
  title?: string;
  modelId?: string;
  mode?: string;
};

/** Everything the Project layer needs from an engine that hosts children. */
export interface ChildHost {
  readonly engineId: string;
  create(input: ChildCreateInput): Promise<ChildCreateResult>;
  observe(ref: ChildRef): Promise<ChildObservation>;
  /** Summarizes events with `afterSeq < seq <= throughSeq`. */
  digestSince(ref: ChildRef, afterSeq: number, throughSeq: number): Promise<ChildTurnDigest>;
  transcript(ref: ChildRef, turns: number): Promise<string>;
  message(ref: ChildRef, text: string, delivery: "steer" | "queue"): Promise<ProjectAgentDelivery>;
  stop(ref: ChildRef): Promise<void>;
  update(ref: ChildRef, patch: ChildUpdatePatch): Promise<void>;
  delete(ref: ChildRef): Promise<void>;
}

export const MISSING_CHILD_OBSERVATION: ChildObservation = {
  exists: false,
  status: "unknown",
  lastEventSeq: 0,
  queued: 0,
  attention: null,
  lastError: null,
  backendId: null,
  modelId: null,
  modelName: null,
  mode: null,
  title: null,
  updatedAt: null,
};

export function observeConversationRecord(record: AgentConversationRecord): ChildObservation {
  const attention: ChildAttentionObservation | null = record.pendingPermission
    ? {
        id: record.pendingPermission.requestId,
        kind: "permission",
        title: record.pendingPermission.title?.trim() || "Permission requested",
      }
    : record.pendingQuestion
      ? { id: record.pendingQuestion.questionId, kind: "question", title: "Question for you" }
      : null;
  return {
    exists: true,
    status: record.status,
    lastEventSeq: record.lastEventSeq,
    queued: record.queuedPrompts?.length ?? 0,
    attention,
    lastError: record.lastError,
    backendId: record.config.backendId,
    modelId: record.config.modelId || null,
    modelName: record.config.modelName || null,
    mode: record.config.mode || null,
    title: record.title,
    updatedAt: record.updatedAt,
  };
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

type UserMessageEvent = Extract<AgentStoredEvent, { kind: "user_message" }>;

function visibleUserText(event: UserMessageEvent): string {
  return (event.displayContent?.trim() || event.content).trim();
}

/** Last assistant reply text in `events` (the final message of the last turn). */
export function lastAssistantReply(events: readonly AgentStoredEvent[]): string | null {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  let current: string[] = [];
  let last: string | null = null;
  for (const event of ordered) {
    if (event.kind === "user_message") {
      current = [];
    } else if (event.kind === "assistant_message_chunk") {
      current.push(event.text);
    } else if (event.kind === "assistant_message_end") {
      const text = current.join("").trim();
      if (text) {
        last = text;
      }
      current = [];
    }
  }
  const pending = current.join("").trim();
  return pending || last;
}

export function digestEventsSince(
  events: readonly AgentStoredEvent[],
  afterSeq: number,
  throughSeq: number
): ChildTurnDigest {
  const fresh = events.filter((event) => event.seq > afterSeq && event.seq <= throughSeq);
  const startedTurn = fresh.some((event) => event.kind === "user_message" && !event.hidden);
  const hadTurn =
    startedTurn ||
    fresh.some(
      (event) =>
        event.kind === "assistant_message_chunk" || event.kind === "assistant_message_end"
    );
  const reply = lastAssistantReply(fresh);
  return {
    hadTurn,
    startedTurn,
    replyPreview: reply ? truncate(reply, REPLY_PREVIEW_MAX_CHARS) : null,
  };
}

/**
 * Compact, model-facing transcript of the last `turns` user turns. Keeps the
 * tail when it exceeds `maxChars` because the latest work matters most.
 */
export function formatProjectTranscript(
  events: readonly AgentStoredEvent[],
  turns: number,
  maxChars = TRANSCRIPT_MAX_CHARS
): string {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const userIndexes: number[] = [];
  ordered.forEach((event, index) => {
    if (event.kind === "user_message" && !event.hidden) {
      userIndexes.push(index);
    }
  });
  const startIndex =
    userIndexes.length > turns ? userIndexes[userIndexes.length - turns]! : 0;
  const lines: string[] = [];
  let assistant: string[] = [];
  const flushAssistant = () => {
    const text = assistant.join("").trim();
    if (text) {
      lines.push(`Assistant: ${text}`);
    }
    assistant = [];
  };
  for (const event of ordered.slice(startIndex)) {
    switch (event.kind) {
      case "user_message":
        if (event.hidden) {
          break;
        }
        flushAssistant();
        lines.push("", `User: ${truncate(visibleUserText(event), TRANSCRIPT_USER_MAX_CHARS)}`);
        break;
      case "assistant_message_chunk":
        assistant.push(event.text);
        break;
      case "assistant_message_end":
        flushAssistant();
        break;
      case "tool_call": {
        flushAssistant();
        const detail = event.detail?.trim()
          ? ` - ${truncate(event.detail, TRANSCRIPT_TOOL_DETAIL_MAX_CHARS)}`
          : "";
        lines.push(`[Tool: ${event.title}${detail}]`);
        break;
      }
      case "tool_call_update":
        if (event.status === "failed") {
          flushAssistant();
          lines.push(`[Tool failed: ${(event.title ?? "tool").trim()}]`);
        }
        break;
      case "question":
        flushAssistant();
        lines.push(`[Question ${event.status}: ${truncate(event.prompt, 400)}]`);
        break;
      case "permission_request":
        flushAssistant();
        lines.push(`[Permission requested: ${(event.title ?? "permission").trim()}]`);
        break;
      case "permission_resolved":
        lines.push(`[Permission ${event.outcome}]`);
        break;
      case "status":
        if (event.status === "failed") {
          flushAssistant();
          lines.push(`[Turn failed${event.detail ? `: ${truncate(event.detail, 400)}` : ""}]`);
        } else if (event.status === "cancelled") {
          flushAssistant();
          lines.push("[Turn stopped]");
        }
        break;
      default:
        break;
    }
  }
  flushAssistant();
  const text = lines.join("\n").trim();
  if (!text) {
    return "(no messages yet)";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `[…earlier transcript truncated]\n${text.slice(text.length - maxChars)}`;
}

/** Children hosted by this engine, driven through the local runtime manager. */
export class LocalChildHost implements ChildHost {
  constructor(readonly engineId: string) {}

  private async workspaceFor(ref: ChildRef): Promise<WorkspaceRecord> {
    const workspace = await getWorkspaceById(ref.workspaceId);
    if (!workspace) {
      throw new Error(`Child workspace ${ref.workspaceId} no longer exists on this engine.`);
    }
    return workspace;
  }

  private async resolvePlacement(input: ChildCreateInput): Promise<WorkspaceRecord> {
    switch (input.placement.kind) {
      case "workspace": {
        const workspace = await getWorkspaceById(input.placement.workspaceId);
        if (!workspace) {
          throw new Error(`Unknown workspace: ${input.placement.workspaceId}`);
        }
        return workspace;
      }
      case "root":
        return ensureWorkspaceRegistered(input.placement.root, undefined, { trackOpen: false });
      case "scratch":
        return createStandaloneChatWorkspace(input.placement.label);
    }
  }

  async create(input: ChildCreateInput): Promise<ChildCreateResult> {
    const workspace = await this.resolvePlacement(input);
    const modelId = input.modelId?.trim() || undefined;
    const head = await agentRuntimeManager.createConversationWithPrompt(
      workspace,
      {
        title: input.name,
        ...(input.backendId ? { backendId: input.backendId as AgentBackendId } : {}),
        ...(modelId ? { modelId, modelName: resolveModelDisplayName(null, modelId) } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        origin: {
          kind: "project-child",
          projectId: input.projectId,
          childId: input.childId,
          peerTokenId: input.peerTokenId ?? null,
          ...(input.homeLabel ? { homeLabel: input.homeLabel } : {}),
          createdAt: Date.now(),
        },
      },
      { text: input.promptText, displayContent: input.displayText }
    );
    const conversation = head.conversation;
    return {
      workspaceId: workspace.id,
      conversationId: conversation.id,
      backendId: conversation.config.backendId,
      modelId: conversation.config.modelId || null,
      mode: conversation.config.mode,
    };
  }

  async observe(ref: ChildRef): Promise<ChildObservation> {
    const record = await readConversationRecord(ref.workspaceId, ref.conversationId);
    return record ? observeConversationRecord(record) : MISSING_CHILD_OBSERVATION;
  }

  async digestSince(ref: ChildRef, afterSeq: number, throughSeq: number): Promise<ChildTurnDigest> {
    const events = await readRecentConversationEvents(ref.workspaceId, ref.conversationId, 3);
    return digestEventsSince(events, afterSeq, throughSeq);
  }

  async transcript(ref: ChildRef, turns: number): Promise<string> {
    const record = await readConversationRecord(ref.workspaceId, ref.conversationId);
    if (!record) {
      throw new Error("This agent's conversation no longer exists.");
    }
    const events = await readRecentConversationEvents(ref.workspaceId, ref.conversationId, turns);
    return formatProjectTranscript(events, turns);
  }

  async message(
    ref: ChildRef,
    text: string,
    delivery: "steer" | "queue"
  ): Promise<ProjectAgentDelivery> {
    const workspace = await this.workspaceFor(ref);
    const { outcome } = await agentRuntimeManager.deliverPrompt(
      workspace,
      ref.conversationId,
      text,
      { delivery, midTurnSteer: delivery === "steer" }
    );
    return outcome;
  }

  async stop(ref: ChildRef): Promise<void> {
    const workspace = await this.workspaceFor(ref);
    await agentRuntimeManager.cancelConversation(workspace, ref.conversationId);
  }

  async update(ref: ChildRef, patch: ChildUpdatePatch): Promise<void> {
    const workspace = await this.workspaceFor(ref);
    const modelId = patch.modelId?.trim();
    await agentRuntimeManager.updateConversationConfig(workspace, ref.conversationId, {
      ...(patch.title?.trim() ? { title: patch.title.trim() } : {}),
      ...(modelId ? { modelId, modelName: resolveModelDisplayName(null, modelId) } : {}),
      ...(patch.mode?.trim() ? { mode: patch.mode.trim() } : {}),
    });
  }

  async delete(ref: ChildRef): Promise<void> {
    const workspace = await getWorkspaceById(ref.workspaceId);
    if (!workspace) {
      return;
    }
    await agentRuntimeManager.deleteConversation(workspace, ref.conversationId);
  }
}
