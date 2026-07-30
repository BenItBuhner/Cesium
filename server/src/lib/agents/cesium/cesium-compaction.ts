/**
 * Cesium layered context compaction ("ledger-v1").
 *
 * Design goals (in priority order):
 * 1. Near-lossless retention of durable signal: user intent (verbatim), decisions,
 *    identifiers (paths/commands/errors/ids/numbers), subagent lineage, and
 *    tried-and-failed approaches ("negative knowledge").
 * 2. Anchored, incremental ledger: each compaction MERGES the newly evicted span
 *    into the previous ledger instead of re-summarizing from scratch, which kills
 *    the summary-drift failure mode of regenerate-style compaction.
 * 3. Provenance: every ledger claim carries `[sN]` / `[sN-sM]` event-seq markers so
 *    the model can recover raw verbatim history via `search_history` /
 *    `read_history_page`. Raw events are never deleted from storage.
 * 4. Model agency: the harness warns the model before compaction fires and gives it
 *    `pin_context` (verbatim survival) and `compact_context` (proactive trigger).
 * 5. Controllable intensity: a single 0..1 dial trades post-compaction context fill
 *    (retention / precision) against cost and latency.
 *
 * Pipeline stages:
 *   Stage 0 — trigger check against the context window.
 *   Stage 1 — microcompaction: stub old tool outputs (head+tail excerpt plus a
 *             retrieval breadcrumb). Deterministic, cheap, near-lossless because the
 *             full output stays in the event log.
 *   Stage 2 — ledger compaction: evict the oldest span at a safe turn boundary and
 *             merge it into the structured ledger via an LLM call (with a
 *             verification pass), falling back to a deterministic extractor when no
 *             model is available or the call fails.
 *
 * This module is pure (no I/O): the provider supplies events, budgets, and an
 * optional `callModel` function; benchmarks drive it directly the same way.
 */

import type { AgentStoredEvent } from "../types.js";
import { asRecord, asString } from "./cesium-coerce.js";

// ---------------------------------------------------------------------------
// Settings & budgets
// ---------------------------------------------------------------------------

export type CesiumCompactionSettings = {
  enabled: boolean;
  /**
   * 0..1. 0 = maximum retention (keep context ~70% full after compaction, gentle
   * pruning, long verbatim quotes). 1 = maximum aggression (compact down to ~15%
   * fill, terse quotes, aggressive stubs). Default 0.35.
   */
  intensity: number;
  /** Ratio of the context window at which compaction triggers (default 0.82). */
  thresholdRatio: number;
  /** Optional dedicated summarizer model (falls back to the conversation model). */
  modelId: string | null;
};

export const CESIUM_COMPACTION_DEFAULT_INTENSITY = 0.35;
export const CESIUM_COMPACTION_ENGINE_ID = "ledger-v1";

