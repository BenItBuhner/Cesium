import { promises as fs } from "node:fs";
import { AcpStdioClient } from "./acp-transport.js";
import {
  ANTIGRAVITY_ACP_DEFAULT_AUTH_METHOD,
  antigravityAcpAuthMethod,
  buildAntigravityAcpSpawnEnv,
  detectAntigravityAcpCredentialState,
  extractAntigravityAcpSignInUrl,
  isAntigravityAcpAuthMethodId,
  readAntigravityAcpSettings,
  resolveAntigravityAcpApiKey,
  resolveAntigravityAcpGeminiHome,
  writeAntigravityAcpSettings,
  type AntigravityAcpAuthMethodId,
} from "./google-antigravity-acp.js";
import { resolveHarnessRuntimeSpec } from "./harness-runtime.js";
import { spawnSafeEnv } from "./spawn-env.js";

/**
 * Sign-in / sign-out for Google's Antigravity ACP server, driven through the
 * protocol itself (`initialize` -> `authenticate {methodId}` -> `logout`)
 * exactly the way Zed does it. Google's server owns the OAuth dance: it
 * prints a sign-in URL to stderr, opens a browser when it can, listens on a
 * loopback port for the redirect, and stores credentials under
 * `$GEMINI_HOME/antigravity-acp/`. Cesium only relays the URL to the user and
 * waits for `authenticate` to resolve.
 *
 * Remote hosts: Google redirects the *browser* to `http://127.0.0.1:<port>/`,
 * which only reaches the server when the browser runs on the same machine.
 * `relayAntigravityAcpOAuthCallback` lets the user paste the URL their browser
 * landed on so Cesium can replay that GET against the loopback listener.
 */

export type AntigravityAcpLoginStatus =
  | "idle"
  | "pending"
  | "awaiting-confirmation"
  | "success"
  | "failed";

export type AntigravityAcpLoginState = {
  status: AntigravityAcpLoginStatus;
  methodId: AntigravityAcpAuthMethodId | null;
  /** Google sign-in URL captured from the server's stderr (OAuth methods). */
  verificationUrl?: string;
  /** Loopback port the server is waiting on, parsed from `redirect_uri`. */
  callbackPort?: number;
  outputTail?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  /** Set once the relay has forwarded a callback for this attempt. */
  callbackRelayed?: boolean;
};

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const LOGOUT_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 60_000;
const OUTPUT_TAIL_LIMIT = 2_000;
/** absl log prefix (`I0903 03:15:43.091511 3869 init.cc:78] ...`). */
const ABSL_LOG_LINE_RE = /^[IWEF]\d{4} \d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+\S+:\d+\]/;

type ActiveLogin = {
  client: AcpStdioClient;
  timer: NodeJS.Timeout;
  settle: (next: Partial<AntigravityAcpLoginState>) => void;
};

let loginState: AntigravityAcpLoginState = { status: "idle", methodId: null };
let activeLogin: ActiveLogin | null = null;

export function getAntigravityAcpLoginState(): AntigravityAcpLoginState {
  return { ...loginState };
}

/** Test hook. */
export function resetAntigravityAcpLoginStateForTest(): void {
  if (activeLogin) {
    clearTimeout(activeLogin.timer);
    void activeLogin.client.close().catch(() => undefined);
    activeLogin = null;
  }
  loginState = { status: "idle", methodId: null };
}

