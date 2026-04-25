import { createServer } from "node:net";

const workspaceToPort = new Map<string, number>();

export async function pickEphemeralListenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port =
        typeof addr === "object" && addr && "port" in addr ? (addr as { port: number }).port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** Stable per-workspace port so pooled `opencode acp` processes keep a consistent `--port`. */
export async function getOpenCodeAcpListenPort(workspaceRoot: string): Promise<number> {
  const hit = workspaceToPort.get(workspaceRoot);
  if (hit != null) {
    return hit;
  }
  const port = await pickEphemeralListenPort();
  workspaceToPort.set(workspaceRoot, port);
  return port;
}

export function openCodeAcpInternalBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** CLI args appended after the opencode executable (stock flags; no fork required). */
export function buildOpenCodeAcpCliArgs(port: number): string[] {
  return ["acp", "--hostname", "127.0.0.1", "--port", String(port)];
}
