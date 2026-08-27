import type { AgentBackendId } from "../types.js";
import type { AgentEventInput } from "../types.js";

/**
 * Cross-harness conversation import.
 *
 * Each `HarnessImportSource` knows how to discover, read, and re-home the
 * on-disk session storage of one external agent harness (Claude Code, Codex,
 * OpenCode, Gemini/Antigravity, Pi). Imported conversations keep the harness's
 * native session id verbatim so the original harness CLI can resume the exact
 * same conversation afterwards (`providerSessionId` on the record).
 */

export type HarnessImportAvailability = {
  /** True when the harness's local storage exists on this machine. */
  available: boolean;
  /** Human explanation shown when not available (or for extra context). */
  reason?: string;
  /** Absolute path of the storage root that was probed. */
  storageRoot?: string;
};

export type HarnessSessionSummary = {
  /** Harness-native session id (verbatim - used for import + resume). */
  id: string;
  title: string;
  /** Working directory the session was created in, when recorded. */
  cwd?: string;
  /** Epoch ms when the session started (best effort). */
  createdAt: number | null;
  /** Epoch ms of the last recorded activity. */
  updatedAt: number | null;
  /** Count of user + assistant conversation messages (tool calls excluded). */
  messageCount: number;
  /** Absolute path of the artifact this summary was read from. */
  sourcePath: string;
  /** Short first-user-message snippet for list previews. */
  preview?: string;
  /**
   * Harness-native model identifier in the backend's own `config.modelId`
   * format, when the session records one - continuation then uses the exact
   * model the source session was running, not the backend default.
   */
  modelId?: string;
  /** Human-readable model label paired with `modelId`. */
  modelName?: string;
};

export type HarnessSessionTranscript = {
  summary: HarnessSessionSummary;
  /**
   * Cesium events mirroring the native transcript 1:1 (user/assistant text,
   * reasoning, tool calls). `createdAt` is set from source timestamps; seq is
   * assigned by the store on append.
   */
  events: AgentEventInput[];
  /** ISO timestamp of the session start, when known. */
  startedAt?: string;
};

export interface HarnessImportSource {
  /** Stable key for the harness family (e.g. "claude-code", "codex"). */
  harnessKey: string;
  /** Cesium backend ids this source feeds (import targets). */
  backendIds: AgentBackendId[];
  displayName: string;
  /** Probe the machine for this harness's local storage. */
  detect: () => Promise<HarnessImportAvailability>;
  /** List importable sessions, newest first. */
  listSessions: () => Promise<HarnessSessionSummary[]>;
  /** Read one session into a normalized Cesium transcript. */
  readSession: (sessionId: string) => Promise<HarnessSessionTranscript>;
  /**
   * Make the native session resumable for the given workspace root (harnesses
   * that namespace storage by cwd get their artifacts re-homed). Returns the
   * `providerSessionId` the conversation should carry. Defaults to the raw
   * session id when the harness resolves sessions globally.
   */
  prepareNativeResume?: (sessionId: string, workspaceRoot: string) => Promise<string>;
}
