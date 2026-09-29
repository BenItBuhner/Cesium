import { buildCesiumBaseSystemPrompt } from "@cesium/core/mcp";
import { resolveModelDisplayName } from "@cesium/core/model-display-name";
import {
  getCesiumAgentSettings,
  resolveCesiumModelContextWindow,
} from "../cesium-agent-settings.js";
import type { WorkspaceRecord } from "../workspace-registry.js";
import {
  HISTORY_COMPACTION_TARGET_TURNS,
  HISTORY_COMPACTION_THRESHOLD_RATIO,
  HISTORY_TURN_LIMIT,
} from "./cesium/cesium-prompt.js";
import {
  latestReportedUsage,
  reportedContextTokens,
  selectHistoryWindow,
} from "./cesium/cesium-history.js";
import { hydrateToolResultBlobs } from "./cesium/cesium-tool-result-blobs.js";
import { contextTokensAfterResponse } from "./cesium/cesium-usage.js";
import { buildOpenAiToolDefinitions, resolveCesiumTools } from "./cesium/cesium-tools.js";
import {
  CONTEXT_CATEGORY_COLOR_KEY,
  buildConversationContextEntries,
  contextEntryToSegment,
  estimateContextTokensFromText,
  poolContextEntries,
} from "./context-timeline.js";
import { readConversationSnapshot } from "./session-store.js";
import type {
  AgentContextTranscript,
  AgentContextTranscriptEntry,
  AgentContextUsageSnapshot,
  AgentConversationRecord,
  AgentStoredEvent,
} from "./types.js";

const PROMPT_CONTEXT_CACHE_TTL_MS = 60_000;
const USAGE_SNAPSHOT_CACHE_TTL_MS = 15_000;

export type OpenAiToolDefinitionList = ReturnType<typeof buildOpenAiToolDefinitions>;

type CesiumPromptContext = {
  systemPromptFull: string;
  toolDefinitions: OpenAiToolDefinitionList;
  notes: string[];
};

let cachedDefaultToolDefinitions: OpenAiToolDefinitionList | null = null;

const promptContextCache = new Map<string, { expiresAt: number; value: CesiumPromptContext }>();
const usageSnapshotCache = new Map<
  string,
  { expiresAt: number; lastEventSeq: number; snapshot: AgentContextUsageSnapshot }
>();

function defaultToolDefinitions(): OpenAiToolDefinitionList {
  if (!cachedDefaultToolDefinitions) {
    cachedDefaultToolDefinitions = buildOpenAiToolDefinitions();
  }
  return cachedDefaultToolDefinitions;
}

/**
 * Pull the MCP section out of the system prompt so it can be attributed to
 * the MCP bucket. Works for both prompt builders: the base prompt joins
 * `## ` sections with blank lines, the legacy agent prompt precedes the MCP
 * heading with a `---` rule.
 */
export function splitSystemPrompt(full: string): { base: string; mcp: string } {
  const heading = /^## Third-Party & MCP Server Tools[^\n]*$/m.exec(full);
  if (!heading) {
    return { base: full, mcp: "" };
  }
  const start = heading.index;
  const nextHeading = /^## /m.exec(full.slice(start + heading[0].length));
  const end = nextHeading ? start + heading[0].length + nextHeading.index : full.length;
  const before = full.slice(0, start).replace(/\n+\s*---\s*\n*$/, "\n\n");
  const after = full.slice(end);
  const base = [before.trimEnd(), after.trim()].filter(Boolean).join("\n\n");
  return { base, mcp: full.slice(start, end).trim() };
}

/**
 * Resolve the prompt + tool schemas the way the live session does. Per-turn
 * additions the runtime layers on top - plugin prompt transforms and the
 * model roster appended to spawn tools - are not reproduced here.
 */
