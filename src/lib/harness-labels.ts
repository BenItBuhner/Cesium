import type { AgentBackendId } from "@/lib/agent-types";

/**
 * Display labels per runtime backend id. Lives here (not in the settings UI
 * module) so lightweight consumers such as the settings search index do not
 * pull ~4k lines of settings components into the workbench's initial chunk.
 */
export const HARNESS_LABELS: Record<AgentBackendId, string> = {
  "cesium-agent": "Cesium Agent (Beta)",
  "cursor-sdk": "Cursor (SDK)",
  "cursor-acp": "Cursor (ACP)",
  "opencode-server": "OpenCode",
  "opencode-v2-beta": "OpenCode",
  "devin-acp": "Devin",
  "grok-build": "Grok Build",
  "codex-app-server": "Codex (Server)",
  "codex-acp": "Codex (ACP)",
  "claude-code-sdk": "Claude Code",
  "pi-agent": "Pi Agent",
  "google-antigravity-cli": "Google Antigravity (CLI, Legacy)",
  "google-antigravity-acp": "Google Antigravity",
};
