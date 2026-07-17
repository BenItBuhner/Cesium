import { randomUUID } from "node:crypto";
import type { AgentStoredEvent } from "../../../types.js";
import type { CesiumProviderKind } from "../../../../cesium-agent-settings.js";
import { resolveCesiumAuth } from "../../../../cesium-agent-settings.js";
import { runAdapter } from "../../cesium-model-adapters.js";
import { CESIUM_SYSTEM_PROMPT } from "../../cesium-prompt.js";
import { asString } from "../../cesium-coerce.js";
import { asNumber } from "../../../json-coerce.js";
import type { CesiumHistoryMessage } from "../../cesium-types.js";
import { resolveWaitAgentTimeoutMs } from "../limits.js";
import type { CesiumHarnessLimits } from "../types.js";

export type SubagentsV2StatusKind =
  | "pending_init"
  | "running"
  | "interrupted"
  | "completed"
  | "errored"
  | "shutdown";

export type SubagentsV2AgentStatus =
  | { kind: "pending_init" }
  | { kind: "running" }
  | { kind: "interrupted" }
  | { kind: "completed"; summary: string | null }
  | { kind: "errored"; error: string }
  | { kind: "shutdown" };

export type SubagentsV2MailboxMessage = {
  id: string;
  from: string;
  to: string;
  message: string;
  triggerTurn: boolean;
  createdAt: number;
  consumed: boolean;
};

export type SubagentsV2Agent = {
  id: string;
  path: string;
  taskName: string;
  title: string;
  modelId: string;
  status: SubagentsV2AgentStatus;
  mailbox: SubagentsV2MailboxMessage[];
  unreadCount: number;
  transcript: AgentStoredEvent[];
  lastTaskMessage: string | null;
  forkHistory: CesiumHistoryMessage[];
  abortController: AbortController;
  turnPromise: Promise<void> | null;
};

export type SubagentsV2SpawnResult = {
  task_name: string;
  path: string;
  nickname: string;
  status: SubagentsV2StatusKind;
};

export type SubagentsV2WaitResult = {
  message: string;
  timed_out: boolean;
  agents_with_updates?: string[];
};

type AppendEvents = (events: Array<Record<string, unknown>>) => Promise<void>;

export type SubagentsV2RuntimeOptions = {
  conversationId: string;
  parentPath?: string;
  limits: CesiumHarnessLimits;
  defaultModelId: string;
  defaultApiKind?: CesiumProviderKind;
  appendEvents: AppendEvents;
  getParentHistory?: () => Promise<CesiumHistoryMessage[]>;
  isCancelled?: () => boolean;
};

function providerPart(modelId: string): string {
  return modelId.includes("/") ? modelId.split("/", 1)[0]! : "openai";
}

function sanitizeTaskName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_/-]+/g, "_")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
  if (!cleaned) {
    throw new Error("spawn_agent.task_name must be a non-empty identifier.");
  }
  const segment = cleaned.includes("/") ? cleaned.split("/").pop()! : cleaned;
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(segment)) {
    throw new Error(
      "spawn_agent.task_name must be snake_case starting with a letter (max 64 chars)."
    );
  }
  return segment;
}

function joinAgentPath(parentPath: string, taskName: string): string {
  const base = parentPath.replace(/\/+$/, "") || "/root";
  return `${base}/${taskName}`;
}

function statusKind(status: SubagentsV2AgentStatus): SubagentsV2StatusKind {
  return status.kind;
}

function isTerminal(status: SubagentsV2AgentStatus): boolean {
  return (
    status.kind === "completed" ||
    status.kind === "errored" ||
    status.kind === "shutdown"
  );
}

/**
 * In-session MultiAgentV2-style runtime: path-addressed agents + mailbox.
 * Inspired by openai/codex multi_agents_v2 (spawn/wait/send/followup/interrupt/list).
 */
export class SubagentsV2Runtime {
  private readonly agents = new Map<string, SubagentsV2Agent>();
  private readonly agentsByTaskName = new Map<string, string>();
  private mailboxEpoch = 0;
  private waiters = new Set<{
    resolve: (paths: string[]) => void;
    seenEpoch: number;
  }>();
  private readonly parentPath: string;

