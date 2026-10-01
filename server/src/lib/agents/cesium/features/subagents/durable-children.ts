/**
 * Subagents backed by durable child conversations. Each spawned agent is a
 * real Cesium conversation (origin `subagent`) with its own event log, so it
 * keeps its full history across turns, survives a server restart, and every
 * request it sends is a pure append. The parent keeps the mailbox ergonomics
 * (spawn, send, follow up, wait, interrupt, list, read) and sees each child as
 * a `subagent` card that follows the child's progress.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../../../persistence.js";
import type { WorkspaceRecord } from "../../../../workspace-registry.js";
import { generateTranscriptFromEvents } from "../../../event-log-read.js";
import { asNumber } from "../../../json-coerce.js";
import {
  appendConversationEvents,
  listWorkspaceConversationRecords,
  readConversationEventsSince,
  readConversationRecord,
  readRecentConversationEvents,
  subscribeAgentStoreEvents,
} from "../../../session-store.js";
import { childReport, markChildReported } from "../../../child-reports.js";
import { conversationWake, type StoreWake } from "../../../store-wakes.js";
import type { AgentConversationRecord, AgentStoredEvent } from "../../../types.js";
import { asString } from "../../cesium-coerce.js";
import { resolveWaitAgentTimeoutMs } from "../limits.js";
import type { CesiumHarnessLimits } from "../types.js";

export type SubagentOrigin = Extract<NonNullable<AgentConversationRecord["origin"]>, { kind: "subagent" }>;

export type DurableSubagentsOptions = {
  workspace: WorkspaceRecord;
  /** The conversation whose agent spawns children. */
  conversationId: string;
  /** This conversation's agent path: /root, or its own path when it is itself a child. */
  parentPath: string;
  limits: () => CesiumHarnessLimits;
  /** The parent's current model, which children inherit. */
  resolveDefaultModelId: () => string;
  /** Validates a model override against Model access. */
  resolveSpawnModel: (requested: string | undefined, defaultModelId: string) => Promise<string>;
  /** Writes the parent's `subagent` cards. */
  appendEvents: (events: Array<Record<string, unknown>>) => Promise<void>;
  /** The parent's conversation as text, for a forked child: everything, or the newest `turns` turns. */
  parentTranscript: (turns: number | "all") => Promise<string>;
  isCancelled: () => boolean;
  /** Aborts when the parent's turn is stopped, so a wait ends at once. */
  cancelSignal?: () => AbortSignal | undefined;
};

type ChildRef = {
  conversationId: string;
  path: string;
  taskName: string;
  title: string;
  modelId: string;
  /** Id of the parent's card for this child; the blocking `subagent` tool uses its tool call id so the two merge. */
  cardId?: string;
};

type ChildState = "running" | "needs_attention" | "completed" | "errored" | "interrupted";

/** A card re-emits on every state change, and at most this often while the child only makes progress. */
const CARD_PROGRESS_MIN_MS = 1000;
/** Recent messages (with their tool calls) a card and a wait summary look at. */
const CARD_RECENT_MESSAGES = 8;
const FORK_TRANSCRIPT_MAX_CHARS = 60_000;

export function sanitizeTaskName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_/-]+/g, "_")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
  const segment = cleaned.includes("/") ? cleaned.split("/").pop()! : cleaned;
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(segment)) {
    throw new Error("spawn_agent.task_name must be snake_case starting with a letter (max 64 chars).");
  }
  return segment;
}

/** Spawn depth of a canonical path: /root = 0, /root/a = 1, /root/a/b = 2. */
export function spawnDepthOf(agentPath: string): number {
  return Math.max(0, agentPath.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).length - 1);
}

export function childState(record: AgentConversationRecord): ChildState {
  switch (record.status) {
    case "idle":
      return (record.queuedPrompts?.length ?? 0) > 0 ? "running" : "completed";
    case "failed":
      return "errored";
    case "cancelled":
    case "interrupted":
      return "interrupted";
    case "awaiting_permission":
    case "awaiting_question":
      return "needs_attention";
    default:
      return "running";
  }
}

/**
 * Whether a child has news for its parent: a turn that started or ended past
 * what the parent was told. Events without a turn (cards of the child's own
 * children, status lines) and the tail of a stop the parent caused are not
 * news; they are marked reported quietly.
 */
