import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getOpenCodeAcpListenPort, openCodeAcpInternalBaseUrl } from "./opencode-acp-port.js";
import { spawnSafeEnv } from "./spawn-env.js";
import {
  OpenCodeV2Client,
  openCodeV2AuthFromEnv,
} from "./opencode-v2-client.js";

export type OpenCodeV2Connection = {
  client: OpenCodeV2Client;
  managed: boolean;
  dispose: () => Promise<void>;
};

type ManagedServerPoolRow = {
  client: OpenCodeV2Client;
  child: ChildProcess;
  ready: Promise<void>;
  refs: number;
};

const managedServerPool = new Map<string, ManagedServerPoolRow>();

export function resolveOpenCodeV2CommandPath(): string | null {
  const configured =
    process.env.OPENCURSOR_OPENCODE_V2_SERVER_BIN?.trim() ||
    process.env.OPENCURSOR_OPENCODE_V2_BIN?.trim();
  if (configured) {
    if (
      configured.includes("/") ||
      configured.includes("\\") ||
      /^[a-zA-Z]:/.test(configured)
    ) {
      return existsSync(configured) ? configured : null;
    }
  }
  const names =
    process.platform === "win32"
      ? [
          configured,
          "opencode2.exe",
          "opencode2.cmd",
          "opencode2.bat",
          "opencode2.ps1",
          "opencode2",
        ]
      : [configured, "opencode2"];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      if (!name) continue;
      const candidate = path.join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  const homeCandidates = [
    process.env.OPENCURSOR_REAL_HOME?.trim(),
    process.env.USER?.trim() ? `/home/${process.env.USER.trim()}` : undefined,
    os.homedir(),
  ].filter((value): value is string => Boolean(value));
  for (const home of homeCandidates) {
    for (const name of names) {
      if (!name) continue;
      const candidate = path.join(home, ".opencode", "bin", name);
      if (existsSync(candidate)) return candidate;
    }
  }
  if (process.platform === "win32" && process.env.APPDATA?.trim()) {
    const npmShim = path.join(process.env.APPDATA, "npm", "opencode2.cmd");
    if (existsSync(npmShim)) return npmShim;
  }
  return null;
}

function quoteWindowsArg(value: string): string {
  return /[\s"]/u.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function spawnCommand(
  command: string,
  args: string[]
): { command: string; args: string[]; direct: boolean } {
  const extension = path.extname(command).toLowerCase();
  if (process.platform === "win32" && (extension === ".cmd" || extension === ".bat")) {
    const comspec =
      process.env.ComSpec ??
      path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "cmd.exe"
      );
    return {
      command: comspec,
      args: ["/d", "/s", "/c", [command, ...args].map(quoteWindowsArg).join(" ")],
      direct: false,
    };
  }
  if (process.platform === "win32" && extension === ".ps1") {
    const powershell =
      process.env.PWSH ??
      path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      );
    return {
      command: powershell,
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", command, ...args],
      direct: false,
    };
  }
  return { command, args, direct: true };
}

async function waitForHealth(client: OpenCodeV2Client): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const health = await client.health();
      if (health.healthy === true) {
        return;
      }
    } catch {
      // Keep polling while the beta server initializes its database and catalog.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`OpenCode v2 Beta did not become healthy at ${client.baseUrl}.`);
}

function stopManagedChild(child: ChildProcess): void {
  child.stdin?.end();
  if (child.exitCode != null) {
    return;
  }
  const forceTimer = setTimeout(() => {
    if (child.exitCode == null) {
      child.kill("SIGKILL");
    }
  }, 3_000);
  const terminateTimer = setTimeout(() => {
    if (child.exitCode == null) {
      child.kill("SIGTERM");
    }
  }, 1_500);
  child.once("exit", () => {
    clearTimeout(terminateTimer);
    clearTimeout(forceTimer);
  });
  terminateTimer.unref?.();
  forceTimer.unref?.();
}

function releaseManagedServer(poolKey: string, row: ManagedServerPoolRow): void {
  row.refs = Math.max(0, row.refs - 1);
  if (row.refs > 0) {
    return;
  }
  if (managedServerPool.get(poolKey) === row) {
    managedServerPool.delete(poolKey);
  }
  stopManagedChild(row.child);
}

export async function connectOpenCodeV2(input: {
  workspaceRoot: string;
  onOutputLine?: (line: string) => void;
}): Promise<OpenCodeV2Connection> {
  const externalUrl = process.env.OPENCURSOR_OPENCODE_V2_SERVER_URL?.trim();
  if (externalUrl) {
    const client = new OpenCodeV2Client({
      baseUrl: externalUrl,
      ...openCodeV2AuthFromEnv(),
    });
    await waitForHealth(client);
    return {
      client,
      managed: false,
      dispose: async () => undefined,
    };
  }

  const poolKey = `opencode-v2-beta:${input.workspaceRoot}`;
  const existing = managedServerPool.get(poolKey);
  if (existing) {
    existing.refs += 1;
    await existing.ready;
    return {
      client: existing.client,
      managed: true,
      dispose: async () => releaseManagedServer(poolKey, existing),
    };
  }

  const port = await getOpenCodeAcpListenPort(poolKey);
  const baseUrl = openCodeAcpInternalBaseUrl(port);
  const password = randomBytes(32).toString("base64url");
  const executable = resolveOpenCodeV2CommandPath() ?? "opencode2";
  const invocation = spawnCommand(executable, [
    "serve",
    "--stdio",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ]);
  const configuredDirectory = process.env.OPENCURSOR_OPENCODE_V2_CONFIG_DIR?.trim();
  const child = spawn(
    invocation.command,
    invocation.args,
    {
      cwd: input.workspaceRoot,
      env: spawnSafeEnv({
        OPENCODE_PASSWORD: password,
        OPENCODE_CLIENT: "cesium-opencode-v2-beta",
        ...(configuredDirectory ? { OPENCODE_CONFIG_DIR: path.resolve(configuredDirectory) } : {}),
        OPENCURSOR_PROCESS_NAME: `Cesium Agent - OpenCode v2 Beta :${port}`,
      }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(invocation.direct
        ? { argv0: `Cesium Agent - OpenCode v2 Beta :${port}` }
        : {}),
    }
  );
  const reportLines = (chunk: unknown) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('{"url":')) {
        input.onOutputLine?.(trimmed);
      }
    }
  };
  child.stdout?.on("data", reportLines);
  child.stderr?.on("data", reportLines);

  const client = new OpenCodeV2Client({ baseUrl, password });
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
    stopManagedChild(child);
    throw error;
  }
  return {
    client,
    managed: true,
    dispose: async () => releaseManagedServer(poolKey, row),
  };
}

export function openCodeV2ConfiguredCommand(): string {
  return resolveOpenCodeV2CommandPath() ?? "opencode2";
}
