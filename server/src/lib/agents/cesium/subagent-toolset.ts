import { randomUUID } from "node:crypto";
import { BROWSER_MCP_TOOLS } from "../../mcp/builtin-browser-tools.js";
import { runAdapter } from "./cesium-model-adapters.js";
import { normalizeCesiumToolResultForModel } from "./cesium-history.js";
import type { CesiumToolDefinition } from "./features/types.js";
import type {
  CesiumAdapterResult,
  CesiumHistoryMessage,
} from "./cesium-types.js";
import type { CesiumProviderKind } from "../../cesium-agent-settings.js";
import type { AgentStoredEvent } from "../types.js";

/**
 * Tool surface handed to Cesium subagents.
 *
 * Codex MultiAgentV2 parity: "All agents in the team … are equally intelligent
 * and capable, and have access to the same set of tools." Subagents share the
 * parent's workspace tool surface (files, terminal, MCP) plus the direct
 * browser tools, and — when the V2 feature is active — the collaboration tools
 * themselves (spawn depth is enforced at spawn time, like Codex
 * `agents.max_depth`). Parent-conversation control tools (mode switching,
 * plans, goals, workflows, orchestration boards) are excluded because Cesium
 * children run inside the parent conversation rather than as separate
 * sessions; there is no child conversation for those tools to act on.
 */
export type CesiumSubagentToolset = {
  tools: CesiumToolDefinition[];
  toolNames: Set<string>;
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
};

/** Host (parent harness) tools shared with subagents, Codex "same tools" parity. */
export const SUBAGENT_SHARED_HOST_TOOL_NAMES: readonly string[] = [
  "read_file",
  "grep",
  "write_file",
  "edit_file",
  "terminal",
  "wait",
  "call_mcp_tool",
];

/** Collaboration tools children receive so they can spawn/coordinate (depth-gated at spawn). */
export const SUBAGENT_COLLABORATION_TOOL_NAMES: readonly string[] = [
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
  "read_subagent_transcript",
];

const SUBAGENT_SHARED_GUIDANCE =
  "You are an agent in a team of agents collaborating to complete a task. All agents are equally capable and share the same " +
  "workspace: the same filesystem and working directory, so edits made by one agent are immediately visible to all other agents. " +
  "You have the parent agent's workspace tools (read_file, grep, write_file, edit_file, terminal, call_mcp_tool) and the built-in " +
  "browser tools (browser_tabs, browser_navigate, browser_snapshot, browser_click, browser_type, browser_evaluate, browser_viewport, " +
  "browser_screenshot, browser_record, browser_events). Screenshots and demo recordings are saved under artifacts/browser/ in the " +
  "workspace — always list those exact file paths in your final summary so the parent agent and the user can open them. " +
  "Close browser tabs you opened when finished. Your final response is delivered back to your parent agent.";

const SUBAGENT_COLLABORATION_GUIDANCE =
  "You may also coordinate with other agents: spawn_agent creates a child (subject to the configured max spawn depth), " +
  "followup_task assigns more work, send_message queues context without triggering a turn, wait_agent polls for mailbox updates, " +
  "and list_agents shows live agents and statuses.";

export function subagentToolsetGuidance(toolset: CesiumSubagentToolset | null | undefined): string {
  if (!toolset || toolset.tools.length === 0) {
    return "";
  }
  const hasCollaboration = toolset.toolNames.has("spawn_agent");
  return hasCollaboration
    ? `${SUBAGENT_SHARED_GUIDANCE}\n\n${SUBAGENT_COLLABORATION_GUIDANCE}`
    : SUBAGENT_SHARED_GUIDANCE;
}

/** Direct browser tool definitions mapped onto the Cesium tool shape. */
export function subagentBrowserToolDefinitions(): CesiumToolDefinition[] {
  return BROWSER_MCP_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
  }));
}

/**
 * Select the tool definitions a subagent receives from the host harness.
 * Preserves the host's own schemas (and `requiresPermission` markers) so the
 * permission cascade behaves identically for parent and child calls.
 */
export function subagentToolDefinitions(input: {
  hostTools: CesiumToolDefinition[];
  includeCollaboration: boolean;
}): CesiumToolDefinition[] {
  const byName = new Map(input.hostTools.map((tool) => [tool.name, tool]));
  const shared = SUBAGENT_SHARED_HOST_TOOL_NAMES.flatMap((name) => {
    const tool = byName.get(name);
    return tool ? [tool] : [];
  });
  const collaboration = input.includeCollaboration
    ? SUBAGENT_COLLABORATION_TOOL_NAMES.flatMap((name) => {
        const tool = byName.get(name);
        return tool ? [tool] : [];
      })
    : [];
  return [...shared, ...subagentBrowserToolDefinitions(), ...collaboration];
}