async function resolveCesiumPromptContext(input: {
  workspace: WorkspaceRecord;
  conversation: AgentConversationRecord;
}): Promise<CesiumPromptContext> {
  const modelId = input.conversation.config.modelId ?? "";
  const modelName = resolveModelDisplayName(input.conversation.config.modelName, modelId);
  const cacheKey = [
    input.workspace.id,
    input.conversation.config.backendId ?? "",
    modelId,
    modelName,
  ].join(":");
  const cached = promptContextCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  let value: CesiumPromptContext;
  try {
    const settings = await getCesiumAgentSettings();
    const tools = resolveCesiumTools(settings.harness).tools;
    value = {
      systemPromptFull: buildCesiumBaseSystemPrompt({
        modelName,
        workspaceRoot: input.workspace.root,
      }),
      toolDefinitions: buildOpenAiToolDefinitions(tools),
      notes: [
        "Per-turn runtime additions (plugin prompt transforms, the subagent model roster) are not included.",
      ],
    };
  } catch {
    value = {
      systemPromptFull: buildCesiumBaseSystemPrompt({
        modelName,
        workspaceRoot: input.workspace.root,
      }),
      toolDefinitions: defaultToolDefinitions(),
      notes: [
        "Agent settings could not be read; the default Cesium system prompt and tool set are shown.",
      ],
    };
  }
  promptContextCache.set(cacheKey, {
    expiresAt: Date.now() + PROMPT_CONTEXT_CACHE_TTL_MS,
    value,
  });
  return value;
}

export type CesiumContextParts = {
  systemPromptFull: string;
  /** Defaults to the full default Cesium tool set. */
  toolDefinitions?: OpenAiToolDefinitionList;
  events: AgentStoredEvent[];
  limitTokens: number;
  /** The conversation's model; its provider-reported usage anchors the counts. */
  modelId?: string;
};

type ReportedAnchor = {
  /** Provider-reported context size at the newest response. */
  reportedTokens: number;
  /** Whether blocks logged after that response are still estimated. */
  estimatedTail: boolean;
};

/**
 * Scales the estimated blocks up to the newest response the provider counted,
 * so the ring shows real tokens; blocks logged after it keep their estimate.
 */
function anchorEntriesToReportedUsage(
  entries: AgentContextTranscriptEntry[],
  events: AgentStoredEvent[],
  modelId: string | undefined
): { entries: AgentContextTranscriptEntry[]; anchor: ReportedAnchor | null } {
  const latest = modelId ? latestReportedUsage(selectHistoryWindow(events).events, modelId) : null;
  if (!latest) {
    return { entries, anchor: null };
  }
  const covered = (entry: AgentContextTranscriptEntry) =>
    entry.seqStart === undefined || entry.seqStart <= latest.seq;
  const reportedTokens = contextTokensAfterResponse(latest.usage);
  const estimated = entries.filter(covered).reduce((sum, entry) => sum + entry.tokens, 0);
  if (estimated <= 0) {
    return { entries, anchor: null };
  }
  const factor = reportedTokens / estimated;
  let assigned = 0;
  let lastCoveredIndex = -1;
  const scaled = entries.map((entry, index) => {
    if (!covered(entry)) {
      return entry;
    }
    lastCoveredIndex = index;
    const tokens = Math.round(entry.tokens * factor);
    assigned += tokens;
    return { ...entry, tokens };
  });
  if (lastCoveredIndex >= 0) {
    const last = scaled[lastCoveredIndex]!;
    scaled[lastCoveredIndex] = { ...last, tokens: Math.max(0, last.tokens + reportedTokens - assigned) };
  }
  return {
    entries: scaled,
    anchor: { reportedTokens, estimatedTail: entries.some((entry) => !covered(entry)) },
  };
}

/**
 * Mirror the provider's history window: the newest compaction summary opens
 * it and only events after its source range follow. When that window crosses
 * the turn or size threshold, the next turn compacts it down to the newest
 * `HISTORY_COMPACTION_TARGET_TURNS` turns.
 */
