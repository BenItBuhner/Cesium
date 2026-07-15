import type { AgentBackendId } from "@/lib/agent-types";

/**
 * Filenames under `/agent-backend-icons/` (public/).
 */
export type AgentBackendIconFilenames = {
  light: string;
  dark: string;
};

export const AGENT_BACKEND_ICON_FILES: Partial<
  Record<AgentBackendId, AgentBackendIconFilenames>
> = {
  "cursor-sdk": { light: "Cursor-Light.svg", dark: "Cursor-Dark.svg" },
  "codex-app-server": { light: "Codex-Light.svg", dark: "Codex-Dark.svg" },
  "claude-code-sdk": {
    light: "Claude-Code-Light.svg",
    dark: "Claude-Code-Dark.svg",
  },
  "opencode-server": { light: "OpenCode-Light.svg", dark: "OpenCode-Dark.svg" },
  "devin-acp": { light: "Devin-Light.svg", dark: "Devin-Dark.svg" },
};

const ICON_BASE = "/agent-backend-icons";

export function agentBackendIconUrl(
  backendId: AgentBackendId,
  appearance: "light" | "dark"
): string | null {
  const entry = AGENT_BACKEND_ICON_FILES[backendId];
  if (!entry) {
    return null;
  }
  const file = appearance === "dark" ? entry.dark : entry.light;
  return `${ICON_BASE}/${encodeURIComponent(file)}`;
}

export function hasAgentBackendIconAsset(backendId: AgentBackendId): boolean {
  return Boolean(AGENT_BACKEND_ICON_FILES[backendId]);
}