  constructor(private readonly options: SubagentsV2RuntimeOptions) {
    this.parentPath = options.parentPath ?? "/root";
  }

  updateLimits(limits: CesiumHarnessLimits): void {
    this.options.limits = limits;
  }

  listAgents(pathPrefix?: string): Array<{ agent_name: string; agent_status: string }> {
    const prefix = pathPrefix?.trim();
    return [...this.agents.values()]
      .filter((agent) => !prefix || agent.path.startsWith(prefix))
      .map((agent) => ({
        agent_name: agent.path,
        agent_status: this.formatStatus(agent.status),
      }));
  }

  resolveAgent(target: string): SubagentsV2Agent {
    const trimmed = target.trim();
    if (!trimmed) {
      throw new Error("Agent target is required.");
    }
    if (trimmed === this.parentPath || trimmed === "root" || trimmed === "/root") {
      throw new Error("Cannot target the root/parent agent with subagent collaboration tools.");
    }
    const byPath = this.agents.get(trimmed);
    if (byPath) return byPath;
    const byTask = this.agentsByTaskName.get(trimmed);
    if (byTask) {
      const agent = this.agents.get(byTask);
      if (agent) return agent;
    }
    // Relative path under parent
    const joined = joinAgentPath(this.parentPath, sanitizeTaskName(trimmed));
    const relative = this.agents.get(joined);
    if (relative) return relative;
    const byId = [...this.agents.values()].find((agent) => agent.id === trimmed);
    if (byId) return byId;
    throw new Error(`Unknown agent target: ${trimmed}. Use list_agents to see live paths.`);
  }

  async spawnAgent(args: Record<string, unknown>): Promise<string> {
    const taskName = sanitizeTaskName(asString(args.task_name) ?? asString(args.taskName) ?? "");
    const message = asString(args.message)?.trim();
    if (!message) {
      throw new Error("spawn_agent.message is required.");
    }
    const liveCount = [...this.agents.values()].filter((agent) => !isTerminal(agent.status)).length;
    if (liveCount >= this.options.limits.maxConcurrentSubagents) {
      throw new Error(
        `Cannot spawn: max concurrent subagents (${this.options.limits.maxConcurrentSubagents}) reached. Interrupt or wait for agents to finish.`
      );
    }
    const path = joinAgentPath(this.parentPath, taskName);
    if (this.agents.has(path)) {
      throw new Error(`Agent path ${path} already exists. Choose a different task_name or reuse via followup_task.`);
    }

    const forkTurns = (asString(args.fork_turns) ?? asString(args.forkTurns) ?? "none").trim().toLowerCase();
    let forkHistory: CesiumHistoryMessage[] = [];
    if (forkTurns === "all") {
      forkHistory = (await this.options.getParentHistory?.()) ?? [];
    } else if (forkTurns !== "none" && /^\d+$/.test(forkTurns)) {
      const n = Number(forkTurns);
      const history = (await this.options.getParentHistory?.()) ?? [];
      forkHistory = history.slice(-Math.max(0, n));
    }

    const modelId =
      asString(args.modelId) ?? asString(args.model_id) ?? this.options.defaultModelId;
    const title = asString(args.title)?.trim() || taskName;
    const agent: SubagentsV2Agent = {
      id: randomUUID(),
      path,
      taskName,
      title,
      modelId,
      status: { kind: "pending_init" },
      mailbox: [],
      unreadCount: 0,
      transcript: [
        {
          seq: 0,
          eventId: randomUUID(),
          conversationId: this.options.conversationId,
          createdAt: Date.now(),
          kind: "user_message",
          messageId: randomUUID(),
          content: message,
        },
      ],
      lastTaskMessage: message,
      forkHistory,
      abortController: new AbortController(),
      turnPromise: null,
    };
    this.agents.set(path, agent);
    this.agentsByTaskName.set(taskName, path);

    await this.emitSubagentCard(agent, "running");
    // Initial task is delivered privately to the child; do not wake parent wait_agent
    // until the child produces a status/mailbox update.
    agent.mailbox.push({
      id: randomUUID(),
      from: this.parentPath,
      to: path,
      message,
      triggerTurn: true,
      createdAt: Date.now(),
      consumed: false,
    });
    this.startTurn(agent);

    const result: SubagentsV2SpawnResult = {
      task_name: path,
      path,
      nickname: title,
      status: "running",
    };
    return JSON.stringify(result);
  }

