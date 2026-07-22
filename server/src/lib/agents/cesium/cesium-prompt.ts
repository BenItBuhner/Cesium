import { buildCesiumBaseSystemPrompt } from "@cesium/core/mcp";
import type { OrchestrationAssignmentStatus } from "../../orchestration/types.js";
export {
  PERMISSION_OPTIONS,
  STANDARD_PERMISSION_OPTIONS,
} from "../permission-options.js";

export const CESIUM_SYSTEM_PROMPT = buildCesiumBaseSystemPrompt();

export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
/** Slow third-party hosts (Cerebras, Nvidia NIM, etc.) can take a long time on large tool prompts. */
export const CESIUM_RESPONSE_WARNING_MS = 10 * 60 * 1000;
export const CESIUM_MAX_TOOL_ITERATIONS = 80;
export const CESIUM_TOOL_RESULT_MODEL_MAX_CHARS = 12_000;
export const CESIUM_TOOL_RESULT_MODEL_TOTAL_MAX_CHARS = 96_000;
export const HISTORY_TURN_LIMIT = 250;
export const HISTORY_EVENT_LIMIT = 20_000;
export const HISTORY_COMPACTION_TARGET_TURNS = 160;
export const HISTORY_COMPACTION_THRESHOLD_RATIO = 0.72;
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
