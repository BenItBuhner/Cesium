import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitFor } from "./fake-chat-model.js";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export type PeerEngine = {
  url: string;
  login: { username: string; password: string };
  process: ChildProcess;
  output: string[];
  stop(): void;
};

/**
 * A second engine in its own process, data dir, port and login, reached only
 * over HTTP like another machine.
 */
export async function startPeerEngine(input: {
  dataDir: string;
  label: string;
  env: Record<string, string>;
}): Promise<PeerEngine> {
  const port = await freePort();
  const login = { username: "peer-admin", password: "peer-password-for-tests" };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Browser checks on test peers are scripted and never drive a browser: no Chromium check or download.
    CESIUM_CHROMIUM_INSTALL: "skip",
    ...input.env,
    NODE_ENV: "test",
    PORT: String(port),
    HOST: "127.0.0.1",
    OPENCURSOR_DATA_DIR: input.dataDir,
    WORKSPACE_ALLOWED_ROOTS: input.dataDir,
    CESIUM_PROJECTS_ENABLED: "1",
    CESIUM_ENGINE_LABEL: input.label,
    OPENCURSOR_AUTH_USERNAME: login.username,
    OPENCURSOR_AUTH_PASSWORD: login.password,
  };
  // The engine is not a test file; inheriting the runner's context would make it report as a nested test.
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  const url = `http://127.0.0.1:${port}`;
  await waitFor(
    "peer engine health",
    async () => {
      if (child.exitCode != null) {
        throw new Error(`Peer engine exited early:\n${output.join("").slice(-4000)}`);
      }
      return fetch(`${url}/health`)
        .then((response) => (response.ok ? (response.json() as Promise<{ instanceId?: string }>) : null))
        .catch(() => null);
    },
    (health) => typeof health.instanceId === "string",
    90_000
  );
  return { url, login, process: child, output, stop: () => child.kill("SIGTERM") };
}

async function peerSession(peer: PeerEngine): Promise<string> {
  const login = await fetch(`${peer.url}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(peer.login),
  });
  return ((await login.json()) as { token: string }).token;
}

/** Logs in on the peer and revokes one of its peer tokens there. */
export async function revokePeerToken(peer: PeerEngine, tokenId: string): Promise<void> {
  const response = await fetch(`${peer.url}/api/projects/peer-tokens/${encodeURIComponent(tokenId)}`, {
    method: "DELETE",
    headers: { "x-opencursor-session-token": await peerSession(peer) },
  });
  if (!response.ok) {
    throw new Error(`Revoking peer token ${tokenId} failed: HTTP ${response.status} ${await response.text()}`);
  }
}

/** Logs in on the peer, mints a peer token there, and returns its secret and id. */
export async function mintPeerToken(peer: PeerEngine, label: string): Promise<{ secret: string; id: string }> {
  const session = await peerSession(peer);
  const minted = await fetch(`${peer.url}/api/projects/peer-tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencursor-session-token": session },
    body: JSON.stringify({ label }),
  });
  const body = (await minted.json()) as { token: { id: string }; secret: string };
  return { secret: body.secret, id: body.token.id };
}