  async sendMessage(args: Record<string, unknown>): Promise<string> {
    const target = asString(args.target);
    const message = asString(args.message)?.trim();
    if (!target) throw new Error("send_message.target is required.");
    if (!message) throw new Error("send_message.message is required.");
    const agent = this.resolveAgent(target);
    if (agent.status.kind === "shutdown") {
      throw new Error(`Agent ${agent.path} is shut down.`);
    }
    this.enqueueMessage({
      from: this.parentPath,
      to: agent.path,
      message,
      triggerTurn: false,
    });
    return JSON.stringify({
      ok: true,
      target: agent.path,
      queued: true,
      trigger_turn: false,
    });
  }

  async followupTask(args: Record<string, unknown>): Promise<string> {
    const target = asString(args.target);
    const message = asString(args.message)?.trim();
    if (!target) throw new Error("followup_task.target is required.");
    if (!message) throw new Error("followup_task.message is required.");
    const agent = this.resolveAgent(target);
    if (agent.status.kind === "shutdown") {
      throw new Error(`Agent ${agent.path} is shut down.`);
    }
    agent.lastTaskMessage = message;
    agent.transcript.push({
      seq: 0,
      eventId: randomUUID(),
      conversationId: this.options.conversationId,
      createdAt: Date.now(),
      kind: "user_message",
      messageId: randomUUID(),
      content: message,
    });
    // Queue for the child without waking parent waiters (same as spawn).
    agent.mailbox.push({
      id: randomUUID(),
      from: this.parentPath,
      to: agent.path,
      message,
      triggerTurn: true,
      createdAt: Date.now(),
      consumed: false,
    });
    if (agent.status.kind !== "running") {
      agent.abortController = new AbortController();
      this.startTurn(agent);
    }
    return JSON.stringify({
      ok: true,
      target: agent.path,
      queued: true,
      trigger_turn: true,
      status: statusKind(agent.status),
    });
  }

  async interruptAgent(args: Record<string, unknown>): Promise<string> {
    const target = asString(args.target);
    if (!target) throw new Error("interrupt_agent.target is required.");
    const agent = this.resolveAgent(target);
    if (agent.path === this.parentPath) {
      throw new Error("Cannot interrupt the root agent.");
    }
    agent.abortController.abort();
    if (agent.status.kind === "running" || agent.status.kind === "pending_init") {
      agent.status = { kind: "interrupted" };
      this.notifyMailbox([agent.path]);
      await this.emitSubagentCard(agent, "failed");
    }
    return JSON.stringify({
      ok: true,
      target: agent.path,
      status: statusKind(agent.status),
    });
  }