export function parseOAuthCallbackPort(signInUrl: string): number | null {
  try {
    const parsed = new URL(signInUrl);
    const redirect = parsed.searchParams.get("redirect_uri");
    if (!redirect) {
      return null;
    }
    const redirectUrl = new URL(redirect);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(redirectUrl.hostname)) {
      return null;
    }
    const port = Number.parseInt(redirectUrl.port, 10);
    return Number.isFinite(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

function appendTail(prev: string | undefined, line: string): string {
  if (ABSL_LOG_LINE_RE.test(line)) {
    return prev ?? "";
  }
  return `${prev ?? ""}${line}\n`.slice(-OUTPUT_TAIL_LIMIT);
}

async function spawnAcpServerForAuth(extraArgs: string[]): Promise<AcpStdioClient> {
  const runtime = resolveHarnessRuntimeSpec("google-antigravity-acp");
  if (!runtime) {
    throw new Error(
      "Google's Antigravity ACP server (agy_acp_server) is not installed. Install it from Settings -> Agents -> Google Antigravity or set OPENCURSOR_ANTIGRAVITY_ACP_BIN."
    );
  }
  const geminiHome = resolveAntigravityAcpGeminiHome();
  await fs.mkdir(geminiHome, { recursive: true }).catch(() => undefined);
  const env = await buildAntigravityAcpSpawnEnv({ ...spawnSafeEnv(), ...(runtime.env ?? {}) });
  return AcpStdioClient.spawn({
    command: runtime.command,
    args: [...runtime.args, ...extraArgs],
    cwd: geminiHome,
    env,
    processName: "Cesium Agent - Google Antigravity (auth)",
  });
}

async function initializeForAuth(client: AcpStdioClient): Promise<Record<string, unknown>> {
  const init = await withTimeout(
    client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "cesium-server", title: "Cesium Server", version: "0.1.0" },
    }),
    HANDSHAKE_TIMEOUT_MS,
    "initialize"
  );
  return init && typeof init === "object" ? (init as Record<string, unknown>) : {};
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms.`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export type StartAntigravityAcpLoginInput = {
  methodId?: string | null;
  gcpProject?: string | null;
  gcpLocation?: string | null;
};

/**
 * Starts (or returns the in-flight) login. Resolves once the server has
 * either finished authenticating, printed a sign-in URL the user must open,
 * or failed - so Settings can render the next step immediately.
 */
export async function startAntigravityAcpLogin(
  input: StartAntigravityAcpLoginInput = {}
): Promise<AntigravityAcpLoginState> {
  if (activeLogin) {
    return getAntigravityAcpLoginState();
  }
  const methodId: AntigravityAcpAuthMethodId = isAntigravityAcpAuthMethodId(input.methodId)
    ? input.methodId
    : ANTIGRAVITY_ACP_DEFAULT_AUTH_METHOD;
  const method = antigravityAcpAuthMethod(methodId);
  const startedAt = Date.now();
  loginState = { status: "pending", methodId, startedAt, outputTail: "" };

  const fail = (error: string): AntigravityAcpLoginState => {
    loginState = { ...loginState, status: "failed", error, finishedAt: Date.now() };
    return getAntigravityAcpLoginState();
  };

  if (method.requiresGcp) {
    const settings = await readAntigravityAcpSettings();
    const project = input.gcpProject?.trim() || settings?.gcp?.project?.trim() || process.env.GOOGLE_CLOUD_PROJECT?.trim();
    const location = input.gcpLocation?.trim() || settings?.gcp?.location?.trim() || process.env.GOOGLE_CLOUD_LOCATION?.trim();
    if (!project || !location) {
      return fail(`${method.name} needs a GCP project and location. Enter both, then retry.`);
    }
    await writeAntigravityAcpSettings({ gcpProject: project, gcpLocation: location });
  }
  if (methodId === "gemini-api-key" && !(await resolveAntigravityAcpApiKey())) {
    return fail(
      "No Gemini API key found. Set GEMINI_API_KEY (or GOOGLE_API_KEY) in the engine environment, or add a Google provider key under Settings -> Agents -> Cesium Agent, then retry."
    );
  }

  let client: AcpStdioClient;
  try {
    client = await spawnAcpServerForAuth(["--alsologtostderr"]);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  let settled = false;
  const settle = (next: Partial<AntigravityAcpLoginState>) => {
    if (settled) {
      return;
    }
    settled = true;
    if (activeLogin?.client === client) {
      clearTimeout(activeLogin.timer);
      activeLogin = null;
    }
    loginState = { ...loginState, ...next, finishedAt: Date.now() };
    void client.close().catch(() => undefined);
  };
  const timer = setTimeout(() => {
    settle({ status: "failed", error: "Login timed out waiting for Google to redirect back. Try again." });
  }, LOGIN_TIMEOUT_MS);
  activeLogin = { client, timer, settle };

  client.onStderr((line) => {
    loginState = { ...loginState, outputTail: appendTail(loginState.outputTail, line) };
    const url = extractAntigravityAcpSignInUrl(line);
    if (url && !loginState.verificationUrl) {
      loginState = {
        ...loginState,
        status: "awaiting-confirmation",
        verificationUrl: url,
        callbackPort: parseOAuthCallbackPort(url) ?? undefined,
      };
    }
  });
  client.onExit((code) => {
    settle({
      status: "failed",
      error: `The Antigravity ACP server exited (code ${code ?? "unknown"}) before authentication completed.`,
    });
  });

  void (async () => {
    try {
      const init = await initializeForAuth(client);
      const offered = Array.isArray(init.authMethods)
        ? init.authMethods
            .map((entry) =>
              entry && typeof entry === "object" ? (entry as Record<string, unknown>).id : entry
            )
            .filter((id): id is string => typeof id === "string")
        : [];
      if (offered.length > 0 && !offered.includes(methodId)) {
        settle({
          status: "failed",
          error: `The installed ACP server does not offer ${method.name} (offered: ${offered.join(", ")}).`,
        });
        return;
      }
      await client.request("authenticate", { methodId });
      // The server records `auth.type` itself; make sure it is there even if a
      // future build stops doing so, since headless turns rely on it.
      await writeAntigravityAcpSettings({ authType: methodId }).catch(() => undefined);
      settle({ status: "success", error: undefined });
    } catch (error) {
      settle({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  // Give the server a moment to either finish (API key) or print the URL.
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline && loginState.status === "pending" && activeLogin?.client === client) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return getAntigravityAcpLoginState();
}

export function cancelAntigravityAcpLogin(): AntigravityAcpLoginState {
  if (activeLogin) {
    activeLogin.settle({ status: "failed", error: "Login cancelled." });
  }
  return getAntigravityAcpLoginState();
}

/**
 * Replays a pasted OAuth redirect (`http://127.0.0.1:<port>/?state=...&code=...`)
 * against the server's loopback listener on this host. Only the port the
 * current login advertised is accepted, and only loopback hosts.
 */
