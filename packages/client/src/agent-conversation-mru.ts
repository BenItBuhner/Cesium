import { AGENT_NEW_CHAT_SESSION_ID } from "./workspace-session";

export const AGENT_CONVERSATION_MRU_MAX = 50;

export type AgentSwitcherCandidate = {
  id: string;
  title: string;
  updatedAt: number;
  workspaceId: string;
  workspaceName: string;
  serverId?: string;
  badge?: string;
};

export function isValidAgentConversationMruId(conversationId: string): boolean {
  const trimmed = conversationId.trim();
  return trimmed.length > 0 && trimmed !== AGENT_NEW_CHAT_SESSION_ID;
}

export function bumpAgentConversationMru(
  conversationId: string,
  stack: readonly string[],
  max = AGENT_CONVERSATION_MRU_MAX
): string[] {
  if (!isValidAgentConversationMruId(conversationId)) {
    return [...stack];
  }
  const without = stack.filter((id) => id !== conversationId);
  return [conversationId, ...without].slice(0, max);
}

function compareCandidatesByActivity(
  a: AgentSwitcherCandidate,
  b: AgentSwitcherCandidate
): number {
  if (b.updatedAt !== a.updatedAt) {
    return b.updatedAt - a.updatedAt;
  }
  return a.id.localeCompare(b.id);
}

export function buildAgentSwitcherList(input: {
  mruIds: readonly string[];
  candidates: readonly AgentSwitcherCandidate[];
}): AgentSwitcherCandidate[] {
  const byId = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  const ordered: AgentSwitcherCandidate[] = [];

  for (const id of input.mruIds) {
    if (seen.has(id)) {
      continue;
    }
    const candidate = byId.get(id);
    if (!candidate) {
      continue;
    }
    seen.add(id);
    ordered.push(candidate);
  }

  const tail = input.candidates
    .filter((candidate) => !seen.has(candidate.id))
    .sort(compareCandidatesByActivity);

  return [...ordered, ...tail];
}

export function seedAgentConversationMruFromCandidates(
  candidates: readonly AgentSwitcherCandidate[],
  max = AGENT_CONVERSATION_MRU_MAX
): string[] {
  return [...candidates]
    .sort(compareCandidatesByActivity)
    .map((candidate) => candidate.id)
    .slice(0, max);
}

export function nextAgentSwitcherIndex(
  currentIndex: number,
  length: number,
  delta: 1 | -1
): number {
  if (length <= 0) {
    return 0;
  }
  let next = currentIndex + delta;
  while (next < 0) {
    next += length;
  }
  while (next >= length) {
    next -= length;
  }
  return next;
}

/** Index to highlight when opening forward/back from the current conversation. */
export function initialAgentSwitcherIndex(
  currentConversationId: string | null | undefined,
  items: readonly AgentSwitcherCandidate[],
  direction: 1 | -1
): number {
  if (items.length === 0) {
    return 0;
  }
  if (!currentConversationId) {
    return direction > 0 ? 0 : items.length - 1;
  }
  const currentIndex = items.findIndex((item) => item.id === currentConversationId);
  if (currentIndex < 0) {
    return direction > 0 ? 0 : items.length - 1;
  }
  return nextAgentSwitcherIndex(currentIndex, items.length, direction);
}

export function normalizeAgentConversationMruByServer(
  raw: unknown
): Record<string, string[]> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const result: Record<string, string[]> = {};
  for (const [serverId, value] of Object.entries(raw)) {
    if (typeof serverId !== "string" || !serverId.trim() || !Array.isArray(value)) {
      continue;
    }
    const ids = value
      .filter((id): id is string => typeof id === "string" && isValidAgentConversationMruId(id))
      .slice(0, AGENT_CONVERSATION_MRU_MAX);
    if (ids.length > 0) {
      result[serverId] = ids;
    }
  }
  return result;
}
