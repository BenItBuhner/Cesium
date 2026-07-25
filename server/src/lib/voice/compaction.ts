/**
 * Voice-scale context compaction, mirroring the Cesium agent harness's
 * compression system (`cesium-provider.buildHistory` +
 * `cesium-history.summarizeForCompression`):
 *
 * - trigger: visible user turns exceed a turn limit OR the chars/4 token
 *   estimate crosses a threshold;
 * - split: the most recent N user turns are retained verbatim, everything
 *   older is folded into a deterministic transcript summary;
 * - reassembly: the summary is injected as a `[Compressed earlier
 *   conversation]` message ahead of the retained turns.
 *
 * One deliberate deviation from the harness: the running summary keeps its
 * TAIL when it overflows (the harness truncates the head). A voice session
 * is meant to run indefinitely, so the most recent compressed context wins.
 */

export type VoiceHistoryEntry = {
  role: "user" | "assistant";
  content: string;
};

export type VoiceCompactionConfig = {
  /** Compact once the history holds more user turns than this. */
  turnLimit: number;
  /** User turns kept verbatim after compaction. */
  targetTurns: number;
  /** Compact once estimateVoiceTokens(summary, history) crosses this. */
  tokenThreshold: number;
  /** Running summary size cap in characters (tail-preserving). */
  summaryCharCap: number;
};

export const DEFAULT_VOICE_COMPACTION: VoiceCompactionConfig = {
  turnLimit: 40,
  targetTurns: 16,
  tokenThreshold: 6000,
  summaryCharCap: 8000,
};

function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function voiceCompactionConfig(
  env: NodeJS.ProcessEnv = process.env
): VoiceCompactionConfig {
  return {
    turnLimit: positiveIntEnv(
      env.OPENCURSOR_VOICE_TURN_LIMIT,
      DEFAULT_VOICE_COMPACTION.turnLimit
    ),
    targetTurns: positiveIntEnv(
      env.OPENCURSOR_VOICE_TARGET_TURNS,
      DEFAULT_VOICE_COMPACTION.targetTurns
    ),
    tokenThreshold: positiveIntEnv(
      env.OPENCURSOR_VOICE_TOKEN_THRESHOLD,
      DEFAULT_VOICE_COMPACTION.tokenThreshold
    ),
    summaryCharCap: positiveIntEnv(
      env.OPENCURSOR_VOICE_SUMMARY_CHAR_CAP,
      DEFAULT_VOICE_COMPACTION.summaryCharCap
    ),
  };
}

/** Same chars/4 heuristic the harness uses (`estimateHistoryTokens`). */
export function estimateVoiceTokens(
  summary: string | null,
  history: VoiceHistoryEntry[]
): number {
  let chars = summary ? summary.length : 0;
  for (const entry of history) {
    chars += entry.content.length;
  }
  return Math.ceil(chars / 4);
}

function truncateLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** Deterministic transcript summary, per `summarizeForCompression`. */
export function summarizeVoiceEntries(entries: VoiceHistoryEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const speaker = entry.role === "user" ? "User" : "Assistant";
    lines.push(`${speaker}: ${truncateLine(entry.content, 400)}`);
  }
  return lines.join("\n");
}

export type VoiceCompactionResult = {
  compacted: boolean;
  summary: string | null;
  history: VoiceHistoryEntry[];
  compressedTurnCount: number;
  retainedTurnCount: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
};

export function compactVoiceHistory(
  summary: string | null,
  history: VoiceHistoryEntry[],
  config: VoiceCompactionConfig = DEFAULT_VOICE_COMPACTION
): VoiceCompactionResult {
  const userTurns = history.filter((entry) => entry.role === "user").length;
  const estimatedTokensBefore = estimateVoiceTokens(summary, history);
  const shouldCompact =
    userTurns > config.turnLimit ||
    estimatedTokensBefore >= config.tokenThreshold;
  if (!shouldCompact || userTurns <= config.targetTurns) {
    return {
      compacted: false,
      summary,
      history,
      compressedTurnCount: 0,
      retainedTurnCount: userTurns,
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedTokensBefore,
    };
  }

  // Walk backward keeping the last `targetTurns` user turns (and their
  // assistant replies); everything before the split gets summarized.
  let splitIndex = 0;
  let seenUserTurns = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === "user") {
      seenUserTurns++;
      if (seenUserTurns === config.targetTurns) {
        splitIndex = i;
        break;
      }
    }
  }
  const compressed = history.slice(0, splitIndex);
  const retained = history.slice(splitIndex);

  const newLines = summarizeVoiceEntries(compressed);
  const mergedRaw = summary ? `${summary}\n${newLines}` : newLines;
  // Tail-preserving cap: drop the OLDEST summary lines on overflow.
  const merged =
    mergedRaw.length > config.summaryCharCap
      ? mergedRaw.slice(mergedRaw.length - config.summaryCharCap).replace(/^[^\n]*\n/, "")
      : mergedRaw;

  const estimatedTokensAfter = estimateVoiceTokens(merged, retained);
  return {
    compacted: true,
    summary: merged,
    history: retained,
    compressedTurnCount: compressed.filter((entry) => entry.role === "user")
      .length,
    retainedTurnCount: config.targetTurns,
    estimatedTokensBefore,
    estimatedTokensAfter,
  };
}

/** Prompt reassembly helper, mirroring `cesium-history`'s summary message. */
export function summaryPromptMessage(summary: string): string {
  return `[Compressed earlier conversation]\n${summary}`;
}