export function createSubagentToolset(input: {
  definitions: CesiumToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
}): CesiumSubagentToolset {
  return {
    tools: input.definitions,
    toolNames: new Set(input.definitions.map((tool) => tool.name)),
    execute: input.execute,
  };
}

export type SubagentToolLoopToolEvent = {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  result: string;
  ok: boolean;
};

export type SubagentToolLoopToolStartEvent = {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type SubagentToolLoopResult = {
  text: string;
  toolCallCount: number;
};

/** Default minimum spacing between live subagent progress cards on the parent event stream. */
export const SUBAGENT_PROGRESS_MIN_INTERVAL_MS = 900;

export type SubagentProgressBroadcaster = {
  /** Mark progress dirty. Emits immediately when outside the throttle window, otherwise schedules a trailing emission so the last update always lands. */
  notify: () => void;
  /** Permanently stop emissions (call right before persisting the terminal card so a stale "running" card can never land after it). */
  stop: () => void;
};

/**
 * Throttled live-progress fan-out for subagent runs.
 *
 * Subagents used to persist a `kind: "subagent"` card only at spawn and at the
 * terminal state, so an open transcript tab showed a frozen "Working" row for
 * the whole run. This broadcaster lets the tool loop re-emit the running card
 * with the growing transcript, rate-limited so rapid tool bursts do not flood
 * the event store (transcripts are cumulative, so skipped ticks lose nothing —
 * the next emission carries every row).
 */
export function createSubagentProgressBroadcaster(input: {
  emit: () => Promise<void>;
  minIntervalMs?: number;
}): SubagentProgressBroadcaster {
  const minIntervalMs = Math.max(0, input.minIntervalMs ?? SUBAGENT_PROGRESS_MIN_INTERVAL_MS);
  let lastEmitAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let inFlight = false;
  let dirty = false;

  const run = (): void => {
    if (stopped || inFlight) {
      return;
    }
    dirty = false;
    inFlight = true;
    lastEmitAt = Date.now();
    void input
      .emit()
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        if (dirty && !stopped) {
          schedule();
        }
      });
  };

  const schedule = (): void => {
    if (stopped || timer) {
      return;
    }
    const waitMs = Math.max(0, lastEmitAt + minIntervalMs - Date.now());
    if (waitMs === 0) {
      run();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (!stopped && dirty) {
        run();
      }
    }, waitMs);
  };

  return {
    notify: () => {
      if (stopped) {
        return;
      }
      dirty = true;
      schedule();
    },
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** Compact single-line preview of tool arguments shown while a subagent tool is executing. */
function subagentToolArgsPreview(args: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(args);
    return json && json !== "{}" ? json.slice(0, 200) : "";
  } catch {
    return "";
  }
}

/** Append an in-flight tool row so open transcript views show what the subagent is doing right now. */
export function pushRunningSubagentToolRow(input: {
  transcript: AgentStoredEvent[];
  conversationId: string;
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
}): void {
  input.transcript.push({
    // Transcript rows need distinct seqs: projection dedupes stored events by seq.
    seq: input.transcript.length + 1,
    eventId: randomUUID(),
    conversationId: input.conversationId,
    createdAt: Date.now(),
    kind: "tool_call",
    toolCallId: input.toolCallId,
    title: input.name,
    toolKind: "mcp",
    status: "in_progress",
    detail: subagentToolArgsPreview(input.arguments),
  });
}

/** Settle a previously pushed running tool row (or append one when the tool never started, e.g. unknown tool). */
export function settleSubagentToolRow(input: {
  transcript: AgentStoredEvent[];
  conversationId: string;
  toolCallId: string;
  name: string;
  result: string;
  ok: boolean;
}): void {
  const status = input.ok ? ("completed" as const) : ("failed" as const);
  const detail = input.result.slice(0, 600);
  for (let index = input.transcript.length - 1; index >= 0; index -= 1) {
    const row = input.transcript[index]!;
    if (row.kind === "tool_call" && row.toolCallId === input.toolCallId) {
      // Replace instead of mutating: earlier progress emissions shallow-copied
      // the transcript array and must keep their point-in-time row objects.
      input.transcript[index] = { ...row, status, detail };
      return;
    }
  }
  input.transcript.push({
    seq: input.transcript.length + 1,
    eventId: randomUUID(),
    conversationId: input.conversationId,
    createdAt: Date.now(),
    kind: "tool_call",
    toolCallId: input.toolCallId,
    title: input.name,
    toolKind: "mcp",
    status,
    detail,
  });
}

