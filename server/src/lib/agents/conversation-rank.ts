import type { AgentConversationRecord } from "./types.js";

/**
 * When only these logical fields change, the conversation should not jump in
 * sidebar ordering (which is keyed off `updatedAt`).
 *
 * Title-only renames are rank-neutral: `updatedAt` stays put so the rail does not reshuffle.
 */
export function isAgentConversationRankNeutralDelta(
  prev: AgentConversationRecord,
  next: AgentConversationRecord
): boolean {
  if (prev.lastEventSeq !== next.lastEventSeq) {
    return false;
  }
  if (prev.archivedAt !== next.archivedAt) {
    return false;
  }
  if (prev.experimental !== next.experimental) {
    return false;
  }
  if (prev.providerSessionId !== next.providerSessionId) {
    return false;
  }
  const cfgKey = (r: AgentConversationRecord) =>
    `${r.config.backendId}\0${r.config.mode}\0${r.config.modelId}\0${r.config.modelName ?? ""}`;
  if (cfgKey(prev) !== cfgKey(next)) {
    return false;
  }
  if (JSON.stringify(prev.configOptions) !== JSON.stringify(next.configOptions)) {
    return false;
  }
  if (JSON.stringify(prev.capabilities) !== JSON.stringify(next.capabilities)) {
    return false;
  }
  if (JSON.stringify(prev.queuedPrompts ?? []) !== JSON.stringify(next.queuedPrompts ?? [])) {
    return false;
  }
  return true;
}