function retainEntriesForContext(input: {
  entries: AgentContextTranscriptEntry[];
  events: AgentStoredEvent[];
  systemTokens: number;
  limitTokens: number;
  modelId?: string;
}): { retained: AgentContextTranscriptEntry[]; compacted: boolean; droppedTurns: number } {
  const window = selectHistoryWindow(input.events);
  const summaryEntry = window.summary
    ? input.entries.find(
        (entry) => entry.kind === "compaction_summary" && entry.seqStart === window.summary!.seq
      )
    : undefined;
  const windowStart = window.summary?.sourceRange?.toSeq ?? -1;
  const rangedSummarySeqs = new Set(
    input.events
      .filter((event) => event.kind === "compression_summary" && event.sourceRange)
      .map((event) => event.seq)
  );
  const windowEntries = input.entries.filter(
    (entry) =>
      (entry.seqStart ?? 0) > windowStart &&
      !(entry.kind === "compaction_summary" && rangedSummarySeqs.has(entry.seqStart ?? -1))
  );
  const head = summaryEntry ? [summaryEntry] : [];
  const visibleUserSeqs = window.events
    .filter((event) => event.kind === "user_message" && !event.hidden)
    .map((event) => event.seq);
  const estimatedTokensBefore =
    (input.modelId ? reportedContextTokens(window.events, input.modelId) : null) ??
    input.systemTokens + [...head, ...windowEntries].reduce((sum, entry) => sum + entry.tokens, 0);
  const shouldCompact =
    visibleUserSeqs.length > HISTORY_TURN_LIMIT ||
    (input.limitTokens > 0 &&
      estimatedTokensBefore >= input.limitTokens * HISTORY_COMPACTION_THRESHOLD_RATIO);
  const splitIndex = Math.max(0, visibleUserSeqs.length - HISTORY_COMPACTION_TARGET_TURNS);
  if (!shouldCompact || splitIndex === 0) {
    return {
      retained: [...head, ...windowEntries],
      compacted: Boolean(window.summary),
      droppedTurns: 0,
    };
  }
  const splitSeq = visibleUserSeqs[splitIndex] ?? 0;
  return {
    retained: [...head, ...windowEntries.filter((entry) => (entry.seqStart ?? 0) >= splitSeq)],
    compacted: true,
    droppedTurns: splitIndex,
  };
}

/**
 * Every block of the context window in model order: system prompt, tool
 * schemas, MCP section, then the retained conversation blocks.
 */
export function buildCesiumContextEntries(input: CesiumContextParts): {
  entries: AgentContextTranscriptEntry[];
  compacted: boolean;
  droppedTurns: number;
  anchor: ReportedAnchor | null;
} {
  const { base, mcp } = splitSystemPrompt(input.systemPromptFull);
  const toolDefinitions = input.toolDefinitions ?? defaultToolDefinitions();
  const toolsText = JSON.stringify(toolDefinitions);

  const staticEntries: AgentContextTranscriptEntry[] = [
    {
      id: "system_prompt",
      kind: "system_prompt",
      categoryId: "system_prompt",
      label: "System prompt",
      tokens: estimateContextTokensFromText(base),
      colorKey: CONTEXT_CATEGORY_COLOR_KEY.system_prompt,
      detail: "Persona, environment, and operating instructions",
      text: base,
    },
    {
      id: "tool_definitions",
      kind: "tool_definitions",
      categoryId: "tool_definitions",
      label: "Tool definitions",
      tokens: estimateContextTokensFromText(toolsText),
      colorKey: CONTEXT_CATEGORY_COLOR_KEY.tool_definitions,
      detail: `${toolDefinitions.length} tool schema${toolDefinitions.length === 1 ? "" : "s"}`,
      text: toolsText,
      tools: toolDefinitions.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      })),
    },
  ];
  if (mcp) {
    staticEntries.push({
      id: "mcp_definitions",
      kind: "mcp_definitions",
      categoryId: "mcp",
      label: "MCP servers",
      tokens: estimateContextTokensFromText(mcp),
      colorKey: CONTEXT_CATEGORY_COLOR_KEY.mcp,
      detail: "Connected MCP servers section of the system prompt",
      text: mcp,
    });
  }

  const conversationEntries = buildConversationContextEntries(input.events);
  const { retained, compacted, droppedTurns } = retainEntriesForContext({
    entries: conversationEntries,
    events: input.events,
    systemTokens: staticEntries[0]!.tokens,
    limitTokens: input.limitTokens,
    modelId: input.modelId,
  });
  const estimatedEntries = [...staticEntries.filter((entry) => entry.tokens > 0), ...retained];
  // The next turn compacts: the reported count describes the window it replaces.
  const { entries, anchor } =
    droppedTurns > 0
      ? { entries: estimatedEntries, anchor: null }
      : anchorEntriesToReportedUsage(estimatedEntries, input.events, input.modelId);
  return { entries, compacted, droppedTurns, anchor };
}