export async function childHasNews(record: AgentConversationRecord): Promise<boolean> {
  const report = await childReport(record);
  if (record.lastEventSeq <= report.reportedSeq) return false;
  const quiet = async () => {
    await markChildReported(record.id, record.lastEventSeq);
    return false;
  };
  if (report.quiet && childState(record) === "interrupted") return quiet();
  const since = await readConversationEventsSince(record.workspaceId, record.id, report.reportedSeq).catch(
    () => [] as AgentStoredEvent[]
  );
  const hadTurn = since.some((event) => event.kind === "user_message" || event.kind === "assistant_message_end");
  return hadTurn ? true : quiet();
}

function cardStatus(state: ChildState): "running" | "completed" | "failed" {
  return state === "completed" ? "completed" : state === "running" || state === "needs_attention" ? "running" : "failed";
}

/** The child's newest reply: the text of its last finished assistant message. */
export function lastReply(events: AgentStoredEvent[]): string {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let text = "";
  let current = "";
  for (const event of sorted) {
    if (event.kind === "assistant_message_chunk") {
      current += event.text;
    } else if (event.kind === "assistant_message_end") {
      if (event.stopReason !== "discarded" && current.trim()) text = current.trim();
      current = "";
    } else if (event.kind === "user_message") {
      current = "";
    }
  }
  return text || current.trim();
}

function attentionDetail(record: AgentConversationRecord): string | null {
  if (record.status === "awaiting_permission") {
    return `waiting for permission: ${record.pendingPermission?.title ?? "a tool call"}`;
  }
  if (record.status === "awaiting_question") {
    return "waiting for an answer to a question";
  }
  return null;
}

/** First message a child gets: who it is, then the task in the mailbox format. */
export function childTaskText(input: {
  path: string;
  title: string;
  parentConversationId: string;
  from: string;
  message: string;
  canSpawn: boolean;
  queued?: Array<{ from: string; message: string }>;
  first: boolean;
}): string {
  const intro = input.first
    ? [
        `You are subagent ${input.path} ("${input.title}"), started by the agent of conversation ${input.parentConversationId}.`,
        "Work on the task below, then end your turn with a clear final summary of what you found or did; that summary is what your parent reads.",
        input.canSpawn ? "" : "Do not spawn subagents of your own.",
      ]
        .filter(Boolean)
        .join(" ")
    : null;
  const messages = [
    ...(input.queued ?? []).map((entry) =>
      ["Message Type: MESSAGE", `Task name: ${input.path}`, `Sender: ${entry.from}`, "Payload:", entry.message].join("\n")
    ),
    ["Message Type: NEW_TASK", `Task name: ${input.path}`, `Sender: ${input.from}`, "Payload:", input.message].join("\n"),
  ];
  return [intro, ...messages].filter(Boolean).join("\n\n");
}

async function agentRuntime() {
  const { agentRuntimeManager } = await import("../../../runtime-manager.js");
  return agentRuntimeManager;
}

