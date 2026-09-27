import { resolveModelDisplayName } from "@cesium/core/model-display-name";
import type { ProjectAgentDelivery, ProjectAgentIsolation } from "@cesium/core/projects";
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
import {
  createStandaloneChatWorkspace,
  removeStandaloneChatWorkspace,
} from "../standalone-chats.js";
import {
  ensureWorkspaceRegistered,
  getWorkspaceById,
  type WorkspaceRecord,
} from "../workspace-registry.js";
import { ProjectError } from "./errors.js";
import {
  buildWorkerBrief,
  type WorkerBriefInput,
  type WorkerPlacementFacts,
} from "./worker-brief.js";
import {
  WorkerIsolationError,
  WorkerPlacementError,
  createWorkerWorktree,
  inspectWorkerRepo,
  isWorkerWorktreeRoot,
  removeWorkerWorktree,
} from "./worktrees.js";

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
  /** Turns that finished inside the window; several when polling folds turns together. */
  turnsEnded: number;
  replyPreview: string | null;
};

export type ChildPlacement =
  /** The repository checkout itself. */
  | { kind: "workspace"; workspaceId: string }
  | { kind: "root"; root: string }
  | { kind: "scratch"; label: string }
  /**
   * A fresh worktree and branch from the repository's base branch. With
   * `fallbackToCheckout`, a repository that is not a git repo is used as is.
   */
  | {
      kind: "worktree";
      workspaceId: string;
      branch: string;
      baseBranch: string | null;
      fallbackToCheckout: boolean;
    };

export type ChildCreateInput = {
  projectId: string;
  childId: string;
  name: string;
  /** The worker contract; the hosting engine completes it with where the worker landed. */
  brief?: WorkerBriefInput;
  /** Prebuilt first-turn text, for callers that don't send a brief. */
  promptText?: string;
  /** What the thread shows for the first turn. */
  displayText: string;
  placement: ChildPlacement;
  backendId?: string | null;
  modelId?: string | null;
  mode?: string | null;
  peerTokenId?: string | null;
  homeLabel?: string;
  /** The hosting engine's name as the Project's home knows it, for messages. */
  engineLabel?: string;
};

export type ChildCreateResult = ChildRef & {
  backendId: string;
  modelId: string | null;
  mode: string;
  /** Set by a peer that started the agent on another model than asked. */
  modelWarning?: string | null;
  isolation: ProjectAgentIsolation;
  branch: string | null;
  baseRef: string | null;
  baseSha: string | null;
  worktreePath: string | null;
  /** `owner/repo` of the worker's `origin` when it is on GitHub. */
  githubRepo?: string | null;
  /** Placement caveat, e.g. a fetch that failed or a folder that is not a git repo. */
  placementWarning?: string | null;
};

export type ChildUpdatePatch = {
  title?: string;
  modelId?: string;
  mode?: string;
  engineLabel?: string;
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
    turnsEnded: countTurnsEnded(fresh),
    replyPreview: reply ? truncate(reply, REPLY_PREVIEW_MAX_CHARS) : null,
  };
}

/**
 * Steers never open a turn: harnesses label them `Steer: ` and some (Codex)
 * close intermediate assistant messages mid-turn, so only a plain user
 * message after a closed reply marks a turn boundary.
 */
