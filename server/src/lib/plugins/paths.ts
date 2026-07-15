import path from "node:path";
import { DATA_DIR } from "../persistence.js";

export function agentPluginsConfigPath(workspaceId: string): string {
  return path.join(DATA_DIR, "workspaces", workspaceId, "agent-plugins.json");
}
