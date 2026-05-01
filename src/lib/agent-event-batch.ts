import {
  dedupeAgentStoredEvents,
  isIncomingEventDroppedByAcpToolStrip,
} from "@/lib/agent-chat";
import type { AgentStoredEvent } from "@/lib/agent-types";

export function mergeIncomingEventBatch(
  existing: AgentStoredEvent[],
  incoming: AgentStoredEvent[]
): AgentStoredEvent[] | null {
  if (incoming.length === 0) {
    return null;
  }

  const seqs = new Set(existing.map((event) => event.seq));
  const eventIds = new Set(existing.map((event) => event.eventId));
  const accepted: AgentStoredEvent[] = [];
  let appendOnly = true;
  let tailSeq = existing.at(-1)?.seq ?? -1;

  for (const event of incoming) {
    if (seqs.has(event.seq) || eventIds.has(event.eventId)) {
      continue;
    }
    const prior = accepted.length > 0 ? [...existing, ...accepted] : existing;
    if (isIncomingEventDroppedByAcpToolStrip(prior, event)) {
      continue;
    }
    if (event.seq <= tailSeq) {
      appendOnly = false;
    }
    tailSeq = Math.max(tailSeq, event.seq);
    seqs.add(event.seq);
    eventIds.add(event.eventId);
    accepted.push(event);
  }

  if (accepted.length === 0) {
    return null;
  }

  if (appendOnly) {
    return [...existing, ...accepted];
  }

  return dedupeAgentStoredEvents([...existing, ...accepted]).sort(
    (a, b) => a.seq - b.seq
  );
}