export async function relayAntigravityAcpOAuthCallback(
  pastedUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<AntigravityAcpLoginState> {
  if (!activeLogin || loginState.status !== "awaiting-confirmation") {
    throw new Error("No Google sign-in is waiting for a callback. Start the login first.");
  }
  let parsed: URL;
  try {
    parsed = new URL(pastedUrl.trim());
  } catch {
    throw new Error("Paste the full URL from the browser tab that failed to load (it starts with http://127.0.0.1:).");
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
    throw new Error("That URL is not a loopback redirect; expected http://127.0.0.1:<port>/?...");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!loginState.callbackPort || port !== loginState.callbackPort) {
    throw new Error(
      `That callback targets port ${parsed.port || "?"}, but this login is waiting on port ${loginState.callbackPort ?? "unknown"}. Copy the URL from the tab opened for this sign-in.`
    );
  }
  if (!parsed.searchParams.get("code") && !parsed.searchParams.get("error")) {
    throw new Error("The pasted URL has no OAuth code. Copy the complete URL including everything after '?'.");
  }
  const relayUrl = new URL(`http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`);
  try {
    await fetchImpl(relayUrl, { method: "GET", redirect: "manual" });
  } catch (error) {
    throw new Error(
      `Could not reach the ACP server's callback listener on port ${port}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  loginState = { ...loginState, callbackRelayed: true };
  // `authenticate` should now resolve; wait briefly so the caller sees the outcome.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && loginState.status === "awaiting-confirmation") {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return getAntigravityAcpLoginState();
}

/**
 * `logout` over ACP (advertised via `agentCapabilities.auth.logout`), then
 * clear `auth.type` so headless turns stop assuming credentials exist.
 */
export async function logoutAntigravityAcp(): Promise<AntigravityAcpLoginState> {
  cancelAntigravityAcpLogin();
  loginState = { status: "pending", methodId: loginState.methodId, startedAt: Date.now(), outputTail: "" };
  let client: AcpStdioClient | null = null;
  try {
    client = await spawnAcpServerForAuth([]);
    const init = await initializeForAuth(client);
    const caps =
      init.agentCapabilities && typeof init.agentCapabilities === "object"
        ? (init.agentCapabilities as Record<string, unknown>)
        : {};
    const auth = caps.auth && typeof caps.auth === "object" ? (caps.auth as Record<string, unknown>) : {};
    if (auth.logout !== undefined && auth.logout !== null) {
      await withTimeout(client.request("logout", {}), LOGOUT_TIMEOUT_MS, "logout");
    }
    await writeAntigravityAcpSettings({ authType: null });
    loginState = { status: "idle", methodId: null, finishedAt: Date.now() };
  } catch (error) {
    loginState = {
      ...loginState,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      finishedAt: Date.now(),
    };
  } finally {
    await client?.close().catch(() => undefined);
  }
  return getAntigravityAcpLoginState();
}

/** Signed-in verdict for Settings; combines login progress with on-disk state. */
export async function describeAntigravityAcpSignIn(): Promise<{
  signedIn: boolean | null;
  configuredAuthType: AntigravityAcpAuthMethodId | null;
  apiKeyAvailable: boolean;
  gcpConfigured: boolean;
  geminiHome: string;
}> {
  const state = await detectAntigravityAcpCredentialState();
  return {
    signedIn: loginState.status === "success" ? true : state.signedIn,
    configuredAuthType: state.configuredAuthType,
    apiKeyAvailable: state.apiKeyAvailable,
    gcpConfigured: state.gcpConfigured,
    geminiHome: state.geminiHome,
  };
}
