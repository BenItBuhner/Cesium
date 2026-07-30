import {
  buildCesiumBaseSystemPrompt,
} from "@cesium/core/mcp";
import { resolveCesiumModelContextWindow } from "../cesium-agent-settings.js";
import { buildOpenAiToolDefinitions, normalizeEventsToHistory } from "./cesium-provider.js";
import { latestCompressionSummaryEvent } from "./cesium/cesium-compaction.js";
import { compressionSummaryCoveredToSeq } from "./cesium/cesium-history.js";
import type {
  AgentContextUsageCategory,
  AgentContextUsageCategoryId,
  AgentContextUsageSnapshot,
  AgentConversationRecord,
  AgentStoredEvent,
} from "./types.js";
import type { WorkspaceRecord } from "../workspace-registry.js";
import { readConversationSnapshot } from "./session-store.js";

const SYSTEM_PROMPT_CACHE_TTL_MS = 60_000;
const USAGE_SNAPSHOT_CACHE_TTL_MS = 15_000;

let cachedToolDefinitionsText: string | null = null;

const systemPromptCache = new Map<string, { expiresAt: number; prompt: string }>();
const usageSnapshotCache = new Map<
  string,
  { expiresAt: number; lastEventSeq: number; snapshot: AgentContextUsageSnapshot }
>();

function toolDefinitionsText(): string {
  if (!cachedToolDefinitionsText) {
    cachedToolDefinitionsText = JSON.stringify(buildOpenAiToolDefinitions());
  }
  return cachedToolDefinitionsText;
}

function systemPromptCacheKey(
  workspaceId: string,
  conversation: AgentConversationRecord
): string {
  return [
    workspaceId,
    conversation.config.backendId ?? "",
  ].join(":");
}

function estimateTokensFromText(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  return Math.ceil(trimmed.length / 4);
}

function estimateTokensFromMessages(
  messages: ReturnType<typeof normalizeEventsToHistory>
): number {
  let chars = 0;
  for (const message of messages) {
    if (typeof message.content === "string") {
      chars += message.content.length;
    } else if (message.content != null) {
      chars += JSON.stringify(message.content).length;
    }
    if (message.toolCalls) {
      chars += JSON.stringify(message.toolCalls).length;
    }
  }
  return Math.ceil(chars / 4);
}

function rawConversationEventText(event: AgentStoredEvent): string {
  switch (event.kind) {
    case "user_message":
      return event.hidden ? "" : event.content;
    case "system_reminder":
      if (event.reason === "goal" || event.reason === "burn") return "";
      return event.text;
    case "assistant_message_chunk":
    case "reasoning":
      return event.text;
    case "tool_call":
    case "tool_call_update":
      return JSON.stringify({
        title: event.title,
        toolKind: event.toolKind,
        status: event.status,
        detail: event.detail,
        locations: event.locations,
        editPreview: event.editPreview,
      });
    case "plan":
      return event.entries.map((entry) => `${entry.status}: ${entry.content}`).join("\n");
    case "plan_file":
      return [event.title, event.path].filter(Boolean).join("\n");
    case "subagent":
      return JSON.stringify({
        title: event.title,
        meta: event.meta,
        status: event.status,
        recentActivity: event.recentActivity,
        transcript: event.transcript,
      });
    case "question":
      return JSON.stringify({
        prompt: event.prompt,
        questions: event.questions,
        options: event.options,
        answer: event.answer,
        status: event.status,
      });
    case "permission_request":
      return JSON.stringify({
        title: event.title,
        detail: event.detail,
        options: event.options,
      });
    case "chat_fork":
      return event.transcript;
    case "agent_handoff":
      return `${event.fromAgent} -> ${event.toAgent}`;
    case "compression_summary":
      return event.summary;
    case "assistant_message_end":
    case "permission_resolved":
    case "system":
    case "status":
      return "";
  }
}

function estimateTokensFromRawConversationEvents(events: AgentStoredEvent[]): number {
  const text = events
    .map(rawConversationEventText)
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  return estimateTokensFromText(text);
}

function estimateConversationTokens(events: AgentStoredEvent[]): number {
  const normalized = estimateTokensFromMessages(historyMessagesWithoutSystem(events));
  const raw = estimateTokensFromRawConversationEvents(events);
  return Math.max(normalized, raw);
}

function splitSystemPrompt(full: string): { base: string; mcp: string } {
  const marker = "\n\n---\n\n## Third-Party & MCP Server Tools";
  const index = full.indexOf(marker);
  if (index < 0) {
    return { base: full, mcp: "" };
  }
  return {
    base: full.slice(0, index).trimEnd(),
    mcp: full.slice(index).trim(),
  };
}

/**
 * Split events at the latest compaction coverage boundary: events at or below
 * the boundary live only inside the ledger; newer non-summary events are live
 * conversation context. Mirrors normalizeEventsToHistory's layered assembly.
 */