export type CesiumCompactionBudgets = {
  contextWindowTokens: number;
  /** Compaction fires at or above this many tokens. */
  triggerTokens: number;
  /** Stage 2 aims to land the assembled context at or below this. */
  targetTokens: number;
  /** Pre-compaction warning zone starts here. */
  warnTokens: number;
  /** Most recent tool-output tokens protected from microcompaction stubs. */
  toolResultProtectTokens: number;
  /** Token budget for the retained verbatim tail after a ledger compaction. */
  tailBudgetTokens: number;
  /** Soft cap for the ledger body produced by the compactor model. */
  ledgerBudgetTokens: number;
  /** Per-user-message verbatim quote cap (chars) in the archive. */
  userQuoteCapChars: number;
  /** Rolling token budget for the verbatim user-message archive. */
  userArchiveBudgetTokens: number;
  /** Rolling char budget for pinned notes. */
  pinBudgetChars: number;
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeCompactionIntensity(value: unknown): number {
  const num = typeof value === "number" && Number.isFinite(value) ? value : NaN;
  if (Number.isNaN(num)) {
    return CESIUM_COMPACTION_DEFAULT_INTENSITY;
  }
  return clamp(num, 0, 1);
}

export function resolveCompactionBudgets(input: {
  contextWindowTokens: number;
  intensity: number;
  thresholdRatio: number;
}): CesiumCompactionBudgets {
  const window = Math.max(4_000, Math.floor(input.contextWindowTokens));
  const intensity = clamp(input.intensity, 0, 1);
  const triggerRatio = clamp(input.thresholdRatio, 0.2, 0.98);
  // High retention (intensity 0) leaves the window ~70% full after compaction;
  // aggressive (intensity 1) compacts down to ~15%.
  const targetRatio = Math.min(lerp(0.7, 0.15, intensity), triggerRatio - 0.08);
  const warnRatio = Math.max(0.1, triggerRatio - 0.12);
  const targetTokens = Math.floor(window * targetRatio);
  // The ledger is the durable memory — it earns roughly half of the retention
  // target, and MORE as intensity rises: aggressive compaction sacrifices the
  // verbatim tail before it sacrifices memory.
  const ledgerBudgetTokens = Math.floor(
    clamp(targetTokens * lerp(0.5, 0.7, intensity), 1_200, 24_000)
  );
  const tailBudgetTokens = Math.max(800, targetTokens - ledgerBudgetTokens);
  return {
    contextWindowTokens: window,
    triggerTokens: Math.floor(window * triggerRatio),
    targetTokens,
    warnTokens: Math.floor(window * warnRatio),
    toolResultProtectTokens: Math.floor(
      clamp(window * lerp(0.3, 0.08, intensity), 2_000, 120_000)
    ),
    tailBudgetTokens,
    ledgerBudgetTokens,
    userQuoteCapChars: Math.floor(lerp(2_000, 320, intensity)),
    userArchiveBudgetTokens: Math.floor(
      clamp(window * lerp(0.06, 0.015, intensity), 600, 16_000)
    ),
    pinBudgetChars: Math.floor(lerp(8_000, 2_500, intensity)),
  };
}

// ---------------------------------------------------------------------------
// Ledger model
// ---------------------------------------------------------------------------

export type CesiumLedgerUserQuote = {
  seq: number;
  text: string;
  /** True once the quote has been evicted from verbatim form into a one-line gist. */
  gist?: boolean;
};

export type CesiumLedgerPin = {
  seq: number;
  text: string;
};

export type CesiumLedger = {
  version: 1;
  generation: number;
  /** Highest event seq covered by (merged into) this ledger. */
  coveredToSeq: number;
  /** Structured sections text maintained by the compactor model. */
  body: string;
  pinned: CesiumLedgerPin[];
  userQuotes: CesiumLedgerUserQuote[];
  /** True when the body was produced by the deterministic fallback extractor. */
  heuristic?: boolean;
};

export const CESIUM_LEDGER_SECTIONS = [
  "MISSION",
  "USER DIRECTIVES & PREFERENCES",
  "STATE",
  "KEY FACTS & DECISIONS",
  "ARTIFACTS & FILES",
  "SUBAGENTS & DELEGATED WORK",
  "DEAD ENDS & GOTCHAS",
  "OPEN THREADS & PROMISES",
  "NOW",
] as const;

export function emptyCesiumLedger(): CesiumLedger {
  return {
    version: 1,
    generation: 0,
    coveredToSeq: 0,
    body: "",
    pinned: [],
    userQuotes: [],
  };
}

type CompressionSummaryEvent = Extract<AgentStoredEvent, { kind: "compression_summary" }>;

export function latestCompressionSummaryEvent(
  events: AgentStoredEvent[]
): CompressionSummaryEvent | null {
  let latest: CompressionSummaryEvent | null = null;
  for (const event of events) {
    if (event.kind !== "compression_summary") {
      continue;
    }
    if (!latest || event.seq > latest.seq) {
      latest = event;
    }
  }
  return latest;
}

/**
 * Recover the structured ledger from the latest compression_summary event.
 * Legacy summaries (pre ledger-v1) migrate by becoming the initial body.
 */
export function latestLedgerFromEvents(events: AgentStoredEvent[]): CesiumLedger | null {
  const event = latestCompressionSummaryEvent(events);
  if (!event) {
    return null;
  }
  const raw = asRecord(event.raw);
  const ledgerRaw = asRecord(raw?.ledger);
  if (raw?.engine === CESIUM_COMPACTION_ENGINE_ID && ledgerRaw) {
    const pins = Array.isArray(ledgerRaw.pinned) ? ledgerRaw.pinned : [];
    const quotes = Array.isArray(ledgerRaw.userQuotes) ? ledgerRaw.userQuotes : [];
    return {
      version: 1,
      generation:
        typeof ledgerRaw.generation === "number" ? ledgerRaw.generation : event.generation ?? 1,
      coveredToSeq:
        typeof ledgerRaw.coveredToSeq === "number"
          ? ledgerRaw.coveredToSeq
          : event.sourceRange?.toSeq ?? 0,
      body: typeof ledgerRaw.body === "string" ? ledgerRaw.body : event.summary,
      pinned: pins
        .map((pin) => asRecord(pin))
        .filter((pin): pin is Record<string, unknown> => pin !== null)
        .map((pin) => ({
          seq: typeof pin.seq === "number" ? pin.seq : 0,
          text: typeof pin.text === "string" ? pin.text : "",
        }))
        .filter((pin) => pin.text.length > 0),
      userQuotes: quotes
        .map((quote) => asRecord(quote))
        .filter((quote): quote is Record<string, unknown> => quote !== null)
        .map((quote) => ({
          seq: typeof quote.seq === "number" ? quote.seq : 0,
          text: typeof quote.text === "string" ? quote.text : "",
          ...(quote.gist === true ? { gist: true } : {}),
        }))
        .filter((quote) => quote.text.length > 0),
      heuristic: ledgerRaw.heuristic === true,
    };
  }
  // Legacy heuristic summary: fold into a ledger body so the next generation
  // merges instead of losing it.
  return {
    version: 1,
    generation: event.generation ?? 1,
    coveredToSeq: event.sourceRange?.toSeq ?? 0,
    body: event.summary,
    pinned: [],
    userQuotes: [],
    heuristic: true,
  };
}

// ---------------------------------------------------------------------------
// Token estimation (chars/4, consistent with the rest of the harness)
// ---------------------------------------------------------------------------

export function estimateTokensForText(text: string): number {
  return Math.ceil(text.length / 4);
}

function eventText(event: AgentStoredEvent): string {
  switch (event.kind) {
    case "user_message":
      return event.hidden ? "" : event.content;
    case "assistant_message_chunk":
    case "reasoning":
      return event.text;
    case "system_reminder":
      return event.targetMessageId ? event.text : "";
    case "tool_call":
      return `${event.title} ${event.detail ?? ""}`;
    case "tool_call_update":
      return event.detail ?? "";
    case "plan":
      return event.entries.map((entry) => `${entry.status}: ${entry.content}`).join("\n");
    case "subagent":
      return `${event.title} ${event.recentActivity ?? ""}`;
    case "question":
      return `${event.prompt} ${event.answer ?? ""}`;
    case "compression_summary":
      return event.summary;
    case "chat_fork":
      return event.transcript;
    default:
      return "";
  }
}

export function estimateEventTokens(events: AgentStoredEvent[]): number {
  let chars = 0;
  for (const event of events) {
    chars += eventText(event).length + 24;
  }
  return Math.ceil(chars / 4);
}

// ---------------------------------------------------------------------------
// Stage 1: tool-result microcompaction
// ---------------------------------------------------------------------------

const MICROCOMPACT_MIN_RESULT_CHARS = 1_400;
const MICROCOMPACT_HEAD_CHARS = 600;
const MICROCOMPACT_TAIL_CHARS = 200;

export type MicrocompactionResult = {
  events: AgentStoredEvent[];
  prunedToolResults: number;
  savedChars: number;
};

/**
 * Stub old tool outputs beyond a protected recent budget, keeping a head+tail
 * excerpt and a retrieval breadcrumb. Never mutates the input events (storage
 * keeps the full outputs; this is a view transform applied at history build time).
 */
export function applyToolResultMicrocompaction(
  events: AgentStoredEvent[],
  options: { protectTokens: number }
): MicrocompactionResult {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  // Walk backwards accumulating protected tool-output tokens.
  let protectedTokens = 0;
  let protectBoundarySeq = Number.NEGATIVE_INFINITY;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const event = sorted[index]!;
    if (event.kind !== "tool_call_update" || !event.detail) {
      continue;
    }
    protectedTokens += estimateTokensForText(event.detail);
    if (protectedTokens > options.protectTokens) {
      protectBoundarySeq = event.seq;
      break;
    }
  }
  if (protectBoundarySeq === Number.NEGATIVE_INFINITY) {
    return { events: sorted, prunedToolResults: 0, savedChars: 0 };
  }
  let prunedToolResults = 0;
  let savedChars = 0;
  const out = sorted.map((event) => {
    if (
      event.kind !== "tool_call_update" ||
      event.seq > protectBoundarySeq ||
      !event.detail ||
      event.detail.length <= MICROCOMPACT_MIN_RESULT_CHARS
    ) {
      return event;
    }
    const head = event.detail.slice(0, MICROCOMPACT_HEAD_CHARS);
    const tail = event.detail.slice(-MICROCOMPACT_TAIL_CHARS);
    const pruned = event.detail.length - head.length - tail.length;
    prunedToolResults += 1;
    savedChars += pruned;
    return {
      ...event,
      detail:
        `${head}\n…[${pruned} chars of this tool output were pruned during context compaction. ` +
        `The full output is preserved verbatim in the event log — retrieve it with ` +
        `search_history or read_history_page around seq ${event.seq}.]…\n${tail}`,
    };
  });
  return { events: out, prunedToolResults, savedChars };
}

