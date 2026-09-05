import path from "node:path";
import { promises as fs } from "node:fs";
import { DATA_DIR, readJsonFile, writeJsonFile } from "../persistence.js";
import type {
  AgentContextUsageCategory,
  AgentContextUsageCategoryId,
  AgentContextUsageSnapshot,
} from "./types.js";

/**
 * Cesium-side memory for a Claude Code conversation. The runtime manager
 * clears `providerSessionId` whenever a turn is cancelled, but Claude's own
 * transcript (`~/.claude/projects/<cwd>/<session>.jsonl`) is still resumable -
 * this record lets the next `startSession` pick the native session back up
 * instead of starting from an empty context.
 */
export type ClaudeCodeSdkConversationState = {
  schemaVersion: 1;
  workspaceId: string;
  conversationId: string;
  /** Last Claude session UUID observed for this conversation. */
  sessionId: string | null;
  /** Workspace root the session was recorded under (Claude namespaces transcripts by cwd). */
  cwd: string | null;
  updatedAt: number;
  contextUsage?: ClaudeCodeSdkContextUsage | null;
};

export type ClaudeCodeSdkContextUsage = {
  /** Tokens in the model's context at the last request (input + cache read + cache creation). */
  contextTokens: number;
  /** Context window reported by the CLI for the model, when known. */
  contextWindow: number | null;
  model: string | null;
  updatedAt: number;
  /** Category breakdown from `Query.getContextUsage()` when the probe ran. */
  categories?: Array<{ id: AgentContextUsageCategoryId; label: string; tokens: number }>;
  source: "assistant_usage" | "context_probe";
};

const DEFAULT_CONTEXT_WINDOW = 200_000;

function stateFilePath(workspaceId: string, conversationId: string): string {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(
    DATA_DIR,
    "claude-code-sdk",
    "conversations",
    safe(workspaceId),
    `${safe(conversationId)}.json`
  );
}

const memoryCache = new Map<string, ClaudeCodeSdkConversationState>();

function cacheKey(workspaceId: string, conversationId: string): string {
  return `${workspaceId}:${conversationId}`;
}

function normalizeState(
  raw: unknown,
  workspaceId: string,
  conversationId: string
): ClaudeCodeSdkConversationState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    return null;
  }
  const usage =
    record.contextUsage && typeof record.contextUsage === "object"
      ? (record.contextUsage as ClaudeCodeSdkContextUsage)
      : null;
  return {
    schemaVersion: 1,
    workspaceId,
    conversationId,
    sessionId: typeof record.sessionId === "string" && record.sessionId ? record.sessionId : null,
    cwd: typeof record.cwd === "string" && record.cwd ? record.cwd : null,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
    contextUsage:
      usage && typeof usage.contextTokens === "number"
        ? {
            contextTokens: usage.contextTokens,
            contextWindow: typeof usage.contextWindow === "number" ? usage.contextWindow : null,
            model: typeof usage.model === "string" ? usage.model : null,
            updatedAt: typeof usage.updatedAt === "number" ? usage.updatedAt : 0,
            source: usage.source === "context_probe" ? "context_probe" : "assistant_usage",
            ...(Array.isArray(usage.categories) ? { categories: usage.categories } : {}),
          }
        : null,
  };
}

export async function readClaudeCodeSdkConversationState(
  workspaceId: string,
  conversationId: string
): Promise<ClaudeCodeSdkConversationState | null> {
  const key = cacheKey(workspaceId, conversationId);
  const cached = memoryCache.get(key);
  if (cached) {
    return cached;
  }
  const raw = await readJsonFile<unknown>(stateFilePath(workspaceId, conversationId), null);
  const state = normalizeState(raw, workspaceId, conversationId);
  if (state) {
    memoryCache.set(key, state);
  }
  return state;
}