function splitEventsForContext(events: AgentStoredEvent[]): {
  retained: AgentStoredEvent[];
  latestSummary: Extract<AgentStoredEvent, { kind: "compression_summary" }> | null;
} {
  const latestSummary = latestCompressionSummaryEvent(events);
  if (!latestSummary) {
    return {
      retained: events.filter((event) => event.kind !== "compression_summary"),
      latestSummary: null,
    };
  }
  const coveredToSeq = compressionSummaryCoveredToSeq(latestSummary);
  return {
    retained: events.filter(
      (event) =>
        event.kind !== "compression_summary" &&
        (event.seq <= 0 || event.seq > coveredToSeq)
    ),
    latestSummary,
  };
}

function historyMessagesWithoutSystem(
  events: AgentStoredEvent[]
): ReturnType<typeof normalizeEventsToHistory> {
  return normalizeEventsToHistory(events).filter((message) => message.role !== "system");
}

function summarizedConversationTokens(
  latestSummary: Extract<AgentStoredEvent, { kind: "compression_summary" }> | null
): number {
  if (!latestSummary) {
    return 0;
  }
  return estimateTokensFromText(latestSummary.summary);
}

async function resolveCesiumSystemPromptForUsage(input: {
  workspace: WorkspaceRecord;
  conversation: AgentConversationRecord;
}): Promise<string> {
  const cacheKey = systemPromptCacheKey(input.workspace.id, input.conversation);
  const cached = systemPromptCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.prompt;
  }
  const prompt = buildCesiumBaseSystemPrompt();
  systemPromptCache.set(cacheKey, {
    expiresAt: Date.now() + SYSTEM_PROMPT_CACHE_TTL_MS,
    prompt,
  });
  return prompt;
}

export function estimateCesiumContextUsageFromParts(input: {
  systemPromptFull: string;
  events: AgentStoredEvent[];
  limitTokens: number;
}): AgentContextUsageSnapshot {
  const { base, mcp } = splitSystemPrompt(input.systemPromptFull);
  const toolsText = toolDefinitionsText();
  const { retained: retainedWithoutSummaries, latestSummary } = splitEventsForContext(
    input.events
  );

  const categoryRows: Array<{
    id: AgentContextUsageCategoryId;
    label: string;
    tokens: number;
    colorKey: string;
  }> = [
    {
      id: "system_prompt",
      label: "System prompt",
      tokens: estimateTokensFromText(base),
      colorKey: "system",
    },
    {
      id: "tool_definitions",
      label: "Tool definitions",
      tokens: estimateTokensFromText(toolsText),
      colorKey: "tools",
    },
    {
      id: "mcp",
      label: "MCP",
      tokens: estimateTokensFromText(mcp),
      colorKey: "mcp",
    },
    {
      id: "summarized_conversation",
      label: "Summarized conversation",
      tokens: summarizedConversationTokens(latestSummary),
      colorKey: "summarized",
    },
    {
      id: "conversation",
      label: "Conversation",
      tokens: estimateConversationTokens(retainedWithoutSummaries),
      colorKey: "conversation",
    },
  ];
  const categories: AgentContextUsageCategory[] = categoryRows.filter(
    (row) =>
      row.tokens > 0 ||
      (row.id === "conversation" && retainedWithoutSummaries.length > 0)
  );

  const usedTokens = categories.reduce((sum, row) => sum + row.tokens, 0);
  const limitTokens = input.limitTokens;
  const percentFull =
    limitTokens > 0 ? Math.min(100, Math.round((usedTokens / limitTokens) * 100)) : 0;

  return {
    supported: true,
    limitTokens,
    usedTokens,
    percentFull,
    categories,
    approximate: true,
  };
}

export async function computeCesiumAgentContextUsage(input: {
  workspace: WorkspaceRecord;
  conversation: AgentConversationRecord;
}): Promise<AgentContextUsageSnapshot> {
  const lastEventSeq = input.conversation.lastEventSeq ?? 0;
  const usageCacheKey = `${input.workspace.id}:${input.conversation.id}`;
  const cachedUsage = usageSnapshotCache.get(usageCacheKey);
  const isActiveTurn =
    input.conversation.status === "running" ||
    input.conversation.status === "awaiting_permission";
  if (
    !isActiveTurn &&
    cachedUsage &&
    cachedUsage.lastEventSeq === lastEventSeq &&
    cachedUsage.expiresAt > Date.now()
  ) {
    return cachedUsage.snapshot;
  }

  const snapshot = await readConversationSnapshot(
    input.workspace.id,
    input.conversation.id,
    input.conversation
  );
  const events = snapshot?.events ?? [];
  const systemPromptFull = await resolveCesiumSystemPromptForUsage(input);
  const limitTokens = await resolveCesiumModelContextWindow(
    input.conversation.config.modelId ?? "openai/gpt-5.1"
  );
  const result = estimateCesiumContextUsageFromParts({
    systemPromptFull,
    events,
    limitTokens,
  });
  usageSnapshotCache.set(usageCacheKey, {
    expiresAt: Date.now() + USAGE_SNAPSHOT_CACHE_TTL_MS,
    lastEventSeq,
    snapshot: result,
  });
  return result;
}

export function unsupportedContextUsageSnapshot(): AgentContextUsageSnapshot {
  return {
    supported: false,
    limitTokens: 0,
    usedTokens: 0,
    percentFull: 0,
    categories: [],
    approximate: true,
  };
}