// ---------------------------------------------------------------------------
// Stage 2: split-point selection
// ---------------------------------------------------------------------------

export type CompactionSplit = {
  spanEvents: AgentStoredEvent[];
  retainedEvents: AgentStoredEvent[];
  /** First retained seq; 0 when nothing was evicted. */
  splitSeq: number;
};

/**
 * Choose the eviction split so the retained tail fits the budget, always cutting
 * at a non-hidden user-turn boundary (never orphaning tool call/result pairs),
 * and never evicting the most recent user turn.
 */
export function chooseCompactionSplit(
  events: AgentStoredEvent[],
  options: { tailBudgetTokens: number }
): CompactionSplit {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const candidateIndexes: number[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const event = sorted[index]!;
    if (event.kind === "user_message" && !event.hidden) {
      candidateIndexes.push(index);
    }
  }
  if (candidateIndexes.length <= 1) {
    return { spanEvents: [], retainedEvents: sorted, splitSeq: 0 };
  }
  // Cumulative token mass from each index to the end.
  const suffixTokens = new Array<number>(sorted.length + 1).fill(0);
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    suffixTokens[index] =
      suffixTokens[index + 1]! + estimateTokensForText(eventText(sorted[index]!)) + 6;
  }
  // Never evict the latest user turn: candidates exclude the final one.
  const usable = candidateIndexes.slice(0, -1);
  // Pick the earliest candidate whose tail fits the budget (largest tail that
  // fits). If none fit, fall back to the latest usable candidate — compacting a
  // giant recent turn is still better than blowing the window.
  let chosen: number | null = null;
  for (const index of usable) {
    if (suffixTokens[index]! <= options.tailBudgetTokens) {
      chosen = index;
      break;
    }
  }
  if (chosen == null) {
    chosen = usable[usable.length - 1]!;
  }
  if (chosen === 0) {
    return { spanEvents: [], retainedEvents: sorted, splitSeq: 0 };
  }
  return {
    spanEvents: sorted.slice(0, chosen),
    retainedEvents: sorted.slice(chosen),
    splitSeq: sorted[chosen]!.seq,
  };
}

// ---------------------------------------------------------------------------
// Span rendering for the compactor model
// ---------------------------------------------------------------------------

const SPAN_USER_MESSAGE_CAP = 8_000;
const SPAN_ASSISTANT_CAP = 2_400;
const SPAN_REASONING_CAP = 280;
const SPAN_TOOL_RESULT_CAP = 500;
const SPAN_TOOL_FAILURE_CAP = 900;
const SPAN_SUBAGENT_CAP = 600;

function capText(text: string, cap: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= cap) {
    return trimmed;
  }
  return `${trimmed.slice(0, cap)} …[+${trimmed.length - cap} chars]`;
}

/**
 * Render an event span into seq-tagged lines for the compactor model. Every line
 * begins with `[sN]` so the model can copy provenance markers into the ledger.
 */