export async function writeClaudeCodeSdkConversationState(
  workspaceId: string,
  conversationId: string,
  patch: Partial<Pick<ClaudeCodeSdkConversationState, "sessionId" | "cwd" | "contextUsage">>
): Promise<ClaudeCodeSdkConversationState> {
  const current = await readClaudeCodeSdkConversationState(workspaceId, conversationId);
  const next: ClaudeCodeSdkConversationState = {
    schemaVersion: 1,
    workspaceId,
    conversationId,
    sessionId: patch.sessionId !== undefined ? patch.sessionId : current?.sessionId ?? null,
    cwd: patch.cwd !== undefined ? patch.cwd : current?.cwd ?? null,
    updatedAt: Date.now(),
    contextUsage:
      patch.contextUsage !== undefined ? patch.contextUsage : current?.contextUsage ?? null,
  };
  memoryCache.set(cacheKey(workspaceId, conversationId), next);
  await writeJsonFile(stateFilePath(workspaceId, conversationId), next).catch((error: unknown) => {
    console.warn(
      "[claude-code-sdk] failed to persist conversation state:",
      error instanceof Error ? error.message : error
    );
  });
  return next;
}

export async function deleteClaudeCodeSdkConversationState(
  workspaceId: string,
  conversationId: string
): Promise<void> {
  memoryCache.delete(cacheKey(workspaceId, conversationId));
  await fs.unlink(stateFilePath(workspaceId, conversationId)).catch(() => undefined);
}

/** Test seam: drop in-memory state so a fresh read hits disk. */
export function resetClaudeCodeSdkConversationStateCache(): void {
  memoryCache.clear();
}

const CATEGORY_COLORS: Record<AgentContextUsageCategoryId, string> = {
  system_prompt: "system",
  tool_definitions: "tools",
  mcp: "mcp",
  summarized_conversation: "summarized",
  conversation: "conversation",
};

const CATEGORY_LABELS: Record<AgentContextUsageCategoryId, string> = {
  system_prompt: "System prompt",
  tool_definitions: "Tool definitions",
  mcp: "MCP",
  summarized_conversation: "Summarized conversation",
  conversation: "Conversation",
};

/**
 * Maps the CLI's `/context` category names onto Cesium's fixed category ids.
 * Unknown categories fold into the system prompt bucket; "free space" and
 * buffer rows are not usage and are dropped.
 */
export function mapClaudeContextCategory(name: string): AgentContextUsageCategoryId | null {
  const normalized = name.trim().toLowerCase();
  if (!normalized || normalized.includes("free space") || normalized.includes("buffer")) {
    return null;
  }
  if (normalized.includes("mcp")) {
    return "mcp";
  }
  if (normalized.includes("tool")) {
    return "tool_definitions";
  }
  if (normalized.includes("message") || normalized.includes("conversation")) {
    return "conversation";
  }
  if (normalized.includes("summary") || normalized.includes("compact")) {
    return "summarized_conversation";
  }
  return "system_prompt";
}

export function claudeCodeSdkContextUsageSnapshot(
  usage: ClaudeCodeSdkContextUsage | null | undefined
): AgentContextUsageSnapshot {
  if (!usage || usage.contextTokens <= 0) {
    return {
      supported: true,
      limitTokens: usage?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      usedTokens: 0,
      percentFull: 0,
      categories: [],
      approximate: true,
    };
  }
  const limitTokens = usage.contextWindow && usage.contextWindow > 0 ? usage.contextWindow : DEFAULT_CONTEXT_WINDOW;
  const buckets = new Map<AgentContextUsageCategoryId, number>();
  if (usage.categories && usage.categories.length > 0) {
    for (const category of usage.categories) {
      buckets.set(category.id, (buckets.get(category.id) ?? 0) + Math.max(0, category.tokens));
    }
  } else {
    buckets.set("conversation", usage.contextTokens);
  }
  const categories: AgentContextUsageCategory[] = (
    Object.keys(CATEGORY_LABELS) as AgentContextUsageCategoryId[]
  ).map((id) => ({
    id,
    label: CATEGORY_LABELS[id],
    tokens: buckets.get(id) ?? 0,
    colorKey: CATEGORY_COLORS[id],
  }));
  const usedTokens = Math.max(
    usage.contextTokens,
    categories.reduce((sum, category) => sum + category.tokens, 0)
  );
  return {
    supported: true,
    limitTokens,
    usedTokens,
    percentFull: Math.min(100, Math.round((usedTokens / limitTokens) * 1000) / 10),
    categories,
    approximate: usage.source !== "context_probe",
  };
}
