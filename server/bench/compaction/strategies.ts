/**
 * Compaction strategies under benchmark.
 *
 * Each strategy replays a conversation incrementally (turn batches) inside an
 * artificially constrained context window and compacts per its own policy —
 * exactly like a live harness would (multiple compaction generations occur).
 *
 * Reference strategies are faithful re-implementations of the mechanisms found
 * in the respective open-source harnesses / documentation:
 *  - codex-style:   summarize + keep recent REAL USER MESSAGES only (openai/codex
 *                   codex-rs/core/src/compact.rs + prompts/templates/compact/).
 *  - claude-style:  throw everything into one 8-section structured summary and
 *                   keep only the last turns (Claude Code /compact).
 *  - gemini-style:  <state_snapshot> XML + keep the latest ~30% split at a user
 *                   boundary + "Got it." bridge (gemini-cli chatCompressionService).
 *  - opencode-style: anchored summary prompt (Objective / Important Details /
 *                   Work State / Next Move / Relevant Files) + 2-turn tail
 *                   (sst/opencode session/compaction.ts).
 *  - cesium-legacy: the previous Cesium heuristic (string-concat extraction).
 *  - truncate:      drop-oldest baseline.
 *  - oracle:        no compaction (upper bound; probes see everything).
 *  - cesium-ledger@<intensity>: the new layered ledger engine.
 */

import type { AgentStoredEvent } from "../../src/lib/agents/types.js";
import type { CesiumHistoryMessage } from "../../src/lib/agents/cesium/cesium-types.js";
import {
  estimateHistoryTokens,
  normalizeEventsToHistory,
  summarizeForCompression,
} from "../../src/lib/agents/cesium/cesium-history.js";
import {
  CESIUM_COMPACTION_ENGINE_ID,
  renderLedgerForContext,
  resolveCompactionBudgets,
  runCesiumCompactionPipeline,
} from "../../src/lib/agents/cesium/cesium-compaction.js";
import type { BenchCaller } from "./model-client.js";

export const BENCH_SYSTEM_PROMPT =
  "You are a capable assistant in a long-running working session. Continue helping based on the conversation so far.";

export type StrategyStats = {
  compactions: number;
  compactorCalls: number;
  finalTokens: number;
  peakTokens: number;
};

export type StrategyRun = {
  feed(batch: AgentStoredEvent[]): Promise<void>;
  finalize(): Promise<{ messages: CesiumHistoryMessage[]; stats: StrategyStats }>;
};

export type Strategy = {
  id: string;
  label: string;
  usesModel: boolean;
  createRun(context: { windowTokens: number; callModel: BenchCaller }): StrategyRun;
};

const TRIGGER_RATIO = 0.82;

// ---------------------------------------------------------------------------
// Shared rendering helpers
// ---------------------------------------------------------------------------

/** Neutral event → message projection (no Cesium system prompt, no ledger layering). */
export function eventsToNeutralMessages(events: AgentStoredEvent[]): CesiumHistoryMessage[] {
  const normalized = normalizeEventsToHistory(events);
  return normalized.slice(1); // drop the Cesium system prompt
}

function withBenchSystem(messages: CesiumHistoryMessage[]): CesiumHistoryMessage[] {
  return [{ role: "system", content: BENCH_SYSTEM_PROMPT }, ...messages];
}

function tokensOf(messages: CesiumHistoryMessage[]): number {
  return estimateHistoryTokens(messages);
}

