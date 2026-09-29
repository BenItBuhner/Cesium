import { buildCesiumBaseSystemPrompt } from "@cesium/core/mcp";
import type { OrchestrationAssignmentStatus } from "../../orchestration/types.js";

export const CESIUM_SYSTEM_PROMPT = buildCesiumBaseSystemPrompt();

export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
/** Slow third-party hosts (Cerebras, Nvidia NIM, etc.) can take a long time on large tool prompts. */
export const CESIUM_RESPONSE_WARNING_MS = 10 * 60 * 1000;
export const CESIUM_TOOL_RESULT_MODEL_MAX_CHARS = 12_000;
/** A tool result shrinks to fit the context headroom, but never below this. */
export const CESIUM_TOOL_RESULT_MODEL_MIN_CHARS = 2_000;
/** Chars per token when turning token headroom into a character budget; real text runs ~3.3. */
export const CESIUM_HEADROOM_CHARS_PER_TOKEN = 3;
export const HISTORY_TURN_LIMIT = 250;
export const HISTORY_EVENT_LIMIT = 20_000;
export const HISTORY_COMPACTION_TARGET_TURNS = 160;
export const HISTORY_COMPACTION_THRESHOLD_RATIO = 0.72;
/** Compaction keeps the newest turns that fit in this share of the context window. */
export const HISTORY_COMPACTION_TARGET_RATIO = 0.4;
/** Mid-turn, a pruning boundary runs once the context passes this share of the window... */
export const CONTEXT_PRUNE_TRIGGER_RATIO = 0.85;
/** ...and stubs the oldest tool outputs until it is back under this share. */
export const CONTEXT_PRUNE_TARGET_RATIO = 0.6;
/** The newest tool batches a pruning boundary never touches. */
export const CONTEXT_PRUNE_KEEP_BATCHES = 2;
/** Results shorter than this are not worth a stub. */
export const CONTEXT_PRUNE_MIN_RESULT_CHARS = 1_000;
export const LARGE_FILE_LINE_LIMIT = 3500;
export const MAX_READ_LINES = 2000;
export const MAX_GREP_RESULTS = 5000;
export const DEFAULT_GREP_RESULTS = 100;
export const TERMINAL_OUTPUT_CAP = 80_000;
export const ORCHESTRATION_WAIT_HEARTBEAT_MS = 15_000;
export const ORCHESTRATION_WAIT_DEFAULT_MS = 30_000;
/** Timed `wait` tool: cancel/disposal poll interval while sleeping. */
export const WAIT_POLL_MS = 1_000;
/** Timed `wait` tool: status heartbeat cadence (mirrors orchestration wait). */
export const WAIT_HEARTBEAT_MS = 15_000;
/** Hard cap so a bad model call cannot sleep forever (24 hours). */
export const WAIT_MAX_SECONDS = 24 * 60 * 60;
export const ORCHESTRATION_ASSIGNMENT_TERMINAL_STATUSES: OrchestrationAssignmentStatus[] = [
  "completed",
  "failed",
  "cancelled",
];