export function estimateCesiumContextUsageFromParts(
  input: CesiumContextParts
): AgentContextUsageSnapshot {
  const { entries, anchor } = buildCesiumContextEntries(input);
  const timeline = entries.map(contextEntryToSegment);
  const categories = poolContextEntries(timeline);
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
    approximate: !anchor || anchor.estimatedTail,
    timeline,
  };
}

export function buildCesiumContextTranscriptFromParts(
  input: CesiumContextParts & {
    conversation: Pick<AgentConversationRecord, "id" | "config">;
    notes?: string[];
  }
): AgentContextTranscript {
  const { entries, compacted, droppedTurns, anchor } = buildCesiumContextEntries(input);
  const timeline = entries.map(contextEntryToSegment);
  const categories = poolContextEntries(timeline);
  const usedTokens = categories.reduce((sum, row) => sum + row.tokens, 0);
  const limitTokens = input.limitTokens;
  const notes = [...(input.notes ?? [])];
  notes.push(
    anchor
      ? `Token counts are scaled to the ${anchor.reportedTokens.toLocaleString()} tokens the provider reported for the latest response` +
          (anchor.estimatedTail ? "; blocks logged after it are estimated (about four characters per token)." : ".")
      : "Token counts are character-based estimates (about four characters per token)."
  );
  if (compacted) {
    notes.push(
      `History compaction is active: ${droppedTurns} earlier turn${droppedTurns === 1 ? "" : "s"} ` +
        `are no longer sent verbatim. Only the newest ${HISTORY_COMPACTION_TARGET_TURNS} turns plus ` +
        "compaction summaries reach the model."
    );
  }
  return {
    conversationId: input.conversation.id,
    backendId: input.conversation.config.backendId ?? "cesium-agent",
    modelId: input.conversation.config.modelId ?? null,
    generatedAt: Date.now(),
    usage: {
      supported: true,
      limitTokens,
      usedTokens,
      percentFull:
        limitTokens > 0 ? Math.min(100, Math.round((usedTokens / limitTokens) * 100)) : 0,
      categories,
      approximate: !anchor || anchor.estimatedTail,
      timeline,
    },
    entries,
    notes,
  };
}

async function loadCesiumContextParts(input: {
  workspace: WorkspaceRecord;
  conversation: AgentConversationRecord;
}): Promise<CesiumContextParts & { notes: string[] }> {
  const snapshot = await readConversationSnapshot(
    input.workspace.id,
    input.conversation.id,
    input.conversation
  );
  const promptContext = await resolveCesiumPromptContext(input);
  const modelId = input.conversation.config.modelId || "openai/gpt-5.1";
  const limitTokens = await resolveCesiumModelContextWindow(modelId);
  return {
    systemPromptFull: promptContext.systemPromptFull,
    toolDefinitions: promptContext.toolDefinitions,
    events: await hydrateToolResultBlobs(snapshot?.events ?? []),
    limitTokens,
    modelId,
    notes: promptContext.notes,
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

  const parts = await loadCesiumContextParts(input);
  const result = estimateCesiumContextUsageFromParts(parts);
  usageSnapshotCache.set(usageCacheKey, {
    expiresAt: Date.now() + USAGE_SNAPSHOT_CACHE_TTL_MS,
    lastEventSeq,
    snapshot: result,
  });
  return result;
}

/** Full verbatim context transcript for the Advanced inspector (never cached: it is opened on demand). */
export async function computeCesiumAgentContextTranscript(input: {
  workspace: WorkspaceRecord;
  conversation: AgentConversationRecord;
}): Promise<AgentContextTranscript> {
  const parts = await loadCesiumContextParts(input);
  return buildCesiumContextTranscriptFromParts({
    ...parts,
    conversation: input.conversation,
  });
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
