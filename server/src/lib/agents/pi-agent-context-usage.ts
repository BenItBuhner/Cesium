import { existsSync } from "node:fs";
import { createPiModelRegistry } from "../pi-agent-settings.js";
import { unsupportedContextUsageSnapshot } from "./cesium-context-usage.js";
import { parsePiModelValue } from "./pi-agent-provider.js";
import type {
  AgentContextUsageCategory,
  AgentContextUsageSnapshot,
  AgentConversationRecord,
} from "./types.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const SNAPSHOT_CACHE_TTL_MS = 10_000;

const snapshotCache = new Map<
  string,
  { expiresAt: number; lastEventSeq: number; snapshot: AgentContextUsageSnapshot }
>();

function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  return trimmed ? Math.ceil(trimmed.length / 4) : 0;
}

/**
 * Context usage for a Pi conversation, read straight from Pi's own session
 * file so it works whether or not a runtime is currently attached (idle
 * runtimes are disposed after a few seconds). Uses the last assistant usage
 * Pi recorded (input + cache reads = what the provider actually held in
 * context) plus Pi's chars/4 estimate for anything appended after it; the
 * model's context window comes from the same registry the composer uses.
 */
export async function computePiAgentContextUsage(
  conversation: AgentConversationRecord
): Promise<AgentContextUsageSnapshot> {
  const sessionFile = conversation.providerSessionId;
  if (!sessionFile || !sessionFile.endsWith(".jsonl") || !existsSync(sessionFile)) {
    return unsupportedContextUsageSnapshot();
  }
  const cached = snapshotCache.get(conversation.id);
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    cached.lastEventSeq === conversation.lastEventSeq
  ) {
    return cached.snapshot;
  }

  const { SessionManager, calculateContextTokens, estimateTokens, getLastAssistantUsage } =
    await import("@earendil-works/pi-coding-agent");
  const sessionManager = SessionManager.open(sessionFile);
  const entries = sessionManager.getEntries();
  const context = sessionManager.buildSessionContext();
  const messages = context.messages;

  const usage = getLastAssistantUsage(entries);
  let usedTokens = 0;
  let approximate = true;
  if (usage) {
    usedTokens = calculateContextTokens(usage);
    approximate = false;
    // Anything after the last completed assistant turn has not been billed yet.
    let lastAssistantIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index] as { role?: string; stopReason?: string };
      if (message.role === "assistant" && message.stopReason !== "aborted") {
        lastAssistantIndex = index;
        break;
      }
    }
    for (const message of messages.slice(lastAssistantIndex + 1)) {
      usedTokens += estimateTokens(message);
      approximate = true;
    }
  } else {
    for (const message of messages) {
      usedTokens += estimateTokens(message);
    }
  }

  let limitTokens = DEFAULT_CONTEXT_WINDOW;
  try {
    const { modelRegistry } = await createPiModelRegistry();
    const parsed =
      parsePiModelValue(conversation.config.modelId) ??
      (context.model ? { provider: context.model.provider, modelId: context.model.modelId } : null);
    const model = parsed ? modelRegistry.find(parsed.provider, parsed.modelId) : undefined;
    if (model?.contextWindow && model.contextWindow > 0) {
      limitTokens = model.contextWindow;
    }
  } catch {
    // Registry unavailable; keep the conservative default window.
  }

  // Pi replaces compacted history with a summary message; surface that split
  // the same way the Cesium harness does so the ring legend stays consistent.
  const latestCompaction = [...entries]
    .reverse()
    .find((entry): entry is Extract<typeof entry, { type: "compaction" }> => entry.type === "compaction");
  const summarizedTokens = latestCompaction ? estimateTextTokens(latestCompaction.summary) : 0;
  const conversationTokens = Math.max(0, usedTokens - summarizedTokens);
  const categories: AgentContextUsageCategory[] = [
    ...(summarizedTokens > 0
      ? [
          {
            id: "summarized_conversation" as const,
            label: "Summarized conversation",
            tokens: summarizedTokens,
            colorKey: "summarized",
          },
        ]
      : []),
    {
      id: "conversation" as const,
      label: "Conversation",
      tokens: conversationTokens,
      colorKey: "conversation",
    },
  ];

  const snapshot: AgentContextUsageSnapshot = {
    supported: true,
    limitTokens,
    usedTokens,
    percentFull: limitTokens > 0 ? Math.min(100, Math.round((usedTokens / limitTokens) * 1000) / 10) : 0,
    categories,
    approximate,
  };
  snapshotCache.set(conversation.id, {
    expiresAt: Date.now() + SNAPSHOT_CACHE_TTL_MS,
    lastEventSeq: conversation.lastEventSeq,
    snapshot,
  });
  return snapshot;
}