function countTurnsEnded(events: readonly AgentStoredEvent[]): number {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  let turnsEnded = 0;
  let replyClosed = false;
  for (const event of ordered) {
    if (event.kind === "user_message") {
      if (event.hidden || event.displayContent?.startsWith("Steer: ")) {
        continue;
      }
      if (replyClosed) {
        turnsEnded += 1;
      }
      replyClosed = false;
    } else if (event.kind === "assistant_message_end" && event.stopReason !== "steered") {
      replyClosed = true;
    }
  }
  return replyClosed ? turnsEnded + 1 : turnsEnded;
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

type Placement = {
  workspace: WorkspaceRecord;
  facts: WorkerPlacementFacts;
  /** True when the Project created the workspace (a worktree or sandbox) and must clean it up. */
  ownsWorkspace: boolean;
  githubRepo: string | null;
};

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

  private async checkoutPlacement(
    workspace: WorkspaceRecord,
    warning: string | null = null
  ): Promise<Placement> {
    const git = await inspectWorkerRepo(workspace.root);
    return {
      workspace,
      ownsWorkspace: false,
      githubRepo: git.githubRepo,
      facts: {
        isolation: "checkout",
        root: workspace.root,
        branch: null,
        baseRef: null,
        baseSha: null,
        hasOrigin: git.hasOrigin,
        setup: null,
        warning,
      },
    };
  }

  private async place(input: ChildCreateInput): Promise<Placement> {
    const placement = input.placement;
    switch (placement.kind) {
      case "workspace": {
        const workspace = await getWorkspaceById(placement.workspaceId);
        if (!workspace) {
          throw new ProjectError(`Unknown workspace: ${placement.workspaceId}`);
        }
        return this.checkoutPlacement(workspace);
      }
      case "root":
        return this.checkoutPlacement(
          await ensureWorkspaceRegistered(placement.root, undefined, { trackOpen: false })
        );
      case "scratch": {
        const workspace = await createStandaloneChatWorkspace(placement.label);
        return {
          workspace,
          ownsWorkspace: true,
          githubRepo: null,
          facts: {
            isolation: "scratch",
            root: workspace.root,
            branch: null,
            baseRef: null,
            baseSha: null,
            hasOrigin: false,
            setup: null,
            warning: null,
          },
        };
      }
      case "worktree": {
        const repoWorkspace = await getWorkspaceById(placement.workspaceId);
        if (!repoWorkspace) {
          throw new ProjectError(`Unknown workspace: ${placement.workspaceId}`);
        }
        try {
          const worktree = await createWorkerWorktree({
            projectId: input.projectId,
            repoWorkspace,
            branch: placement.branch,
            baseBranch: placement.baseBranch,
            label: `${repoWorkspace.name} · ${input.name}`,
          });
          return {
            workspace: worktree.workspace,
            ownsWorkspace: true,
            githubRepo: worktree.githubRepo,
            facts: {
              isolation: "worktree",
              root: worktree.worktreePath,
              branch: worktree.branch,
              baseRef: worktree.baseRef,
              baseSha: worktree.baseSha,
              hasOrigin: worktree.hasOrigin,
              setup: worktree.setup,
              warning: worktree.warning,
            },
          };
        } catch (error) {
          if (error instanceof WorkerIsolationError) {
            if (placement.fallbackToCheckout) {
              return this.checkoutPlacement(repoWorkspace, `${error.message} It works in the folder itself.`);
            }
            throw new ProjectError(error.message);
          }
          if (error instanceof WorkerPlacementError) {
            throw new ProjectError(error.message);
          }
          throw error;
        }
      }
    }
  }

  async create(input: ChildCreateInput): Promise<ChildCreateResult> {
    const { workspace, facts, ownsWorkspace, githubRepo } = await this.place(input);
    const modelId = input.modelId?.trim() || undefined;
    const promptText = input.brief ? buildWorkerBrief(input.brief, facts) : input.promptText?.trim();
    if (!promptText) {
      throw new ProjectError("A Project agent needs a brief or prompt text.");
    }
    let head: Awaited<ReturnType<typeof agentRuntimeManager.createConversationWithPrompt>>;
    try {
      head = await agentRuntimeManager.createConversationWithPrompt(
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
        { text: promptText, displayContent: input.displayText }
      );
    } catch (error) {
      if (ownsWorkspace) {
        await this.disposeWorkspace(workspace).catch(() => undefined);
      }
      throw error;
    }
    const conversation = head.conversation;
    return {
      workspaceId: workspace.id,
      conversationId: conversation.id,
      backendId: conversation.config.backendId,
      modelId: conversation.config.modelId || null,
      mode: conversation.config.mode,
      isolation: facts.isolation,
      branch: facts.branch,
      baseRef: facts.baseRef,
      baseSha: facts.baseSha,
      worktreePath: facts.isolation === "worktree" ? facts.root : null,
      githubRepo,
      placementWarning: facts.warning,
    };
  }

  /** Removes what the Project created for a child: its worktree or its scratch sandbox. */
  private async disposeWorkspace(workspace: WorkspaceRecord): Promise<void> {
    if (isWorkerWorktreeRoot(workspace.root)) {
      await removeWorkerWorktree(workspace);
      return;
    }
    await removeStandaloneChatWorkspace(workspace.id);
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

  /**
   * Deletes the conversation and what the Project created for it: the worker's
   * worktree (its branch stays) or its scratch sandbox. A repository checkout
   * is never touched.
   */
  async delete(ref: ChildRef): Promise<void> {
    const workspace = await getWorkspaceById(ref.workspaceId);
    if (!workspace) {
      return;
    }
    await agentRuntimeManager.deleteConversation(workspace, ref.conversationId);
    await this.disposeWorkspace(workspace);
  }
}