  async waitAgent(args: Record<string, unknown>): Promise<string> {
    const rawTimeout =
      typeof args.timeout_ms === "number"
        ? args.timeout_ms
        : typeof args.timeoutMs === "number"
          ? args.timeoutMs
          : typeof args.timeout_ms === "string"
            ? Number(args.timeout_ms)
            : typeof args.timeoutMs === "string"
              ? Number(args.timeoutMs)
              : undefined;
    const timeoutMs = resolveWaitAgentTimeoutMs(
      rawTimeout != null && Number.isFinite(rawTimeout) ? rawTimeout : undefined,
      this.options.limits
    );

    // Immediate pending unread?
    const pending = this.agentsWithUnread();
    if (pending.length > 0) {
      for (const path of pending) {
        const agent = this.agents.get(path);
        if (agent) agent.unreadCount = 0;
      }
      const result: SubagentsV2WaitResult = {
        message: `Mailbox update from: ${pending.join(", ")}`,
        timed_out: false,
        agents_with_updates: pending,
      };
      return JSON.stringify(result);
    }

    const seenEpoch = this.mailboxEpoch;
    const paths = await new Promise<string[] | null>((resolve) => {
      const entry = {
        resolve: (updated: string[]) => {
          this.waiters.delete(entry);
          resolve(updated);
        },
        seenEpoch,
      };
      this.waiters.add(entry);
      const timer = setTimeout(() => {
        this.waiters.delete(entry);
        resolve(null);
      }, timeoutMs);
      // If cancelled mid-wait, resolve early
      const poll = setInterval(() => {
        if (this.options.isCancelled?.()) {
          clearTimeout(timer);
          clearInterval(poll);
          this.waiters.delete(entry);
          resolve(null);
        }
      }, 250);
      const originalResolve = entry.resolve;
      entry.resolve = (updated: string[]) => {
        clearTimeout(timer);
        clearInterval(poll);
        originalResolve(updated);
      };
    });

    if (!paths) {
      const result: SubagentsV2WaitResult = {
        message: "Wait timed out.",
        timed_out: true,
      };
      return JSON.stringify(result);
    }
    for (const path of paths) {
      const agent = this.agents.get(path);
      if (agent) agent.unreadCount = 0;
    }
    const result: SubagentsV2WaitResult = {
      message: `Mailbox update from: ${paths.join(", ")}`,
      timed_out: false,
      agents_with_updates: paths,
    };
    return JSON.stringify(result);
  }

  async readTranscript(args: Record<string, unknown>): Promise<string> {
    const id = asString(args.subagentId) ?? asString(args.target);
    if (!id) throw new Error("read_subagent_transcript.subagentId is required.");
    let agent: SubagentsV2Agent;
    try {
      agent = this.resolveAgent(id);
    } catch {
      return `No collaborative subagent transcript found for ${id}.`;
    }
    const offset = Math.max(0, Math.floor(asNumber(args.offset) ?? 0));
    const limit = Math.max(1, Math.min(200, Math.floor(asNumber(args.limit) ?? 50)));
    return agent.transcript
      .slice(offset, offset + limit)
      .map((event) => `${event.kind}: ${JSON.stringify(event)}`)
      .join("\n");
  }

  dispose(): void {
    for (const agent of this.agents.values()) {
      agent.abortController.abort();
      if (!isTerminal(agent.status)) {
        agent.status = { kind: "shutdown" };
      }
    }
    for (const waiter of this.waiters) {
      waiter.resolve([]);
    }
    this.waiters.clear();
  }

  private formatStatus(status: SubagentsV2AgentStatus): string {
    switch (status.kind) {
      case "completed":
        return status.summary ? `completed:${status.summary.slice(0, 120)}` : "completed";
      case "errored":
        return `errored:${status.error.slice(0, 120)}`;
      default:
        return status.kind;
    }
  }

  private agentsWithUnread(): string[] {
    return [...this.agents.values()]
      .filter((agent) => agent.unreadCount > 0)
      .map((agent) => agent.path);
  }

  private enqueueMessage(input: {
    from: string;
    to: string;
    message: string;
    triggerTurn: boolean;
  }): void {
    const agent = this.agents.get(input.to);
    if (!agent) return;
    agent.mailbox.push({
      id: randomUUID(),
      from: input.from,
      to: input.to,
      message: input.message,
      triggerTurn: input.triggerTurn,
      createdAt: Date.now(),
      consumed: false,
    });
    agent.unreadCount += 1;
    this.notifyMailbox([agent.path]);
  }

  private notifyMailbox(paths: string[]): void {
    this.mailboxEpoch += 1;
    for (const waiter of [...this.waiters]) {
      waiter.resolve(paths);
    }
  }

  private startTurn(agent: SubagentsV2Agent): void {
    if (agent.turnPromise) return;
    agent.status = { kind: "running" };
    agent.turnPromise = this.runTurn(agent)
      .catch(() => undefined)
      .finally(() => {
        agent.turnPromise = null;
        // Drain follow-ups queued while this turn was already running.
        const hasPending = agent.mailbox.some((entry) => !entry.consumed && entry.triggerTurn);
        if (
          hasPending &&
          !agent.abortController.signal.aborted &&
          !this.options.isCancelled?.() &&
          agent.status.kind !== "shutdown"
        ) {
          agent.abortController = new AbortController();
          this.startTurn(agent);
        }
      });
  }

