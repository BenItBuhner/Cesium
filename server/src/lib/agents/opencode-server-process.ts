import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { getOpenCodeAcpListenPort, openCodeAcpInternalBaseUrl } from "./opencode-acp-port.js";
import { spawnSafeEnv } from "./spawn-env.js";
import {
  OpenCodeServerClient,
  openCodeServerAuthFromEnv,
} from "./opencode-server-client.js";

export type OpenCodeServerConnection = {
  client: OpenCodeServerClient;
  managed: boolean;
  dispose: () => Promise<void>;
};

type ManagedServerPoolRow = {
  client: OpenCodeServerClient;
  child: ChildProcess;
  ready: Promise<void>;
  refs: number;
};

const managedServerPool = new Map<string, ManagedServerPoolRow>();

function releaseManagedOpenCodeServer(poolKey: string, row: ManagedServerPoolRow): void {
  row.refs = Math.max(0, row.refs - 1);
  if (row.refs > 0) {
    return;
  }
  if (managedServerPool.get(poolKey) === row) {
    managedServerPool.delete(poolKey);
  }
  if (!row.child.killed) {
    row.child.kill();
  }
}

async function resolveOpenCodeCommand(): Promise<string> {
  const configured =
    process.env.OPENCURSOR_OPENCODE_SERVER_BIN?.trim() ||
    process.env.OPENCURSOR_OPENCODE_ACP_BIN?.trim();
  if (configured) {
    return configured;
  }
  if (process.platform === "win32" && process.env.APPDATA?.trim()) {
    const npmShim = path.join(process.env.APPDATA, "npm", "opencode.cmd");
    try {
      const { promises: fs } = await import("node:fs");
      await fs.access(npmShim);
      return npmShim;
    } catch {
      // Fall through to PATH resolution.
    }
  }
  return "opencode";
}

async function waitForHealth(client: OpenCodeServerClient): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const health = await client.health();
      if (health.healthy !== false) {
        return;
      }
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`OpenCode Server did not become healthy at ${client.baseUrl}.`);
}

export async function connectOpenCodeServer(input: {
  workspaceRoot: string;
  onStderrLine?: (line: string) => void;
}): Promise<OpenCodeServerConnection> {
  const auth = openCodeServerAuthFromEnv();
  const externalUrl = process.env.OPENCURSOR_OPENCODE_SERVER_URL?.trim();
  if (externalUrl) {
    const client = new OpenCodeServerClient({ baseUrl: externalUrl, ...auth });
    await waitForHealth(client);
    return {
      client,
      managed: false,
      dispose: async () => undefined,
    };
  }

  const poolKey = `opencode-server:${input.workspaceRoot}`;
  const existing = managedServerPool.get(poolKey);
  if (existing) {
    existing.refs += 1;
    await existing.ready;
    return {
      client: existing.client,
      managed: true,
      dispose: async () => {
        releaseManagedOpenCodeServer(poolKey, existing);
      },
    };
  }

  const port = await getOpenCodeAcpListenPort(poolKey);
  const baseUrl = openCodeAcpInternalBaseUrl(port);
  const command = await resolveOpenCodeCommand();
  const child = spawn(
    command,
    ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: input.workspaceRoot,
      env: spawnSafeEnv({
        OPENCURSOR_PROCESS_NAME: `Cesium Agent - OpenCode Server :${port}`,
      }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      argv0: `Cesium Agent - OpenCode Server :${port}`,
    }
  );
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) {
        input.onStderrLine?.(trimmed);
      }
    }
  });
  const client = new OpenCodeServerClient({ baseUrl, ...auth });
  const row: ManagedServerPoolRow = {
    client,
    child,
    refs: 1,
    ready: waitForHealth(client),
  };
  managedServerPool.set(poolKey, row);
  child.once("exit", () => {
    if (managedServerPool.get(poolKey) === row) {
      managedServerPool.delete(poolKey);
    }
  });
  try {
    await row.ready;
  } catch (error) {
    managedServerPool.delete(poolKey);
    if (!child.killed) {
      child.kill();
    }
    throw error;
  }
  return {
    client,
    managed: true,
    dispose: async () => {
      releaseManagedOpenCodeServer(poolKey, row);
    },
  };
}

export function killOpenCodeServerChild(child: ChildProcess | null): void {
  if (child && !child.killed) {
    child.kill();
  }
}
