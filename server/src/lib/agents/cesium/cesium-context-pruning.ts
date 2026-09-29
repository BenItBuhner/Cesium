import type { AgentStoredEvent } from "../types.js";
import { asRecord, asString } from "./cesium-coerce.js";
import { prunedToolResultStub } from "./cesium-history.js";
import {
  CESIUM_TOOL_RESULT_MODEL_MAX_CHARS,
  CONTEXT_PRUNE_KEEP_BATCHES,
  CONTEXT_PRUNE_MIN_RESULT_CHARS,
} from "./cesium-prompt.js";

type PruneCandidate = {
  toolCallId: string;
  /** Characters the model currently sees for this result. */
  chars: number;
  /** Characters its stub will take instead. */
  stubChars: number;
};

/**
 * Which tool results a pruning boundary stubs: the oldest ones outside the
 * newest `keepBatches` model responses, until about `excessTokens` are freed.
 * Tool calls from one model response share a batch (their `responseId`);
 * calls logged without one count as a batch each.
 */
export function planToolResultPruning(input: {
  windowEvents: AgentStoredEvent[];
  alreadyPruned: ReadonlySet<string>;
  excessTokens: number;
  keepBatches?: number;
  minResultChars?: number;
}): { toolCallIds: string[]; freedTokens: number } {
  const keepBatches = input.keepBatches ?? CONTEXT_PRUNE_KEEP_BATCHES;
  const minResultChars = input.minResultChars ?? CONTEXT_PRUNE_MIN_RESULT_CHARS;
  if (input.excessTokens <= 0) {
    return { toolCallIds: [], freedTokens: 0 };
  }
  const batchOf = new Map<string, string>();
  const batchOrder: string[] = [];
  const candidates: Array<PruneCandidate & { batch: string }> = [];
  for (const event of [...input.windowEvents].sort((a, b) => a.seq - b.seq)) {
    if (event.kind === "tool_call") {
      const raw = asRecord(event.raw);
      const batch = asString(raw?.responseId) ?? `call:${event.toolCallId}`;
      batchOf.set(event.toolCallId, batch);
      if (!batchOrder.includes(batch)) {
        batchOrder.push(batch);
      }
      continue;
    }
    if (event.kind !== "tool_call_update" || event.status !== "completed" || !event.detail) {
      continue;
    }
    if (input.alreadyPruned.has(event.toolCallId)) {
      continue;
    }
    const raw = asRecord(event.raw);
    const budget = typeof raw?.modelBudget === "number" ? raw.modelBudget : CESIUM_TOOL_RESULT_MODEL_MAX_CHARS;
    const chars = Math.min(event.detail.length, budget);
    if (chars < minResultChars) {
      continue;
    }
    const name = asString(asRecord(raw?.request)?.name) ?? "tool";
    candidates.push({
      toolCallId: event.toolCallId,
      chars,
      stubChars: prunedToolResultStub(name, event.detail.length, asString(raw?.spillPath)).length,
      batch: batchOf.get(event.toolCallId) ?? `call:${event.toolCallId}`,
    });
  }
  const protectedBatches = new Set(batchOrder.slice(-keepBatches));
  const toolCallIds: string[] = [];
  let freedTokens = 0;
  for (const candidate of candidates) {
    if (freedTokens >= input.excessTokens) {
      break;
    }
    if (protectedBatches.has(candidate.batch)) {
      continue;
    }
    toolCallIds.push(candidate.toolCallId);
    freedTokens += Math.floor(Math.max(0, candidate.chars - candidate.stubChars) / 4);
  }
  return { toolCallIds, freedTokens };
}
