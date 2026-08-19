import { promises as fs } from "node:fs";
import path from "node:path";
import { exportEnabledMcpServersForSdk } from "../agents/mcp-export-adapter.js";
import { listEnabledMcpServers } from "../mcp/server-store.js";
import { describePiAgentHome } from "../pi-agent-settings.js";

type PiMcpFile = {
  schemaVersion: 1;
  updatedAt: number;
  servers: Record<string, unknown>;
};

async function resolvePiAgentHome(): Promise<string> {
  const home = await describePiAgentHome();
  return home.agentDir;
}

export async function syncWorkspacePiMcpConfig(input: {
  workspaceId: string;
  workspaceRoot: string;
}): Promise<{ path: string; managedServerIds: string[]; written: boolean }> {
  const enabled = await listEnabledMcpServers(input.workspaceId);
  const exported = await exportEnabledMcpServersForSdk({
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    configs: enabled,
  });
  const workspaceFile = path.join(input.workspaceRoot, ".pi", "cesium-mcp.json");
  const home = await resolvePiAgentHome();
  const homeFile = path.join(home, "cesium-mcp.json");
  const payload: PiMcpFile = {
    schemaVersion: 1,
    updatedAt: Date.now(),
    servers: exported.servers,
  };
  await fs.mkdir(path.dirname(workspaceFile), { recursive: true });
  await fs.writeFile(workspaceFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const syncHome =
    process.env.OPENCURSOR_PI_MCP_SYNC_HOME === "1" ||
    (!process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== "test");
  if (syncHome) {
    try {
      await fs.mkdir(path.dirname(homeFile), { recursive: true });
      await fs.writeFile(homeFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    } catch {
      // Home may be unwritable.
    }
  }
  return {
    path: workspaceFile,
    managedServerIds: Object.keys(exported.servers),
    written: true,
  };
}
