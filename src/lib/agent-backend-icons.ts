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
  "cursor-acp": { light: "Cursor-Light.svg", dark: "Cursor-Dark.svg" },
  "cursor-sdk": { light: "Cursor-Light.svg", dark: "Cursor-Dark.svg" },
  "codex-adapter": { light: "Codex-Light.svg", dark: "Codex-Dark.svg" },
  "codex-app-server": { light: "Codex-Light.svg", dark: "Codex-Dark.svg" },
  "claude-adapter": {
    light: "Claude-Code-Light.svg",
    dark: "Claude-Code-Dark.svg",
  },
  "opencode-acp": { light: "OpenCode-Light.svg", dark: "OpenCode-Dark.svg" },
  "opencode-server": { light: "OpenCode-Light.svg", dark: "OpenCode-Dark.svg" },
  "gemini-acp": { light: "Gemini-CLI-Light.svg", dark: "Gemini-CLI-Dark.svg" },
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