/** Plain transcript rendering for reference summarizer prompts. */
export function renderPlainTranscript(events: AgentStoredEvent[]): string {
  const lines: string[] = [];
  let assistantBuffer = "";
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    switch (event.kind) {
      case "user_message":
        if (!event.hidden) {
          if (assistantBuffer.trim()) {
            lines.push(`Assistant: ${assistantBuffer.trim()}`);
            assistantBuffer = "";
          }
          lines.push(`User: ${event.content}`);
        }
        break;
      case "assistant_message_chunk":
        assistantBuffer += event.text;
        break;
      case "assistant_message_end":
        if (assistantBuffer.trim()) {
          lines.push(`Assistant: ${assistantBuffer.trim()}`);
          assistantBuffer = "";
        }
        break;
      case "tool_call":
        lines.push(`Tool call: ${event.title}`);
        break;
      case "tool_call_update":
        if (event.status === "completed" || event.status === "failed") {
          // Real harnesses trim bulky tool outputs before compaction (Codex
          // trims oversized function outputs; Gemini enforces a reverse token
          // budget), so a per-result cap here is faithful to their designs.
          const detail = (event.detail ?? "").slice(0, event.status === "failed" ? 1_200 : 700);
          lines.push(`Tool ${event.status}: ${event.title} -> ${detail}`);
        }
        break;
      case "subagent":
        lines.push(
          `Subagent ${event.subagentId} "${event.title}" (${event.status}): ${event.recentActivity ?? ""}`
        );
        break;
      default:
        break;
    }
  }
  if (assistantBuffer.trim()) {
    lines.push(`Assistant: ${assistantBuffer.trim()}`);
  }
  return lines.join("\n");
}

function splitAtUserBoundary(
  events: AgentStoredEvent[],
  keepRatio: number
): { evicted: AgentStoredEvent[]; kept: AgentStoredEvent[] } {
  const totalChars = events.reduce((sum, event) => sum + JSON.stringify(event).length, 0);
  const keepChars = totalChars * keepRatio;
  let acc = 0;
  let boundary = events.length;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    acc += JSON.stringify(events[index]!).length;
    if (acc >= keepChars) {
      boundary = index;
      break;
    }
    if (index === 0) {
      boundary = 0;
    }
  }
  // Move forward to the next user message so we never orphan a tool pair.
  while (
    boundary < events.length &&
    !(events[boundary]!.kind === "user_message" && !(events[boundary] as { hidden?: boolean }).hidden)
  ) {
    boundary += 1;
  }
  if (boundary >= events.length) {
    return { evicted: [], kept: events };
  }
  // Always keep the latest user turn.
  const lastUserIndex = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.kind === "user_message")
    .map(({ index }) => index)
    .pop();
  if (lastUserIndex != null && boundary > lastUserIndex) {
    boundary = lastUserIndex;
  }
  return { evicted: events.slice(0, boundary), kept: events.slice(boundary) };
}

// ---------------------------------------------------------------------------
// Generic summary-based strategy machinery
// ---------------------------------------------------------------------------

type SummaryStrategyConfig = {
  id: string;
  label: string;
  usesModel: boolean;
  keepRatio: number;
  /** Produce the new summary text. Receives previous summary (may be "") and evicted events. */
  summarize(input: {
    previousSummary: string;
    evicted: AgentStoredEvent[];
    callModel: BenchCaller;
  }): Promise<string>;
  /** How the summary is presented to the model. */
  frameSummary(summary: string): CesiumHistoryMessage[];
  /** Codex-style: keep only user messages in the tail. */
  keepOnlyUserMessages?: boolean;
};