export function renderEventsForCompaction(events: AgentStoredEvent[]): string {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const lines: string[] = [];
  let assistantBuffer: { fromSeq: number; toSeq: number; text: string } | null = null;
  const toolNamesByCallId = new Map<string, string>();
  const flushAssistant = () => {
    if (!assistantBuffer) {
      return;
    }
    const marker =
      assistantBuffer.fromSeq === assistantBuffer.toSeq
        ? `[s${assistantBuffer.fromSeq}]`
        : `[s${assistantBuffer.fromSeq}-s${assistantBuffer.toSeq}]`;
    const text = capText(assistantBuffer.text, SPAN_ASSISTANT_CAP);
    if (text) {
      lines.push(`${marker} ASSISTANT: ${text}`);
    }
    assistantBuffer = null;
  };
  for (const event of sorted) {
    if (event.kind === "assistant_message_chunk") {
      if (assistantBuffer) {
        assistantBuffer.toSeq = event.seq;
        assistantBuffer.text += event.text;
      } else {
        assistantBuffer = { fromSeq: event.seq, toSeq: event.seq, text: event.text };
      }
      continue;
    }
    if (event.kind !== "assistant_message_end") {
      flushAssistant();
    }
    switch (event.kind) {
      case "user_message":
        if (!event.hidden) {
          lines.push(`[s${event.seq}] USER: ${capText(event.content, SPAN_USER_MESSAGE_CAP)}`);
        }
        break;
      case "reasoning": {
        const gist = capText(event.text, SPAN_REASONING_CAP);
        if (gist) {
          lines.push(`[s${event.seq}] ASSISTANT-REASONING (gist): ${gist}`);
        }
        break;
      }
      case "tool_call": {
        const raw = asRecord(event.raw);
        const request = asRecord(raw?.request) ?? raw;
        const name = asString(request?.name);
        if (name) {
          toolNamesByCallId.set(event.toolCallId, name);
        }
        lines.push(
          `[s${event.seq}] TOOL-CALL ${name ?? event.title}: ${capText(
            event.detail ?? event.title,
            360
          )}`
        );
        break;
      }
      case "tool_call_update": {
        if (event.status !== "completed" && event.status !== "failed") {
          break;
        }
        const cap = event.status === "failed" ? SPAN_TOOL_FAILURE_CAP : SPAN_TOOL_RESULT_CAP;
        const name = toolNamesByCallId.get(event.toolCallId) ?? event.title ?? "tool";
        lines.push(
          `[s${event.seq}] TOOL-${event.status === "failed" ? "FAILED" : "RESULT"} ${name}: ${capText(
            event.detail ?? "(no output)",
            cap
          )}`
        );
        break;
      }
      case "plan":
        lines.push(
          `[s${event.seq}] PLAN: ${event.entries
            .map((entry) => `${entry.status}: ${entry.content}`)
            .join(" | ")}`
        );
        break;
      case "subagent":
        lines.push(
          `[s${event.seq}] SUBAGENT ${event.subagentId} "${event.title}" status=${event.status}${
            event.recentActivity
              ? ` outcome: ${capText(event.recentActivity, SPAN_SUBAGENT_CAP)}`
              : ""
          }`
        );
        break;
      case "question": {
        const answer = Array.isArray(event.answer) ? event.answer.join("; ") : event.answer;
        lines.push(
          `[s${event.seq}] QUESTION: ${capText(event.prompt, 500)}${
            answer ? ` ANSWER: ${capText(answer, 500)}` : ""
          }`
        );
        break;
      }
      case "agent_handoff":
        lines.push(`[s${event.seq}] HANDOFF: ${event.fromAgent} -> ${event.toAgent}`);
        break;
      case "chat_fork":
        lines.push(`[s${event.seq}] FORKED-CHAT context: ${capText(event.transcript, 1_200)}`);
        break;
      case "system":
        if (event.level === "error") {
          lines.push(`[s${event.seq}] SYSTEM-ERROR: ${capText(event.text, 700)}`);
        }
        break;
      case "permission_request":
        lines.push(`[s${event.seq}] PERMISSION-REQUEST: ${capText(event.title ?? "", 240)}`);
        break;
      default:
        break;
    }
  }
  flushAssistant();
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Verbatim user-message archive
// ---------------------------------------------------------------------------

const USER_QUOTE_GIST_CHARS = 160;

export function updateUserQuoteArchive(
  previous: CesiumLedgerUserQuote[],
  spanEvents: AgentStoredEvent[],
  budgets: Pick<CesiumCompactionBudgets, "userQuoteCapChars" | "userArchiveBudgetTokens">
): CesiumLedgerUserQuote[] {
  const merged: CesiumLedgerUserQuote[] = [...previous];
  for (const event of spanEvents) {
    if (event.kind !== "user_message" || event.hidden) {
      continue;
    }
    if (merged.some((quote) => quote.seq === event.seq)) {
      continue;
    }
    const text = event.content.trim();
    if (!text) {
      continue;
    }
    merged.push({
      seq: event.seq,
      text:
        text.length > budgets.userQuoteCapChars
          ? `${text.slice(0, budgets.userQuoteCapChars)} …[+${text.length - budgets.userQuoteCapChars} chars, see s${event.seq}]`
          : text,
    });
  }
  merged.sort((a, b) => a.seq - b.seq);
  // Enforce the rolling budget in two stages: gist oldest verbatim quotes,
  // then HARD-EVICT the oldest gists entirely. Without eviction the gist list
  // itself grows linearly with conversation length and eventually dominates
  // the ledger (hundreds of turns = thousands of tokens of gists).
  const budgetChars = budgets.userArchiveBudgetTokens * 4;
  let totalChars = merged.reduce((sum, quote) => sum + quote.text.length, 0);
  for (const quote of merged) {
    if (totalChars <= budgetChars) {
      break;
    }
    if (quote.gist || quote.text.length <= USER_QUOTE_GIST_CHARS) {
      continue;
    }
    totalChars -= quote.text.length;
    quote.text = `${quote.text.slice(0, USER_QUOTE_GIST_CHARS)} …[gisted, full text at s${quote.seq}]`;
    quote.gist = true;
    totalChars += quote.text.length;
  }
  while (merged.length > 1 && totalChars > budgetChars) {
    const evicted = merged.shift()!;
    totalChars -= evicted.text.length;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

export const CESIUM_COMPACTION_PIN_MARKER = "compaction_pin";

export function collectCompactionPins(
  events: AgentStoredEvent[],
  options: { budgetChars: number }
): CesiumLedgerPin[] {
  const pins: CesiumLedgerPin[] = [];
  for (const event of events) {
    if (event.kind !== "system_reminder" || event.reason !== "compaction") {
      continue;
    }
    const raw = asRecord(event.raw);
    if (raw?.marker !== CESIUM_COMPACTION_PIN_MARKER) {
      continue;
    }
    const text = event.text.trim();
    if (text) {
      pins.push({ seq: event.seq, text });
    }
  }
  pins.sort((a, b) => a.seq - b.seq);
  // Keep the newest pins within budget.
  let total = 0;
  const kept: CesiumLedgerPin[] = [];
  for (let index = pins.length - 1; index >= 0; index -= 1) {
    const pin = pins[index]!;
    if (total + pin.text.length > options.budgetChars && kept.length > 0) {
      break;
    }
    total += pin.text.length;
    kept.unshift(pin);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export function buildLedgerSystemPrompt(budgets: {
  ledgerBudgetTokens: number;
}): string {
  const maxWords = Math.max(300, Math.floor(budgets.ledgerBudgetTokens * 0.72));
  return [
    "You are the context-ledger maintainer inside an autonomous coding agent's harness.",
    "Older conversation events are being evicted from the model's context window. Your job is to MERGE the evicted span into the running ledger so the agent can continue seamlessly, as if nothing was lost.",
    "",
    "You receive:",
    "1. CURRENT LEDGER — the structured ledger from prior compactions (may be empty).",
    "2. PINNED NOTES — notes the agent explicitly pinned; they survive verbatim elsewhere, use them to resolve ambiguity.",
    "3. EVICTED SPAN — seq-tagged transcript lines ([sN] markers) being removed from context.",
    "",
    "Output the FULL UPDATED LEDGER BODY and nothing else — no preamble, no code fences, no commentary.",
    "",
    "The ledger body MUST contain exactly these sections, in this order, each as a '## ' header:",
    ...CESIUM_LEDGER_SECTIONS.map((section) => `## ${section}`),
    "",
    "Section contents:",
    "- MISSION: the durable objective(s) and the current focus. 1-4 lines.",
    "- USER DIRECTIVES & PREFERENCES: standing constraints, style preferences, explicit do/don't instructions. Quote short key user phrasings exactly.",
    "- STATE: checklist of work — done / in-progress / backlog. Use '- [x]', '- [~]', '- [ ]'.",
    "- KEY FACTS & DECISIONS: environment facts, config values, decisions made and WHY. Terse 'key: value — reason' lines.",
    "- ARTIFACTS & FILES: files/resources created, modified, or heavily read, with exact paths and a one-line purpose.",
    "- SUBAGENTS & DELEGATED WORK: EVERY spawned subagent/delegated task: id, task, status, outcome. Never drop an entry — mark it finished instead.",
    "- DEAD ENDS & GOTCHAS: approaches tried and failed (with the reason/error), flaky commands, invalid assumptions. This is negative knowledge — losing it causes repeated mistakes.",
    "- OPEN THREADS & PROMISES: unresolved questions, deferred work, anything the agent told the user it would do.",
    "- NOW: 2-4 sentences — exactly where work stands and the immediate next step.",
    "",
    "MERGE RULES (critical):",
    "- Update existing entries in place (e.g. move backlog items to done). Never silently delete an entry; if superseded, either update it or move the lesson to DEAD ENDS & GOTCHAS.",
    "- Preserve EXACT identifiers verbatim: file paths, URLs, shell commands, error strings, subagent ids, branch names, code symbols, numbers, names. Never paraphrase an identifier.",
    "- Carry provenance: suffix lines describing specific happenings with their [sN] or [sN-sM] markers copied from the span. The agent can retrieve raw history for any seq with its search_history / read_history_page tools.",
    "- Telegraphic, dense style. No filler words, no meta-commentary, no repetition of section headers inside sections.",
    `- HARD BUDGET: keep the whole body under roughly ${maxWords} words — the harness truncates oldest entries beyond it. When the budget forces cuts, in order: (1) merge near-duplicate or related entries onto one line, (2) compress phrasing, (3) drop the oldest low-impact routine facts. NEVER drop user directives, dead ends, subagent ids, or values the user explicitly asked to remember; anything dropped stays retrievable via its [sN] marker.`,
    "- Do not mention compaction or summarization anywhere in the body.",
  ].join("\n");
}

export function buildLedgerUpdateUserPrompt(input: {
  previousBody: string;
  pins: CesiumLedgerPin[];
  spanText: string;
  fromSeq: number;
  toSeq: number;
}): string {
  return [
    "=== CURRENT LEDGER ===",
    input.previousBody.trim() || "(empty — this is the first compaction; create the ledger)",
    "",
    "=== PINNED NOTES ===",
    input.pins.length
      ? input.pins.map((pin) => `[s${pin.seq}] ${pin.text}`).join("\n")
      : "(none)",
    "",
    `=== EVICTED SPAN (events s${input.fromSeq}-s${input.toSeq}) ===`,
    input.spanText,
    "",
    "Produce the full updated ledger body now.",
  ].join("\n");
}

export const LEDGER_VERIFICATION_OK = "VERIFIED-OK";

export function buildLedgerCondensePrompt(budgetChars: number): string {
  const maxWords = Math.max(200, Math.floor((budgetChars / 5) * 0.9));
  return [
    "You are condensing an over-budget context ledger for an autonomous coding agent. The input is the full ledger body; output the SAME ledger with the SAME '## ' section structure, shrunk to fit the budget.",
    `HARD BUDGET: at most ~${maxWords} words. Anything beyond it will be truncated mechanically (oldest lines first), so it is on you to compress smartly instead:`,
    "- MERGE related entries onto dense shared lines (e.g. one line listing several service:value pairs; combine [sN] markers into [sN-sM] ranges).",
    "- Preserve EVERY identifier:value pair you can — exact tokens, paths, ids, numbers. Prefer dropping prose over dropping values.",
    "- Never drop user directives, dead ends/failed approaches, or subagent ids.",
    "- Drop only redundant phrasing, chatter, and superseded values.",
    "Output only the condensed ledger body — no preamble, no code fences.",
  ].join("\n");
}

export function buildLedgerVerificationPrompt(input: {
  candidateBody: string;
  spanText: string;
}): { system: string; user: string } {
  return {
    system: [
      "You are auditing a context ledger produced from an evicted transcript span for an autonomous coding agent.",
      "Check the candidate ledger against the span for OMISSIONS in these categories:",
      "1. File paths / URLs / shell commands that were created, modified, or load-bearing.",
      "2. Error strings and failed approaches (negative knowledge).",
      "3. Spawned subagents / delegated tasks and their outcomes.",
      "4. Explicit user directives, constraints, or preference statements.",
      "5. Specific numbers, ids, names, or config values the agent will need again.",
      `If the ledger already covers everything important, reply with exactly ${LEDGER_VERIFICATION_OK} and nothing else.`,
      "Otherwise output the FULL corrected ledger body (same section structure, same style rules, [sN] provenance markers), with the omissions folded in. No commentary.",
    ].join("\n"),
    user: [
      "=== EVICTED SPAN ===",
      input.spanText,
      "",
      "=== CANDIDATE LEDGER ===",
      input.candidateBody,
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Deterministic fallback extractor
// ---------------------------------------------------------------------------

/** Parse a ledger body into its `## SECTION` → lines mapping (order-preserving). */
export function parseLedgerSections(body: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of body.split("\n")) {
    const header = line.match(/^##\s+(.+?)\s*$/);
    if (header) {
      current = header[1]!.toUpperCase();
      if (!sections.has(current)) {
        sections.set(current, []);
      }
      continue;
    }
    if (current && line.trim()) {
      sections.get(current)!.push(line);
    }
  }
  return sections;
}

const HEURISTIC_SECTION_LINE_CAP = 60;

function isPlaceholderLine(line: string): boolean {
  return /^\(.*\)$/.test(line.trim());
}

/** Merge two ledger bodies section-wise: dedupe, keep newest, bounded per section. */
export function mergeLedgerBodies(previousBody: string, freshBody: string): string {
  const previous = parseLedgerSections(previousBody);
  const fresh = parseLedgerSections(freshBody);
  const names = [...CESIUM_LEDGER_SECTIONS.map((section) => section.toUpperCase())];
  for (const name of [...previous.keys(), ...fresh.keys()]) {
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  const parts: string[] = [];
  for (const name of names) {
    const combined = [
      ...(previous.get(name) ?? []),
      ...(fresh.get(name) ?? []),
    ].filter((line) => !isPlaceholderLine(line));
    const deduped = [...new Set(combined)].slice(-HEURISTIC_SECTION_LINE_CAP);
    parts.push(`## ${name}`);
    parts.push(...(deduped.length ? deduped : ["(none recorded)"]));
  }
  return parts.join("\n");
}

/**
 * Deterministic ledger body builder used when no compactor model is available or
 * the LLM call fails. Extraction (not summarization): identifiers are copied
 * verbatim, so it degrades to "dense but unpolished" instead of "lossy". User
 * messages are NOT duplicated here — the verbatim user-message archive already
 * guarantees them.
 */
export function buildHeuristicLedgerBody(input: {
  previousBody: string;
  spanEvents: AgentStoredEvent[];
}): string {
  const sorted = [...input.spanEvents].sort((a, b) => a.seq - b.seq);
  const stateLines: string[] = [];
  const factLines: string[] = [];
  const artifactLines: string[] = [];
  const subagentLines: string[] = [];
  const deadEndLines: string[] = [];
  const toolNamesByCallId = new Map<string, string>();
  let lastAssistant = "";
  for (const event of sorted) {
    switch (event.kind) {
      case "plan":
        stateLines.push(
          ...event.entries.map(
            (entry) =>
              `- [${entry.status === "completed" ? "x" : entry.status === "in_progress" ? "~" : " "}] ${entry.content} [s${event.seq}]`
          )
        );
        break;
      case "tool_call": {
        const raw = asRecord(event.raw);
        const request = asRecord(raw?.request) ?? raw;
        const name = asString(request?.name);
        if (name) {
          toolNamesByCallId.set(event.toolCallId, name);
        }
        if (name === "write_file" || name === "edit_file") {
          const args = asRecord(request?.arguments);
          const path = asString(args?.path) ?? asString(args?.file_path);
          if (path) {
            artifactLines.push(`- ${path} — ${name} [s${event.seq}]`);
          }
        }
        break;
      }
      case "tool_call_update":
        if (event.status === "failed") {
          const name = toolNamesByCallId.get(event.toolCallId) ?? event.title ?? "tool";
          deadEndLines.push(
            `- ${name} failed: ${capText(event.detail ?? "(no detail)", 300)} [s${event.seq}]`
          );
        }
        break;
      case "subagent":
        subagentLines.push(
          `- ${event.subagentId} "${event.title}" status=${event.status}${
            event.recentActivity ? ` — ${capText(event.recentActivity, 240)}` : ""
          } [s${event.seq}]`
        );
        break;
      case "assistant_message_chunk":
        lastAssistant += event.text;
        break;
      case "assistant_message_end":
        if (lastAssistant.trim()) {
          factLines.push(`- assistant: ${capText(lastAssistant, 300)} [s${event.seq}]`);
          if (factLines.length > 24) {
            factLines.shift();
          }
        }
        lastAssistant = "";
        break;
      case "system":
        if (event.level === "error") {
          deadEndLines.push(`- error: ${capText(event.text, 300)} [s${event.seq}]`);
        }
        break;
      default:
        break;
    }
  }
  const dedupe = (lines: string[]): string[] => [...new Set(lines)];
  const fresh = [
    "## MISSION",
    "See the verbatim user messages below for directives and intent.",
    "## USER DIRECTIVES & PREFERENCES",
    "(preserved verbatim in the USER MESSAGES section of this ledger)",
    "## STATE",
    ...(dedupe(stateLines).slice(-40).length ? dedupe(stateLines).slice(-40) : ["(no plan recorded)"]),
    "## KEY FACTS & DECISIONS",
    ...(dedupe(factLines).length ? dedupe(factLines) : ["(none extracted)"]),
    "## ARTIFACTS & FILES",
    ...(dedupe(artifactLines).slice(-60).length ? dedupe(artifactLines).slice(-60) : ["(none recorded)"]),
    "## SUBAGENTS & DELEGATED WORK",
    ...(dedupe(subagentLines).length ? dedupe(subagentLines) : ["(none spawned in this span)"]),
    "## DEAD ENDS & GOTCHAS",
    ...(dedupe(deadEndLines).slice(-40).length ? dedupe(deadEndLines).slice(-40) : ["(none recorded)"]),
    "## OPEN THREADS & PROMISES",
    "(not extracted — check recent user messages)",
    "## NOW",
    "Earlier context was condensed mechanically. Consult STATE and the verbatim user messages; retrieve raw history by seq with search_history / read_history_page when detail is needed.",
  ].join("\n");
  if (!input.previousBody.trim()) {
    return fresh;
  }
  return mergeLedgerBodies(input.previousBody, fresh);
}

// ---------------------------------------------------------------------------
// Ledger budget enforcement
// ---------------------------------------------------------------------------

/**
 * Hard code-side enforcement of the ledger body budget. Prompt-side word
 * limits are advisory only — a faithful compactor model hoards entries and the
 * body balloons across generations, eventually violating the context window
 * itself. When over budget, the largest sections lose their OLDEST lines first
 * (recency bias; evicted detail remains retrievable via seq provenance).
 */
export function enforceLedgerBodyBudget(body: string, budgetChars: number): string {
  if (body.length <= budgetChars) {
    return body;
  }
  const sections = parseLedgerSections(body);
  // NOW/MISSION stay intact; big list sections shrink first.
  const protectedNames = new Set(["MISSION", "NOW"]);
  const totalChars = (): number =>
    [...sections.values()].reduce(
      (sum, lines) => sum + lines.reduce((s, line) => s + line.length + 1, 0),
      0
    ) + sections.size * 24;
  let guard = 0;
  while (totalChars() > budgetChars && guard < 10_000) {
    guard += 1;
    let largest: string | null = null;
    let largestChars = 0;
    for (const [name, lines] of sections) {
      if (protectedNames.has(name) || lines.length <= 2) {
        continue;
      }
      const chars = lines.reduce((sum, line) => sum + line.length, 0);
      if (chars > largestChars) {
        largest = name;
        largestChars = chars;
      }
    }
    if (!largest) {
      break;
    }
    const lines = sections.get(largest)!;
    // Drop the oldest content line (skipping the trim marker if present).
    const dropIndex = lines[0]?.includes("[trimmed") ? 1 : 0;
    lines.splice(dropIndex, 1);
    if (!lines.some((line) => line.includes("[trimmed"))) {
      lines.unshift(
        "- [trimmed to budget — older entries evicted; recover raw detail via search_history]"
      );
    }
  }
  const parts: string[] = [];
  for (const [name, lines] of sections) {
    parts.push(`## ${name}`);
    parts.push(...(lines.length ? lines : ["(none recorded)"]));
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Ledger rendering into the live context
// ---------------------------------------------------------------------------

export function renderLedgerForContext(ledger: CesiumLedger): string {
  const parts: string[] = [
    "<context_ledger>",
    "Earlier conversation events were evicted from your context window and merged into this ledger. Treat it as accurate memory of everything before the messages that follow.",
    "Raw verbatim history was preserved: [sN] markers are event sequence numbers — use search_history (regex over raw events) or read_history_page (beforeSeq) to recover any evicted detail exactly.",
    "Do not mention this ledger or compaction to the user.",
  ];
  if (ledger.pinned.length > 0) {
    parts.push(
      "",
      "## PINNED (verbatim notes you chose to preserve)",
      ...ledger.pinned.map((pin) => `- [s${pin.seq}] ${pin.text}`)
    );
  }
  parts.push("", ledger.body.trim());
  if (ledger.userQuotes.length > 0) {
    parts.push(
      "",
      "## USER MESSAGES (VERBATIM, oldest first — guaranteed-accurate quotes)",
      ...ledger.userQuotes.map((quote) => `- [s${quote.seq}] "${quote.text}"`)
    );
  }
  parts.push("</context_ledger>");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export type CesiumCompactionModelCaller = (input: {
  system: string;
  user: string;
}) => Promise<string>;

export type CesiumCompactionStats = {
  usedTokensBefore: number;
  usedTokensAfter: number;
  prunedToolResults: number;
  microSavedChars: number;
  spanEventCount: number;
  spanFromSeq: number;
  spanToSeq: number;
  usedLlm: boolean;
  verificationRevised: boolean;
  llmError?: string;
};

export type CesiumCompactionOutcome =
  | { kind: "noop"; usedTokens: number }
  | {
      kind: "microcompact";
      events: AgentStoredEvent[];
      stats: Pick<
        CesiumCompactionStats,
        "usedTokensBefore" | "usedTokensAfter" | "prunedToolResults" | "microSavedChars"
      >;
    }
  | {
      kind: "compacted";
      ledger: CesiumLedger;
      retainedEvents: AgentStoredEvent[];
      stats: CesiumCompactionStats;
    };

const MIN_SPAN_TOKENS = 1_500;
const MAX_SPAN_CHARS_PER_CALL = 160_000;
const VERIFICATION_MIN_SPAN_TOKENS = 4_000;

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  return fence ? fence[1]!.trim() : trimmed;
}

export function looksLikeLedgerBody(text: string): boolean {
  const upper = text.toUpperCase();
  let found = 0;
  for (const section of CESIUM_LEDGER_SECTIONS) {
    if (upper.includes(`## ${section}`)) {
      found += 1;
    }
  }
  return found >= 5;
}

async function generateLedgerBody(input: {
  previousBody: string;
  pins: CesiumLedgerPin[];
  spanEvents: AgentStoredEvent[];
  budgets: CesiumCompactionBudgets;
  callModel: CesiumCompactionModelCaller | null;
  /** When set, an over-budget body triggers a model-side condense pass. */
  bodyBudgetChars?: number;
}): Promise<{ body: string; usedLlm: boolean; verificationRevised: boolean; llmError?: string }> {
  const fromSeq = input.spanEvents[0]?.seq ?? 0;
  const toSeq = input.spanEvents[input.spanEvents.length - 1]?.seq ?? 0;
  const fallback = () =>
    buildHeuristicLedgerBody({ previousBody: input.previousBody, spanEvents: input.spanEvents });
  if (!input.callModel) {
    return { body: fallback(), usedLlm: false, verificationRevised: false };
  }
  try {
    const fullSpanText = renderEventsForCompaction(input.spanEvents);
    const system = buildLedgerSystemPrompt(input.budgets);
    // Chunk giant spans: anchored merging composes naturally across sequential calls.
    const chunks: string[] = [];
    if (fullSpanText.length <= MAX_SPAN_CHARS_PER_CALL) {
      chunks.push(fullSpanText);
    } else {
      const lines = fullSpanText.split("\n");
      let current: string[] = [];
      let currentLen = 0;
      for (const line of lines) {
        if (currentLen + line.length > MAX_SPAN_CHARS_PER_CALL && current.length > 0) {
          chunks.push(current.join("\n"));
          current = [];
          currentLen = 0;
        }
        current.push(line);
        currentLen += line.length + 1;
      }
      if (current.length > 0) {
        chunks.push(current.join("\n"));
      }
    }
    let body = input.previousBody;
    for (const chunk of chunks) {
      const raw = await input.callModel({
        system,
        user: buildLedgerUpdateUserPrompt({
          previousBody: body,
          pins: input.pins,
          spanText: chunk,
          fromSeq,
          toSeq,
        }),
      });
      const candidate = stripCodeFence(raw);
      if (!looksLikeLedgerBody(candidate)) {
        throw new Error("Compactor model returned an unstructured ledger body.");
      }
      body = candidate;
    }
    // Verification pass on the final body against the last (most recent) chunk.
    let verificationRevised = false;
    const spanTokens = estimateTokensForText(fullSpanText);
    if (spanTokens >= VERIFICATION_MIN_SPAN_TOKENS) {
      try {
        const verification = buildLedgerVerificationPrompt({
          candidateBody: body,
          spanText: chunks[chunks.length - 1]!,
        });
        const verdict = stripCodeFence(
          await input.callModel({ system: verification.system, user: verification.user })
        );
        if (verdict !== LEDGER_VERIFICATION_OK && looksLikeLedgerBody(verdict)) {
          body = verdict;
          verificationRevised = true;
        }
      } catch {
        // Verification is best-effort; the unverified body is still valid.
      }
    }
    // Condense pass: when the body outgrows its budget, the MODEL re-compresses
    // it (merging related entries onto dense shared lines) far better than the
    // mechanical trimmer, which can only evict oldest lines wholesale.
    if (input.bodyBudgetChars != null && body.length > input.bodyBudgetChars) {
      try {
        const condensed = stripCodeFence(
          await input.callModel({
            system: buildLedgerCondensePrompt(input.bodyBudgetChars),
            user: body,
          })
        );
        if (looksLikeLedgerBody(condensed) && condensed.length < body.length) {
          body = condensed;
        }
      } catch {
        // Best effort — the deterministic trimmer remains the hard guarantee.
      }
    }
    return { body, usedLlm: true, verificationRevised };
  } catch (error) {
    return {
      body: fallback(),
      usedLlm: false,
      verificationRevised: false,
      llmError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Run the full compaction pipeline over a conversation's stored events.
 *
 * `usedTokens` should be the caller's best estimate of the CURRENT assembled
 * context (system prompt + tools + history); the pipeline treats it as the
 * trigger-side truth and uses internal estimates only for split budgeting.
 */
export async function runCesiumCompactionPipeline(input: {
  events: AgentStoredEvent[];
  usedTokens: number;
  budgets: CesiumCompactionBudgets;
  callModel: CesiumCompactionModelCaller | null;
  /** Force stage 2 even when under the trigger (manual / model-requested). */
  force?: boolean;
}): Promise<CesiumCompactionOutcome> {
  const { events, usedTokens, budgets } = input;
  if (!input.force && usedTokens < budgets.triggerTokens) {
    return { kind: "noop", usedTokens };
  }
  const sortedAll = [...events].sort((a, b) => a.seq - b.seq);
  const previousLedger = latestLedgerFromEvents(sortedAll) ?? emptyCesiumLedger();
  // Only events newer than what the ledger already covers are live context.
  const liveEvents = sortedAll.filter(
    (event) => event.seq > previousLedger.coveredToSeq && event.kind !== "compression_summary"
  );

  // Stage 1: microcompaction of old tool outputs.
  const micro = applyToolResultMicrocompaction(liveEvents, {
    protectTokens: budgets.toolResultProtectTokens,
  });
  // The microcompact view must preserve the FULL event stream (including
  // compression_summary events and ledger-covered history) with only the live
  // tool outputs swapped for stubs — normalizeEventsToHistory handles the
  // layering. Returning live events alone here would silently drop the ledger.
  const microBySeq = new Map(micro.events.map((event) => [event.seq, event]));
  const microFullView = sortedAll.map((event) => microBySeq.get(event.seq) ?? event);
  const microSavedTokens = Math.floor(micro.savedChars / 4);
  const usedAfterMicro = Math.max(0, usedTokens - microSavedTokens);
  if (!input.force && usedAfterMicro <= budgets.targetTokens) {
    return {
      kind: "microcompact",
      events: microFullView,
      stats: {
        usedTokensBefore: usedTokens,
        usedTokensAfter: usedAfterMicro,
        prunedToolResults: micro.prunedToolResults,
        microSavedChars: micro.savedChars,
      },
    };
  }

  // Stage 2: ledger compaction over the oldest span.
  const split = chooseCompactionSplit(micro.events, {
    tailBudgetTokens: budgets.tailBudgetTokens,
  });
  const spanTokens = estimateEventTokens(split.spanEvents);
  if (split.spanEvents.length === 0 || (!input.force && spanTokens < MIN_SPAN_TOKENS)) {
    // Nothing meaningful to evict — return the microcompacted full view.
    return {
      kind: "microcompact",
      events: microFullView,
      stats: {
        usedTokensBefore: usedTokens,
        usedTokensAfter: usedAfterMicro,
        prunedToolResults: micro.prunedToolResults,
        microSavedChars: micro.savedChars,
      },
    };
  }
  // The span passed to the compactor model must contain the ORIGINAL tool outputs
  // (not microcompaction stubs) so nothing is lost twice. Map back by seq.
  const originalBySeq = new Map(liveEvents.map((event) => [event.seq, event]));
  const spanOriginal = split.spanEvents.map(
    (event) => originalBySeq.get(event.seq) ?? event
  );
  const pins = collectCompactionPins(events, { budgetChars: budgets.pinBudgetChars });
  const userQuotes = updateUserQuoteArchive(previousLedger.userQuotes, spanOriginal, budgets);
  // Prompt-side size guidance is advisory; enforce the ledger budget in code so
  // the rendered ledger (framing + pins + quotes + body) actually fits it.
  const pinChars = pins.reduce((sum, pin) => sum + pin.text.length + 16, 0);
  const quoteChars = userQuotes.reduce((sum, quote) => sum + quote.text.length + 16, 0);
  const bodyBudgetChars = Math.max(
    2_000,
    budgets.ledgerBudgetTokens * 4 - pinChars - quoteChars - 1_200
  );
  const generated = await generateLedgerBody({
    previousBody: previousLedger.body,
    pins,
    spanEvents: spanOriginal,
    budgets,
    callModel: input.callModel,
    bodyBudgetChars,
  });
  const spanFromSeq = spanOriginal[0]?.seq ?? 0;
  const spanToSeq = spanOriginal[spanOriginal.length - 1]?.seq ?? 0;
  const ledger: CesiumLedger = {
    version: 1,
    generation: previousLedger.generation + 1,
    coveredToSeq: spanToSeq,
    body: enforceLedgerBodyBudget(generated.body, bodyBudgetChars),
    pinned: pins,
    userQuotes,
    ...(generated.usedLlm ? {} : { heuristic: true }),
  };
  const retainedTokens = estimateEventTokens(split.retainedEvents);
  const ledgerTokens = estimateTokensForText(renderLedgerForContext(ledger));
  return {
    kind: "compacted",
    ledger,
    retainedEvents: split.retainedEvents,
    stats: {
      usedTokensBefore: usedTokens,
      usedTokensAfter: retainedTokens + ledgerTokens,
      prunedToolResults: micro.prunedToolResults,
      microSavedChars: micro.savedChars,
      spanEventCount: spanOriginal.length,
      spanFromSeq,
      spanToSeq,
      usedLlm: generated.usedLlm,
      verificationRevised: generated.verificationRevised,
      ...(generated.llmError ? { llmError: generated.llmError } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Pre-compaction warning helper
// ---------------------------------------------------------------------------

export function compactionWarningText(input: {
  percentFull: number;
  triggerPercent: number;
}): string {
  return [
    `<context_status>Context window is ~${input.percentFull}% full. Automatic compaction runs at ~${input.triggerPercent}%.`,
    "Before that happens, use the pin_context tool to preserve (verbatim) any nuanced state a summary might lose: exact user phrasing you are honoring, ids of subagents you spawned, approaches already tried and failed, magic values, and in-flight hypotheses.",
    "You can also call compact_context yourself at a natural checkpoint (e.g. after finishing a subtask) to compact on your own terms.</context_status>",
  ].join(" ");
}

/**
 * Warnings fire when crossing 5-percent buckets inside the warning zone, so the
 * model is nudged at e.g. 70%, 75%, 80% but not spammed on every turn.
 */
export function compactionWarningBucket(input: {
  usedTokens: number;
  budgets: Pick<CesiumCompactionBudgets, "warnTokens" | "triggerTokens" | "contextWindowTokens">;
}): number | null {
  if (input.usedTokens < input.budgets.warnTokens) {
    return null;
  }
  if (input.usedTokens >= input.budgets.triggerTokens) {
    return null;
  }
  const percent = (input.usedTokens / input.budgets.contextWindowTokens) * 100;
  return Math.floor(percent / 5) * 5;
}