function mailboxFile(childConversationId: string): string {
  return path.join(DATA_DIR, "subagent-mailbox", `${childConversationId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

async function readMailbox(childConversationId: string): Promise<Array<{ from: string; message: string; createdAt: number }>> {
  try {
    const parsed = JSON.parse(await fs.readFile(mailboxFile(childConversationId), "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as Array<{ from: string; message: string; createdAt: number }>) : [];
  } catch {
    return [];
  }
}

export class DurableSubagents {
  private children: Map<string, ChildRef> | null = null;
  /** Child conversation id -> stops its card watcher. */
  private readonly watchers = new Map<string, () => void>();
  private disposed = false;
  private readonly disposeAbort = new AbortController();

  constructor(private readonly options: DurableSubagentsOptions) {}

  /** Children of this conversation, from their persisted origins (loaded once, then kept current). */
  private async loadChildren(): Promise<Map<string, ChildRef>> {
    if (this.children) return this.children;
    const records = await listWorkspaceConversationRecords(this.options.workspace.id).catch(() => [] as AgentConversationRecord[]);
    const children = new Map<string, ChildRef>();
    for (const record of records) {
      const origin = record.origin;
      if (origin?.kind !== "subagent" || origin.parentConversationId !== this.options.conversationId) continue;
      children.set(origin.path, {
        conversationId: record.id,
        path: origin.path,
        taskName: origin.taskName,
        title: record.title.replace(/^Subagent: /, ""),
        modelId: record.config.modelId,
      });
      await childReport(record);
    }
    this.children = children;
    return children;
  }

  async resolveChild(target: string): Promise<ChildRef> {
    const trimmed = target.trim();
    if (!trimmed) throw new Error("Agent target is required.");
    const children = await this.loadChildren();
    const byPath = children.get(trimmed) ?? children.get(`${this.options.parentPath}/${trimmed.replace(/^\/+/, "")}`);
    if (byPath) return byPath;
    const found = [...children.values()].find(
      (child) => child.taskName === trimmed || child.conversationId === trimmed
    );
    if (found) return found;
    throw new Error(`Unknown agent target: ${trimmed}. Use list_agents to see live paths.`);
  }

  async hasChildren(): Promise<boolean> {
    return (await this.loadChildren()).size > 0;
  }

  async spawnAgent(args: Record<string, unknown>): Promise<string> {
    const taskName = sanitizeTaskName(asString(args.task_name) ?? asString(args.taskName) ?? "");
    const message = asString(args.message)?.trim();
    if (!message) throw new Error("spawn_agent.message is required.");
    const forkArg = (asString(args.fork_turns) ?? asString(args.forkTurns) ?? "all").trim().toLowerCase();
    if (forkArg !== "all" && forkArg !== "none" && !/^\d+$/.test(forkArg)) {
      throw new Error('spawn_agent.fork_turns must be "none", "all", or a positive integer string.');
    }
    const fork: number | "all" | null = forkArg === "none" ? null : forkArg === "all" ? "all" : Number(forkArg);
    const result = await this.spawn({
      taskName,
      title: asString(args.title)?.trim() || taskName,
      message,
      requestedModelId: asString(args.modelId) ?? asString(args.model_id) ?? asString(args.model),
      fork,
    });
    return JSON.stringify({
      task_name: result.child.path,
      path: result.child.path,
      nickname: result.child.title,
      status: "running",
      model: result.child.modelId,
      model_inherited: result.inherited,
      conversation_id: result.child.conversationId,
    });
  }

  /** Creates the child conversation and starts its first turn. */
  async spawn(input: {
    taskName: string;
    title: string;
    message: string;
    requestedModelId?: string;
    fork: number | "all" | null;
    cardId?: string;
  }): Promise<{ child: ChildRef; inherited: boolean }> {
    const limits = this.options.limits();
    const children = await this.loadChildren();
    const agentPath = `${this.options.parentPath}/${input.taskName}`;
    const depth = spawnDepthOf(agentPath);
    if (depth > (limits.maxSpawnDepth ?? 1)) {
      throw new Error(
        `Cannot spawn ${agentPath}: maximum agent spawn depth (${limits.maxSpawnDepth ?? 1}) exceeded. Complete the task yourself or report back to your parent agent.`
      );
    }
    if (children.has(agentPath)) {
      throw new Error(`Agent path ${agentPath} already exists. Choose a different task_name or reuse via followup_task.`);
    }
    const live = await Promise.all(
      [...children.values()].map(async (child) => {
        const record = await readConversationRecord(this.options.workspace.id, child.conversationId);
        return record && childState(record) === "running";
      })
    );
    if (live.filter(Boolean).length >= limits.maxConcurrentSubagents) {
      throw new Error(
        `Cannot spawn: max concurrent subagents (${limits.maxConcurrentSubagents}) reached. Interrupt or wait for agents to finish.`
      );
    }
    const inheritedModelId = this.options.resolveDefaultModelId();
    const modelId = await this.options.resolveSpawnModel(input.requestedModelId, inheritedModelId);
    const runtime = await agentRuntime();
    const origin: SubagentOrigin = {
      kind: "subagent",
      parentConversationId: this.options.conversationId,
      path: agentPath,
      taskName: input.taskName,
      depth,
    };
    const record = await runtime.createConversation(this.options.workspace, {
      backendId: "cesium-agent",
      modelId,
      title: `Subagent: ${input.title}`,
      origin,
    });
    if (input.fork !== null) {
      const transcript = await this.options.parentTranscript(input.fork);
      if (transcript.trim()) {
        const capped =
          transcript.length > FORK_TRANSCRIPT_MAX_CHARS
            ? `...[${transcript.length - FORK_TRANSCRIPT_MAX_CHARS} earlier chars omitted]...\n${transcript.slice(-FORK_TRANSCRIPT_MAX_CHARS)}`
            : transcript;
        await appendConversationEvents(this.options.workspace.id, record.id, [
          {
            eventId: randomUUID(),
            conversationId: record.id,
            kind: "chat_fork",
            fromConversationId: this.options.conversationId,
            fromAgent: this.options.parentPath,
            transcript: capped,
            upToMessageId: null,
          },
        ]);
      }
    }
    const child: ChildRef = {
      conversationId: record.id,
      path: agentPath,
      taskName: input.taskName,
      title: input.title,
      modelId,
      ...(input.cardId ? { cardId: input.cardId } : {}),
    };
    children.set(agentPath, child);
    const text = childTaskText({
      path: agentPath,
      title: input.title,
      parentConversationId: this.options.conversationId,
      from: this.options.parentPath,
      message: input.message,
      canSpawn: depth < (limits.maxSpawnDepth ?? 1),
      first: true,
    });
    await this.startTurn(child, text);
    return { child, inherited: modelId === inheritedModelId };
  }

  private async startTurn(child: ChildRef, text: string): Promise<void> {
    const runtime = await agentRuntime();
    const before = await readConversationRecord(this.options.workspace.id, child.conversationId);
    await markChildReported(child.conversationId, before?.lastEventSeq ?? 0, { quiet: false });
    await runtime.promptConversation(this.options.workspace, child.conversationId, text);
    await this.emitCard(child);
    this.watch(child);
  }

  async sendMessage(args: Record<string, unknown>): Promise<string> {
    const target = asString(args.target);
    const message = asString(args.message)?.trim();
    if (!target) throw new Error("send_message.target is required.");
    if (!message) throw new Error("send_message.message is required.");
    const child = await this.resolveChild(target);
    const queued = await readMailbox(child.conversationId);
    queued.push({ from: this.options.parentPath, message, createdAt: Date.now() });
    await fs.mkdir(path.dirname(mailboxFile(child.conversationId)), { recursive: true });
    await fs.writeFile(mailboxFile(child.conversationId), JSON.stringify(queued), "utf8");
    return JSON.stringify({ ok: true, target: child.path, queued: true, trigger_turn: false });
  }

  async followupTask(args: Record<string, unknown>): Promise<string> {
    const target = asString(args.target);
    const message = asString(args.message)?.trim();
    if (!target) throw new Error("followup_task.target is required.");
    if (!message) throw new Error("followup_task.message is required.");
    const child = await this.resolveChild(target);
    const queued = await readMailbox(child.conversationId);
    await fs.rm(mailboxFile(child.conversationId), { force: true });
    const record = await readConversationRecord(this.options.workspace.id, child.conversationId);
    await this.startTurn(
      child,
      childTaskText({
        path: child.path,
        title: child.title,
        parentConversationId: this.options.conversationId,
        from: this.options.parentPath,
        message,
        canSpawn: false,
        queued,
        first: false,
      })
    );
    return JSON.stringify({
      ok: true,
      target: child.path,
      queued: true,
      trigger_turn: true,
      status: record && childState(record) === "running" ? "running" : "started",
    });
  }

  async interruptAgent(args: Record<string, unknown>): Promise<string> {
    const target = asString(args.target);
    if (!target) throw new Error("interrupt_agent.target is required.");
    const child = await this.resolveChild(target);
    const record = await this.stopChild(child);
    return JSON.stringify({ ok: true, target: child.path, status: childState(record) });
  }

  /** Stops a child on the parent's behalf; the stop is not reported back to the parent. */
  private async stopChild(child: ChildRef): Promise<AgentConversationRecord> {
    const runtime = await agentRuntime();
    // Quiet before the cancel lands, so no update can announce the stop in between.
    await markChildReported(child.conversationId, 0, { quiet: true });
    const record = await runtime.cancelConversation(this.options.workspace, child.conversationId);
    await markChildReported(child.conversationId, record.lastEventSeq, { quiet: true });
    await this.emitCard(child);
    return record;
  }

  /** Children whose turn ended (or that need attention) since the parent last heard. */
  private async updates(target?: string): Promise<Array<{ child: ChildRef; record: AgentConversationRecord }>> {
    const children = target ? [await this.resolveChild(target)] : [...(await this.loadChildren()).values()];
    const updates: Array<{ child: ChildRef; record: AgentConversationRecord }> = [];
    for (const child of children) {
      const record = await readConversationRecord(this.options.workspace.id, child.conversationId);
      if (!record || childState(record) === "running") continue;
      if (await childHasNews(record)) {
        updates.push({ child, record });
      }
    }
    return updates;
  }

  /**
   * Waits until a child finishes a turn or needs attention. Returns which
   * ones, with each one's state and its latest reply (shortened).
   */
  async waitAgent(args: Record<string, unknown>): Promise<string> {
    const rawTimeout = asNumber(args.timeout_ms) ?? asNumber(args.timeoutMs);
    const timeoutMs = resolveWaitAgentTimeoutMs(rawTimeout ?? undefined, this.options.limits());
    return this.waitForChildren(timeoutMs, asString(args.target));
  }

  async waitForChildren(timeoutMs: number, target?: string): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    const watched = target ? [await this.resolveChild(target)] : [...(await this.loadChildren()).values()];
    const wake = conversationWake(
      watched.map((child) => child.conversationId),
      (record) => childState(record) !== "running"
    );
    try {
      return await this.waitForUpdates(wake, deadline, target);
    } finally {
      wake.close();
    }
  }

  private async waitForUpdates(wake: StoreWake, deadline: number, target?: string): Promise<string> {
    for (;;) {
      const updates = await this.updates(target);
      if (updates.length > 0) {
        const agents = await Promise.all(
          updates.map(async ({ child, record }) => {
            await markChildReported(child.conversationId, record.lastEventSeq);
            const events = await readRecentConversationEvents(this.options.workspace.id, child.conversationId, CARD_RECENT_MESSAGES).catch(
              () => [] as AgentStoredEvent[]
            );
            const state = childState(record);
            return {
              path: child.path,
              status: state,
              ...(attentionDetail(record) ? { detail: attentionDetail(record) } : {}),
              ...(state === "errored" && record.lastError ? { error: record.lastError.slice(0, 400) } : {}),
              summary: lastReply(events).slice(0, 600),
            };
          })
        );
        return JSON.stringify({
          message: `Mailbox update from: ${agents.map((agent) => agent.path).join(", ")}`,
          timed_out: false,
          agents_with_updates: agents.map((agent) => agent.path),
          agents,
        });
      }
      if (this.options.isCancelled() || this.disposed) {
        return JSON.stringify({ message: "Wait timed out.", timed_out: true });
      }
      const outcome = await wake.next(deadline, this.options.cancelSignal?.(), this.disposeAbort.signal);
      if (outcome !== "event") {
        return JSON.stringify({ message: "Wait timed out.", timed_out: true });
      }
    }
  }

  async listAgents(pathPrefix?: string): Promise<Array<{ agent_name: string; agent_status: string; model: string; conversation_id: string }>> {
    const prefix = pathPrefix?.trim();
    const children = [...(await this.loadChildren()).values()].filter((child) => !prefix || child.path.startsWith(prefix));
    return Promise.all(
      children.map(async (child) => {
        const record = await readConversationRecord(this.options.workspace.id, child.conversationId);
        return {
          agent_name: child.path,
          agent_status: record ? childState(record) : "missing",
          model: child.modelId,
          conversation_id: child.conversationId,
        };
      })
    );
  }

  async readTranscript(args: Record<string, unknown>): Promise<string> {
    const id = asString(args.subagentId) ?? asString(args.target);
    if (!id) throw new Error("read_subagent_transcript.subagentId is required.");
    let child: ChildRef;
    try {
      child = await this.resolveChild(id);
    } catch {
      return `No subagent found for ${id}.`;
    }
    const limit = Math.max(1, Math.min(200, Math.floor(asNumber(args.limit) ?? 40)));
    const events = await readRecentConversationEvents(this.options.workspace.id, child.conversationId, limit);
    return `Subagent ${child.path} (conversation ${child.conversationId})\n\n${generateTranscriptFromEvents(events).trim()}`;
  }

  /**
   * Runs one task to the end of a child's turn and returns its reply: the
   * blocking `subagent` tool. Stopping the parent's turn stops the child; a
   * parent session that goes away leaves the child running.
   */
  async runToCompletion(input: {
    title: string;
    message: string;
    requestedModelId?: string;
    cardId?: string;
  }): Promise<{ status: "completed" | "failed"; text: string; child: ChildRef }> {
    const children = await this.loadChildren();
    let index = children.size + 1;
    let taskName = `subagent_${index}`;
    while (children.has(`${this.options.parentPath}/${taskName}`)) {
      index += 1;
      taskName = `subagent_${index}`;
    }
    const { child } = await this.spawn({
      taskName,
      title: input.title,
      message: input.message,
      requestedModelId: input.requestedModelId,
      fork: null,
      cardId: input.cardId,
    });
    const settled = (record: AgentConversationRecord) => {
      const state = childState(record);
      return state !== "running" && state !== "needs_attention";
    };
    const wake = conversationWake([child.conversationId], settled);
    try {
      for (;;) {
        if (this.disposed) {
          return { status: "failed", text: `The parent session ended; ${child.path} keeps running as conversation ${child.conversationId}.`, child };
        }
        if (this.options.isCancelled()) {
          await this.stopChild(child).catch(() => undefined);
          return { status: "failed", text: "Stopped with the parent turn.", child };
        }
        const record = await readConversationRecord(this.options.workspace.id, child.conversationId);
        if (!record || settled(record)) {
          const state = record ? childState(record) : "errored";
          if (record) await markChildReported(child.conversationId, record.lastEventSeq);
          const events = await readRecentConversationEvents(this.options.workspace.id, child.conversationId, CARD_RECENT_MESSAGES);
          await this.emitCard(child);
          const reply = lastReply(events);
          return state === "completed"
            ? { status: "completed", text: reply || "Subagent completed without visible text.", child }
            : { status: "failed", text: record?.lastError ?? (reply || `Subagent ${state}.`), child };
        }
        await wake.next(Number.POSITIVE_INFINITY, this.options.cancelSignal?.(), this.disposeAbort.signal);
      }
    } finally {
      wake.close();
    }
  }

  /**
   * Keeps the child's card current: re-emitted at once when its state
   * changes, at most every CARD_PROGRESS_MIN_MS while it only makes progress,
   * and a last time when it stops.
   */
  private watch(child: ChildRef): void {
    if (this.watchers.has(child.conversationId) || this.disposed) return;
    let lastKey = "";
    let lastState: ChildState | null = null;
    let lastEmitAt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running: Promise<void> | null = null;
    let rerun = false;
    const stop = () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
      timer = null;
      this.watchers.delete(child.conversationId);
    };
    const refresh = async (): Promise<void> => {
      if (timer) clearTimeout(timer);
      timer = null;
      const record = await readConversationRecord(this.options.workspace.id, child.conversationId).catch(() => null);
      if (!record || this.disposed) {
        stop();
        return;
      }
      const key = `${record.status}:${record.lastEventSeq}`;
      if (key !== lastKey) {
        lastKey = key;
        lastState = childState(record);
        lastEmitAt = Date.now();
        await this.emitCard(child, record);
      }
      if (childState(record) !== "running" && childState(record) !== "needs_attention") stop();
    };
    const run = () => {
      if (running) {
        rerun = true;
        return;
      }
      running = refresh().finally(() => {
        running = null;
        if (rerun && this.watchers.has(child.conversationId)) {
          rerun = false;
          run();
        }
      });
    };
    const unsubscribe = subscribeAgentStoreEvents((event) => {
      if (event.type !== "conversation" || event.conversation.id !== child.conversationId) return;
      if (childState(event.conversation) !== lastState) {
        run();
      } else if (!timer) {
        timer = setTimeout(run, Math.max(0, CARD_PROGRESS_MIN_MS - (Date.now() - lastEmitAt)));
        timer.unref?.();
      }
    });
    this.watchers.set(child.conversationId, stop);
    run();
  }

  private async emitCard(child: ChildRef, known?: AgentConversationRecord): Promise<void> {
    const record = known ?? (await readConversationRecord(this.options.workspace.id, child.conversationId));
    if (!record) return;
    const events = await readRecentConversationEvents(this.options.workspace.id, child.conversationId, CARD_RECENT_MESSAGES).catch(
      () => [] as AgentStoredEvent[]
    );
    const state = childState(record);
    const recent = attentionDetail(record) ?? (state === "errored" ? record.lastError ?? "" : lastReply(events));
    await this.options
      .appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.options.conversationId,
          kind: "subagent",
          subagentId: child.cardId ?? child.path,
          title: child.title,
          status: cardStatus(state),
          transcript: events.filter((event) => event.kind !== "status"),
          recentActivity: recent.slice(0, 240),
          raw: {
            version: 3,
            path: child.path,
            taskName: child.taskName,
            agentStatus: state,
            modelId: child.modelId,
            conversationId: child.conversationId,
          },
        },
      ])
      .catch(() => undefined);
  }

  dispose(): void {
    this.disposed = true;
    this.disposeAbort.abort();
    for (const stop of [...this.watchers.values()]) stop();
    this.watchers.clear();
  }
}
