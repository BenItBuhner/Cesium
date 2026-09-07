import { buildCesiumBaseSystemPrompt } from "@cesium/core/mcp";
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
import { buildOpenAiToolDefinitions, resolveCesiumTools } from "./cesium/cesium-tools.js";
import { filterCesiumToolsForProfile, resolveCesiumProfile } from "./cesium-profiles.js";
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
 * the MCP bucket. Works for both prompt builders: the profile prompt joins
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

function conversationProfileId(conversation: AgentConversationRecord): string | null {
  const option = conversation.configOptions?.find((entry) => entry.id === "profile");
  const raw = option?.currentValue;
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  return conversation.config.profileId?.trim() || null;
}

/**
 * Resolve the prompt + tool schemas the way the live session does (profile
 * base, verbatim profile instructions, profile tool envelope). Per-turn
 * additions the runtime layers on top - plugin prompt transforms and the
 * model roster appended to spawn tools - are not reproduced here.
 */
async function resolveCesiumPromptContext(input: {
  workspace: WorkspaceRecord;
  conversation: AgentConversationRecord;
}): Promise<CesiumPromptContext> {
  const profileId = conversationProfileId(input.conversation);
  const cacheKey = [
    input.workspace.id,
    input.conversation.config.backendId ?? "",
    profileId ?? "default",
  ].join(":");
  const cached = promptContextCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  let value: CesiumPromptContext;
  try {
    const settings = await getCesiumAgentSettings();
    const profile = resolveCesiumProfile({
      profileId,
      customProfiles: settings.profiles,
      defaultProfileId: settings.defaultProfileId,
    });
    const tools = filterCesiumToolsForProfile(
      resolveCesiumTools(settings.harness).tools,
      profile
    );
    value = {
      systemPromptFull: buildCesiumBaseSystemPrompt({
        base: profile.prompt.base,
        customInstructions: profile.prompt.customInstructions,
      }),
      toolDefinitions: buildOpenAiToolDefinitions(tools),
      notes: [
        `System prompt and tool schemas resolved from the "${profile.name}" agent profile. ` +
          "Per-turn runtime additions (plugin prompt transforms, the subagent model roster) are not included.",
      ],
    };
  } catch {
    value = {
      systemPromptFull: buildCesiumBaseSystemPrompt(),
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
};

/**
 * Mirror the provider's compaction rule so the estimate reflects what the
 * next turn actually sends: once the visible turn count or the estimated
 * size crosses the threshold, only the newest
 * `HISTORY_COMPACTION_TARGET_TURNS` turns (plus any compaction summaries
 * inside that window) survive.
 */
function retainEntriesForContext(input: {
  entries: AgentContextTranscriptEntry[];
  events: AgentStoredEvent[];
  systemTokens: number;
  limitTokens: number;
}): { retained: AgentContextTranscriptEntry[]; compacted: boolean; droppedTurns: number } {
  const visibleUserSeqs = input.events
    .filter((event) => event.kind === "user_message" && !event.hidden)
    .map((event) => event.seq)
    .sort((a, b) => a - b);
  const estimatedTokensBefore =
    input.systemTokens + input.entries.reduce((sum, entry) => sum + entry.tokens, 0);
  const shouldCompact =
    visibleUserSeqs.length > HISTORY_TURN_LIMIT ||
    (input.limitTokens > 0 &&
      estimatedTokensBefore >= input.limitTokens * HISTORY_COMPACTION_THRESHOLD_RATIO);
  if (!shouldCompact || visibleUserSeqs.length === 0) {
    return { retained: input.entries, compacted: false, droppedTurns: 0 };
  }
  const splitIndex = Math.max(0, visibleUserSeqs.length - HISTORY_COMPACTION_TARGET_TURNS);
  const splitSeq = visibleUserSeqs[splitIndex] ?? 0;
  return {
    retained: input.entries.filter((entry) => (entry.seqStart ?? 0) >= splitSeq),
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
  });
  return {
    entries: [...staticEntries.filter((entry) => entry.tokens > 0), ...retained],
    compacted,
    droppedTurns,
  };
}

export function estimateCesiumContextUsageFromParts(
  input: CesiumContextParts
): AgentContextUsageSnapshot {
  const { entries } = buildCesiumContextEntries(input);
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
    approximate: true,
    timeline,
  };
}

export function buildCesiumContextTranscriptFromParts(
  input: CesiumContextParts & {
    conversation: Pick<AgentConversationRecord, "id" | "config">;
    notes?: string[];
  }
): AgentContextTranscript {
  const { entries, compacted, droppedTurns } = buildCesiumContextEntries(input);
  const timeline = entries.map(contextEntryToSegment);
  const categories = poolContextEntries(timeline);
  const usedTokens = categories.reduce((sum, row) => sum + row.tokens, 0);
  const limitTokens = input.limitTokens;
  const notes = [...(input.notes ?? [])];
  notes.push(
    "Token counts are character-based estimates (about four characters per token)."
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
      approximate: true,
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
  const limitTokens = await resolveCesiumModelContextWindow(
    input.conversation.config.modelId ?? "openai/gpt-5.1"
  );
  return {
    systemPromptFull: promptContext.systemPromptFull,
    toolDefinitions: promptContext.toolDefinitions,
    events: snapshot?.events ?? [],
    limitTokens,
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
