import type { AgentStoredEvent } from "./protocol";
import { asRecord, asString, truncate, truncateMiddle } from "./cesium-coerce";
import {
  CESIUM_TOOL_RESULT_MODEL_MAX_CHARS,
  normalizeCesiumToolResultForModel,
  prunedToolResultStub,
} from "./cesium-history";

/** The newest tool batches a pruning boundary never touches. */
export const CESIUM_CONTEXT_PRUNE_KEEP_BATCHES = 2;
/** Results shorter than this are not worth a stub. */
export const CESIUM_CONTEXT_PRUNE_MIN_RESULT_CHARS = 1_000;

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
  /** Characters each stub may grow by, e.g. for a summary written after planning. */
  stubExtraChars?: number;
}): { toolCallIds: string[]; freedTokens: number } {
  const keepBatches = input.keepBatches ?? CESIUM_CONTEXT_PRUNE_KEEP_BATCHES;
  const minResultChars = input.minResultChars ?? CESIUM_CONTEXT_PRUNE_MIN_RESULT_CHARS;
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
      stubChars:
        prunedToolResultStub(name, event.detail.length, asString(raw?.spillPath)).length +
        (input.stubExtraChars ?? 0),
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

/** Longest summary a pruned stub carries. */
export const CESIUM_PRUNE_SUMMARY_MAX_CHARS = 400;
/** Characters of one pruned result the summarizer is shown. */
const PRUNE_SUMMARY_INPUT_MAX_CHARS = 8_000;

export type PrunedToolResultForSummary = {
  toolCallId: string;
  toolName: string;
  arguments: string;
  /** The result as the model saw it. */
  output: string;
};

/** The results a boundary is about to prune, as the model saw them, in log order. */
export function prunedResultsForSummary(
  windowEvents: AgentStoredEvent[],
  toolCallIds: string[]
): PrunedToolResultForSummary[] {
  const wanted = new Set(toolCallIds);
  const calls = new Map<string, { name: string; arguments: string }>();
  const results: PrunedToolResultForSummary[] = [];
  for (const event of [...windowEvents].sort((a, b) => a.seq - b.seq)) {
    if (event.kind === "tool_call" && wanted.has(event.toolCallId)) {
      const raw = asRecord(event.raw);
      const request = asRecord(raw?.request) ?? raw;
      calls.set(event.toolCallId, {
        name: asString(request?.name) ?? event.title.split(" ")[0] ?? "tool",
        arguments: event.detail ?? "",
      });
      continue;
    }
    if (event.kind !== "tool_call_update" || event.status !== "completed" || !event.detail) {
      continue;
    }
    const call = calls.get(event.toolCallId);
    if (!call) {
      continue;
    }
    const raw = asRecord(event.raw);
    const seen = normalizeCesiumToolResultForModel({
      toolName: call.name,
      result: event.detail,
      budget: typeof raw?.modelBudget === "number" ? raw.modelBudget : undefined,
      spillPath: asString(raw?.spillPath),
    }).content;
    results.push({
      toolCallId: event.toolCallId,
      toolName: call.name,
      arguments: truncate(call.arguments, 500),
      output: truncateMiddle(seen, PRUNE_SUMMARY_INPUT_MAX_CHARS),
    });
  }
  return results;
}

export const PRUNE_SUMMARY_SYSTEM_PROMPT =
  "You condense tool outputs that are about to be removed from a coding agent's context. " +
  "For each output, write what the agent would need to remember without re-running the tool: " +
  "the facts it established, exact file paths, symbols, line numbers, versions, counts, and any error text. " +
  "Do not describe the tool itself or give advice. Reply with one JSON object and nothing else.";

export function buildPruneSummaryPrompt(results: PrunedToolResultForSummary[], maxChars: number): string {
  const blocks: string[] = [];
  let used = 0;
  for (const result of results) {
    const block = `### ${result.toolCallId}\nTool: ${result.toolName}\nArguments: ${result.arguments}\nOutput:\n${result.output}`;
    if (used + block.length > maxChars && blocks.length > 0) {
      break;
    }
    blocks.push(block);
    used += block.length;
  }
  return (
    `Summarize each tool output below in at most ${CESIUM_PRUNE_SUMMARY_MAX_CHARS} characters. ` +
    'Reply with a JSON object mapping each id (the text after "### ") to its summary.\n\n' +
    blocks.join("\n\n")
  );
}

/**
 * Summaries from the model's reply, for the ids asked about only, on one
 * line each and capped. Anything unparseable yields no summaries, so the
 * boundary falls back to plain stubs.
 */
export function parsePruneSummaries(text: string, toolCallIds: string[]): Record<string, string> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return {};
  }
  const record = asRecord(parsed);
  if (!record) {
    return {};
  }
  const summaries: Record<string, string> = {};
  for (const id of toolCallIds) {
    const value = asString(record[id])?.replace(/\s+/g, " ").trim();
    if (value) {
      summaries[id] =
        value.length > CESIUM_PRUNE_SUMMARY_MAX_CHARS
          ? `${value.slice(0, CESIUM_PRUNE_SUMMARY_MAX_CHARS - 1)}…`
          : value;
    }
  }
  return summaries;
}