/** Most recent human-readable activity from a subagent transcript, for the collapsed card. */
export function latestSubagentTranscriptActivity(
  transcript: AgentStoredEvent[]
): string | null {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const event = transcript[index]!;
    if (event.kind === "tool_call" && event.title) {
      return event.status === "in_progress" ? `Running ${event.title}` : event.title;
    }
    if (event.kind === "assistant_message_chunk" && event.text.trim()) {
      return event.text.trim().slice(0, 240);
    }
  }
  return null;
}

/**
 * Minimal assistant/tool round-trip loop for subagent turns. Mirrors the main
 * Cesium turn loop: assistant tool_calls followed by tool results, with no
 * iteration cap. The loop ends when the model returns a final answer, the
 * child has no toolset, or the run is aborted.
 */
export async function runSubagentToolLoop(input: {
  adapter: {
    apiKind: CesiumProviderKind;
    apiKey: string;
    baseUrl?: string;
    oauth?: import("./cesium-model-adapters.js").CesiumOAuthAdapterAuth;
    providerId: string;
    modelId: string;
  };
  messages: CesiumHistoryMessage[];
  toolset?: CesiumSubagentToolset | null;
  isAborted?: () => boolean;
  /** Fires before a tool executes so live progress can show in-flight work, not just results. */
  onToolCallStart?: (event: SubagentToolLoopToolStartEvent) => void | Promise<void>;
  onToolCall?: (event: SubagentToolLoopToolEvent) => void | Promise<void>;
  /** Test seam: overrides the model adapter call. */
  runAdapterImpl?: typeof runAdapter;
}): Promise<SubagentToolLoopResult> {
  const toolset = input.toolset ?? null;
  const tools = toolset?.tools ?? [];
  const adapterImpl = input.runAdapterImpl ?? runAdapter;
  const messages: CesiumHistoryMessage[] = [...input.messages];
  let usedToolResultChars = 0;
  let toolCallCount = 0;
  let lastResult: CesiumAdapterResult | null = null;

  for (let iteration = 0; ; iteration += 1) {
    if (input.isAborted?.()) {
      return { text: lastResult?.text ?? "", toolCallCount };
    }
    const result = await adapterImpl({
      apiKind: input.adapter.apiKind,
      apiKey: input.adapter.apiKey,
      baseUrl: input.adapter.baseUrl,
      providerId: input.adapter.providerId,
      oauth: input.adapter.oauth,
      modelId: input.adapter.modelId,
      messages,
      // Explicit empty array when no toolset: adapters omit tools from the
      // provider payload instead of exposing the full default tool surface.
      tools,
    });
    lastResult = result;
    if (result.toolRequests.length === 0 || !toolset) {
      return { text: result.text, toolCallCount };
    }
    messages.push({
      role: "assistant",
      content: result.text.trim(),
      toolCalls: result.toolRequests.map((request) => ({
        id: request.id,
        name: request.name,
        arguments: JSON.stringify(request.arguments),
      })),
    });
    for (const request of result.toolRequests) {
      if (input.isAborted?.()) {
        return { text: result.text, toolCallCount };
      }
      let toolResult = "";
      let ok = true;
      if (!toolset.toolNames.has(request.name)) {
        ok = false;
        toolResult = `Tool ${request.name} is not available to this subagent. Available tools: ${[...toolset.toolNames].join(", ")}.`;
      } else {
        await input.onToolCallStart?.({
          toolCallId: request.id,
          name: request.name,
          arguments: request.arguments,
        });
        try {
          toolResult = await toolset.execute(request.name, request.arguments);
        } catch (error) {
          ok = false;
          toolResult = `Tool ${request.name} failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }
      toolCallCount += 1;
      const normalized = normalizeCesiumToolResultForModel({
        toolName: request.name,
        result: toolResult,
        usedToolResultChars,
      });
      usedToolResultChars = normalized.usedToolResultChars;
      messages.push({
        role: "tool",
        toolCallId: request.id,
        name: request.name,
        content: normalized.content,
      });
      await input.onToolCall?.({
        toolCallId: request.id,
        name: request.name,
        arguments: request.arguments,
        result: toolResult,
        ok,
      });
    }
  }
}