  private async runTurn(agent: SubagentsV2Agent): Promise<void> {
    const pending = agent.mailbox.filter((entry) => !entry.consumed && entry.triggerTurn);
    const taskText =
      pending.map((entry) => entry.message).join("\n\n") ||
      agent.lastTaskMessage ||
      "Continue your assigned work.";
    for (const entry of pending) {
      entry.consumed = true;
    }

    let cardStatus: "completed" | "failed" | "running" | null = null;
    try {
      if (agent.abortController.signal.aborted || this.options.isCancelled?.()) {
        agent.status = { kind: "interrupted" };
        cardStatus = "failed";
        return;
      }
      const subagentProviderId = providerPart(agent.modelId);
      const auth = await resolveCesiumAuth({
        modelId: agent.modelId,
        configuredApiKind:
          subagentProviderId === "openai" ? this.options.defaultApiKind : undefined,
      });
      const messages: CesiumHistoryMessage[] = [
        {
          role: "system",
          content:
            `${CESIUM_SYSTEM_PROMPT}\n\n` +
            `You are collaborative subagent ${agent.path} (${agent.title}). ` +
            "Complete the assigned task. Do not spawn additional subagents. " +
            "Reply with a clear final summary of findings or work completed.",
        },
        ...agent.forkHistory.filter((message) => message.role !== "system"),
        { role: "user", content: taskText },
      ];
      const result = await runAdapter({
        apiKind: auth.apiKind,
        apiKey: auth.apiKey,
        baseUrl: auth.baseUrl,
        providerId: auth.providerId,
        modelId: agent.modelId,
        messages,
        // Omit tools entirely — empty [] still serializes on some providers.
      });
      if (agent.abortController.signal.aborted) {
        agent.status = { kind: "interrupted" };
        cardStatus = "failed";
        return;
      }
      const resultText =
        result.text.trim() ||
        (result.toolRequests.length > 0
          ? `Subagent requested unsupported child tools: ${result.toolRequests.map((tool) => tool.name).join(", ")}`
          : "Subagent completed without visible text.");
      agent.transcript.push({
        seq: 0,
        eventId: randomUUID(),
        conversationId: this.options.conversationId,
        createdAt: Date.now(),
        kind: "assistant_message_chunk",
        messageId: randomUUID(),
        text: resultText,
      });
      agent.status = { kind: "completed", summary: resultText };
      cardStatus = "completed";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (agent.abortController.signal.aborted) {
        agent.status = { kind: "interrupted" };
      } else {
        agent.status = { kind: "errored", error: message };
        agent.transcript.push({
          seq: 0,
          eventId: randomUUID(),
          conversationId: this.options.conversationId,
          createdAt: Date.now(),
          kind: "assistant_message_chunk",
          messageId: randomUUID(),
          text: message,
        });
      }
      cardStatus = "failed";
    } finally {
      // Always wake wait_agent even if card persistence fails.
      agent.unreadCount += 1;
      this.notifyMailbox([agent.path]);
      if (cardStatus) {
        await this.emitSubagentCard(agent, cardStatus);
      }
    }
  }

  private async emitSubagentCard(
    agent: SubagentsV2Agent,
    status: "completed" | "failed" | "running"
  ): Promise<void> {
    const recent =
      agent.status.kind === "completed"
        ? agent.status.summary ?? ""
        : agent.status.kind === "errored"
          ? agent.status.error
          : agent.lastTaskMessage ?? "";
    try {
      await this.options.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.options.conversationId,
          kind: "subagent",
          subagentId: agent.path,
          title: agent.title,
          status,
          transcript: agent.transcript,
          recentActivity: recent.slice(0, 240),
          raw: {
            version: 2,
            path: agent.path,
            taskName: agent.taskName,
            agentStatus: statusKind(agent.status),
          },
        },
      ]);
    } catch {
      // Card persistence is best-effort and must not block mailbox wakeups.
    }
  }
}
