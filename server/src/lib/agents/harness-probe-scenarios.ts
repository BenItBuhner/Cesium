import type { AgentBackendId } from "./types.js";

export type HarnessProbeScenarioId =
  | "read"
  | "grep"
  | "web_fetch"
  | "edit"
  | "terminal"
  | "mcp"
  | "plugin_mcp"
  | "plugin_skill"
  | "subagent_task"
  | "ask_question"
  | "plan_mode"
  | "permission_prompt"
  | "attachments"
  | "cancel"
  | "resume"
  | "auth_failure";

export type HarnessProbeScenario = {
  id: HarnessProbeScenarioId;
  label: string;
  fixtureRequired: boolean;
  liveCredentialRequired: boolean;
};

export const HARNESS_PROBE_SCENARIOS: HarnessProbeScenario[] = [
  { id: "read", label: "Read file", fixtureRequired: true, liveCredentialRequired: false },
  { id: "grep", label: "Search with grep/glob", fixtureRequired: true, liveCredentialRequired: false },
  { id: "web_fetch", label: "Web search/fetch", fixtureRequired: true, liveCredentialRequired: true },
  { id: "edit", label: "Edit file", fixtureRequired: true, liveCredentialRequired: true },
  { id: "terminal", label: "Run terminal command", fixtureRequired: true, liveCredentialRequired: true },
  { id: "mcp", label: "Call MCP tool", fixtureRequired: true, liveCredentialRequired: true },
  { id: "plugin_mcp", label: "Attach plugin MCP server", fixtureRequired: true, liveCredentialRequired: true },
  { id: "plugin_skill", label: "Apply plugin skill instructions", fixtureRequired: true, liveCredentialRequired: true },
  { id: "subagent_task", label: "Spawn subagent/task", fixtureRequired: true, liveCredentialRequired: true },
  { id: "ask_question", label: "Ask user question", fixtureRequired: true, liveCredentialRequired: true },
  { id: "plan_mode", label: "Plan mode and plan file", fixtureRequired: true, liveCredentialRequired: true },
  { id: "permission_prompt", label: "Permission prompt", fixtureRequired: true, liveCredentialRequired: true },
  { id: "attachments", label: "Prompt attachment", fixtureRequired: true, liveCredentialRequired: true },
  { id: "cancel", label: "Cancel active turn", fixtureRequired: true, liveCredentialRequired: true },
  { id: "resume", label: "Resume session", fixtureRequired: true, liveCredentialRequired: true },
  { id: "auth_failure", label: "Auth failure", fixtureRequired: true, liveCredentialRequired: false },
];

export const HARNESS_PROBE_BACKENDS: AgentBackendId[] = [
  "cesium-agent",
  "codex-app-server",
  "opencode-server",
  "opencode-v2-beta",
  "cursor-sdk",
  "claude-code-sdk",
  "devin-acp",
  "pi-agent",
  "google-antigravity-cli",
];

export type HarnessProbeChecklistItem = {
  backendId: AgentBackendId;
  scenario: HarnessProbeScenario;
};

export function buildHarnessProbeChecklist(
  backendIds: AgentBackendId[] = HARNESS_PROBE_BACKENDS
): HarnessProbeChecklistItem[] {
  return backendIds.flatMap((backendId) =>
    HARNESS_PROBE_SCENARIOS.map((scenario) => ({ backendId, scenario }))
  );
}