function makeSummaryStrategy(config: SummaryStrategyConfig): Strategy {
  return {
    id: config.id,
    label: config.label,
    usesModel: config.usesModel,
    createRun({ windowTokens, callModel }) {
      let tail: AgentStoredEvent[] = [];
      let summary = "";
      const stats: StrategyStats = {
        compactions: 0,
        compactorCalls: 0,
        finalTokens: 0,
        peakTokens: 0,
      };
      const assemble = (): CesiumHistoryMessage[] => {
        const parts: CesiumHistoryMessage[] = [];
        if (summary) {
          parts.push(...config.frameSummary(summary));
        }
        parts.push(...eventsToNeutralMessages(tail));
        return withBenchSystem(parts);
      };
      const compact = async (): Promise<void> => {
        const { evicted, kept } = splitAtUserBoundary(tail, config.keepRatio);
        if (evicted.length === 0) {
          return;
        }
        try {
          summary = await config.summarize({ previousSummary: summary, evicted, callModel });
        } catch (error) {
          // Real harnesses degrade to truncation when the summarizer fails
          // (e.g. Cline's rule-based fallback). Mirror that instead of aborting.
          summary = [
            summary,
            "[Some earlier conversation was truncated because summarization failed and is no longer available.]",
          ]
            .filter(Boolean)
            .join("\n");
          console.warn(
            `[bench] ${config.id} summarizer failed, degraded to truncation: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        stats.compactions += 1;
        if (config.usesModel) {
          stats.compactorCalls += 1;
        }
        tail = config.keepOnlyUserMessages
          ? kept.filter((event) => event.kind === "user_message")
          : kept;
      };
      return {
        async feed(batch) {
          tail = [...tail, ...batch];
          let tokens = tokensOf(assemble());
          stats.peakTokens = Math.max(stats.peakTokens, tokens);
          let guard = 0;
          while (tokens >= windowTokens * TRIGGER_RATIO && guard < 4) {
            guard += 1;
            const before = tokens;
            await compact();
            tokens = tokensOf(assemble());
            if (tokens >= before) {
              break;
            }
          }
        },
        async finalize() {
          const messages = assemble();
          stats.finalTokens = tokensOf(messages);
          return { messages, stats };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------

export const oracleStrategy: Strategy = {
  id: "oracle",
  label: "Oracle (no compaction, unlimited window)",
  usesModel: false,
  createRun() {
    let all: AgentStoredEvent[] = [];
    const stats: StrategyStats = { compactions: 0, compactorCalls: 0, finalTokens: 0, peakTokens: 0 };
    return {
      async feed(batch) {
        all = [...all, ...batch];
      },
      async finalize() {
        const messages = withBenchSystem(eventsToNeutralMessages(all));
        stats.finalTokens = tokensOf(messages);
        stats.peakTokens = stats.finalTokens;
        return { messages, stats };
      },
    };
  },
};

export const truncateStrategy: Strategy = makeSummaryStrategy({
  id: "truncate",
  label: "Truncate (drop oldest)",
  usesModel: false,
  keepRatio: 0.45,
  async summarize() {
    return "[Earlier conversation was truncated and is no longer available.]";
  },
  frameSummary(summary) {
    return [{ role: "user", content: summary }];
  },
});

export const cesiumLegacyStrategy: Strategy = makeSummaryStrategy({
  id: "cesium-legacy",
  label: "Cesium legacy heuristic",
  usesModel: false,
  keepRatio: 0.45,
  async summarize({ evicted }) {
    // Faithful to the old engine: prior summary is NOT carried forward (the old
    // summarizeForCompression dropped compression_summary events entirely).
    return summarizeForCompression(evicted);
  },
  frameSummary(summary) {
    return [{ role: "user", content: `[Compressed earlier conversation]\n${summary}` }];
  },
});

// ---------------------------------------------------------------------------
// Codex-style
// ---------------------------------------------------------------------------

const CODEX_COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- The user's original request and any follow-up instructions
- Work completed so far and current state
- Files, commands, and tools that were used, with key results
- Any errors encountered and how they were handled
- What remains to be done and the immediate next step

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

const CODEX_SUMMARY_PREFIX =
  "Another language model started to solve this task and produced a summary of its work. This summary was generated when the previous context reached its limit:";

export const codexStyleStrategy: Strategy = makeSummaryStrategy({
  id: "codex-style",
  label: "Codex-style (summary + recent user messages)",
  usesModel: true,
  keepRatio: 0.3,
  keepOnlyUserMessages: true,
  async summarize({ previousSummary, evicted, callModel }) {
    const transcript = [
      previousSummary ? `${CODEX_SUMMARY_PREFIX}\n${previousSummary}\n` : "",
      renderPlainTranscript(evicted),
    ]
      .filter(Boolean)
      .join("\n");
    return callModel({ system: CODEX_COMPACT_PROMPT, user: transcript.slice(0, 400_000) });
  },
  frameSummary(summary) {
    return [{ role: "user", content: `${CODEX_SUMMARY_PREFIX}\n\n${summary}` }];
  },
});

// ---------------------------------------------------------------------------
// Claude-style
// ---------------------------------------------------------------------------

const CLAUDE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions. The summary will REPLACE the conversation history, so it must capture everything needed to continue the work without access to the original messages.

Structure your summary with exactly these sections:
1. Primary Request and Intent: all of the user's explicit requests and intents in detail
2. Key Technical Concepts: important technical concepts, technologies, and frameworks discussed
3. Files and Code Sections: files and code sections examined, modified, or created, with why they matter
4. Errors and Fixes: all errors encountered and how they were fixed, including user feedback
5. Problem Solving: problems solved and any ongoing troubleshooting
6. All User Messages: a list of ALL user messages that are not tool results, to capture user intent exactly
7. Pending Tasks: outstanding tasks you have been asked to work on
8. Current Work: precisely what was being worked on immediately before this summary
9. Optional Next Step: the next step aligned with the user's most recent request, if any

Output only the summary.`;

export const claudeStyleStrategy: Strategy = makeSummaryStrategy({
  id: "claude-style",
  label: "Claude Code-style (8-section full replacement)",
  usesModel: true,
  keepRatio: 0.1,
  async summarize({ previousSummary, evicted, callModel }) {
    const transcript = [
      previousSummary ? `Previous summary (from an earlier compaction):\n${previousSummary}\n` : "",
      renderPlainTranscript(evicted),
    ]
      .filter(Boolean)
      .join("\n");
    return callModel({ system: CLAUDE_COMPACT_PROMPT, user: transcript.slice(0, 400_000) });
  },
  frameSummary(summary) {
    return [
      {
        role: "user",
        content: `This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:\n${summary}`,
      },
    ];
  },
});

// ---------------------------------------------------------------------------
// Gemini-style
// ---------------------------------------------------------------------------

const GEMINI_COMPACT_PROMPT = `You are the component that summarizes internal chat history into a given structure. Think through the entire history. Then produce an XML <state_snapshot> capturing the session state, using exactly this structure:

<state_snapshot>
  <overall_goal><!-- the user's high-level objective --></overall_goal>
  <active_constraints><!-- user-stated rules and preferences that must keep holding --></active_constraints>
  <key_knowledge><!-- crucial facts, config values, and learnings --></key_knowledge>
  <artifact_trail><!-- files and resources created/modified, with paths --></artifact_trail>
  <file_system_state><!-- current known state of relevant files --></file_system_state>
  <recent_actions><!-- the last significant actions and their outcomes --></recent_actions>
  <task_state><!-- done / in-progress / pending work items --></task_state>
</state_snapshot>

Be dense and specific. Output only the snapshot.`;

export const geminiStyleStrategy: Strategy = makeSummaryStrategy({
  id: "gemini-style",
  label: "Gemini CLI-style (state_snapshot + 30% tail)",
  usesModel: true,
  keepRatio: 0.3,
  async summarize({ previousSummary, evicted, callModel }) {
    const transcript = [
      previousSummary ? `Previous snapshot:\n${previousSummary}\n` : "",
      renderPlainTranscript(evicted),
    ]
      .filter(Boolean)
      .join("\n");
    return callModel({ system: GEMINI_COMPACT_PROMPT, user: transcript.slice(0, 400_000) });
  },
  frameSummary(summary) {
    return [
      { role: "user", content: summary },
      { role: "assistant", content: "Got it. Thanks for the additional context!" },
    ];
  },
});

// ---------------------------------------------------------------------------
// OpenCode-style
// ---------------------------------------------------------------------------

const OPENCODE_COMPACT_PROMPT = `You are an anchored context summarization assistant. The conversation is being compacted; produce an updated summary that lets the work continue seamlessly.

Use exactly these sections:
## Objective
## Important Details
## Work State
### Completed
### Active
### Blocked
## Next Move
## Relevant Files

Rules:
- Preserve exact file paths, shell commands, URLs, and identifiers.
- If a <previous-summary> is provided, UPDATE it with the new events instead of starting over; never drop still-relevant entries.
- Do not mention compaction or summarization.
- Output only the summary.`;

export const openCodeStyleStrategy: Strategy = makeSummaryStrategy({
  id: "opencode-style",
  label: "OpenCode-style (anchored summary + 2-turn tail)",
  usesModel: true,
  keepRatio: 0.12,
  async summarize({ previousSummary, evicted, callModel }) {
    const transcript = [
      previousSummary ? `<previous-summary>\n${previousSummary}\n</previous-summary>\n` : "",
      renderPlainTranscript(evicted),
    ]
      .filter(Boolean)
      .join("\n");
    return callModel({ system: OPENCODE_COMPACT_PROMPT, user: transcript.slice(0, 400_000) });
  },
  frameSummary(summary) {
    return [{ role: "user", content: summary }];
  },
});

// ---------------------------------------------------------------------------
// Cesium ledger (the new engine)
// ---------------------------------------------------------------------------

export function cesiumLedgerStrategy(intensity: number): Strategy {
  return {
    id: `cesium-ledger@${intensity}`,
    label: `Cesium ledger (intensity ${intensity})`,
    usesModel: true,
    createRun({ windowTokens, callModel }) {
      let events: AgentStoredEvent[] = [];
      let syntheticSeq = 1_000_000; // synthetic summary events sit above real seqs
      const stats: StrategyStats = { compactions: 0, compactorCalls: 0, finalTokens: 0, peakTokens: 0 };
      const budgets = resolveCompactionBudgets({
        contextWindowTokens: windowTokens,
        intensity,
        thresholdRatio: TRIGGER_RATIO,
      });
      const assemble = (): CesiumHistoryMessage[] => {
        const normalized = normalizeEventsToHistory(events);
        return withBenchSystem(normalized.slice(1));
      };
      return {
        async feed(batch) {
          events = [...events, ...batch];
          let guard = 0;
          for (;;) {
            const messages = assemble();
            const usedTokens = tokensOf(messages);
            stats.peakTokens = Math.max(stats.peakTokens, usedTokens);
            if (usedTokens < budgets.triggerTokens || guard >= 4) {
              return;
            }
            guard += 1;
            const outcome = await runCesiumCompactionPipeline({
              events,
              usedTokens,
              budgets,
              callModel: async (input) => {
                stats.compactorCalls += 1;
                return callModel(input);
              },
            });
            if (outcome.kind === "noop") {
              return;
            }
            if (outcome.kind === "microcompact") {
              events = outcome.events;
              stats.compactions += 1;
              return;
            }
            stats.compactions += 1;
            syntheticSeq += 1;
            const summaryEvent: AgentStoredEvent = {
              seq: syntheticSeq,
              eventId: `bench-sum-${syntheticSeq}`,
              conversationId: "bench",
              createdAt: Date.now(),
              kind: "compression_summary",
              messageId: `bench-sum-${syntheticSeq}`,
              summary: renderLedgerForContext(outcome.ledger),
              retainedTurnCount: 0,
              compressedTurnCount: 0,
              sourceRange: {
                fromSeq: outcome.stats.spanFromSeq,
                toSeq: outcome.stats.spanToSeq,
              },
              generation: outcome.ledger.generation,
              raw: { engine: CESIUM_COMPACTION_ENGINE_ID, ledger: outcome.ledger },
            };
            events = [...events, summaryEvent];
          }
        },
        async finalize() {
          const messages = assemble();
          stats.finalTokens = tokensOf(messages);
          (this as { debugEvents?: AgentStoredEvent[] }).debugEvents = events;
          return { messages, stats };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function resolveStrategies(spec: string): Strategy[] {
  const known = new Map<string, Strategy>([
    [oracleStrategy.id, oracleStrategy],
    [truncateStrategy.id, truncateStrategy],
    [cesiumLegacyStrategy.id, cesiumLegacyStrategy],
    [codexStyleStrategy.id, codexStyleStrategy],
    [claudeStyleStrategy.id, claudeStyleStrategy],
    [geminiStyleStrategy.id, geminiStyleStrategy],
    [openCodeStyleStrategy.id, openCodeStyleStrategy],
  ]);
  return spec
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((id) => {
      const ledgerMatch = id.match(/^cesium-ledger@([\d.]+)$/);
      if (ledgerMatch) {
        return cesiumLedgerStrategy(Number(ledgerMatch[1]));
      }
      const strategy = known.get(id);
      if (!strategy) {
        throw new Error(
          `Unknown strategy "${id}". Known: ${[...known.keys()].join(", ")}, cesium-ledger@<intensity>`
        );
      }
      return strategy;
    });
}
