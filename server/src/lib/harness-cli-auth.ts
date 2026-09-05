/**
 * Host-side CLI login / logout for harnesses that authenticate with their
 * own binary (Cursor ACP, Grok, Codex, OpenCode, Devin, Claude, Antigravity).
 *
 * Spawns the vendor CLI on the server, scrapes device-auth URLs/codes from
 * stdout, and tracks the process until it exits so Settings can Sign in /
 * Sign out without a TTY.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildHarnessInvocation,
  detectHarnessCli,
  harnessHomeDirCandidates,
  type HarnessCliId,
} from "./agents/harness-runtime.js";
import { spawnSafeEnv } from "./agents/spawn-env.js";
import type { AgentBackendId } from "./agents/types.js";
import {
  ANTIGRAVITY_ACP_AUTH_METHODS,
  antigravityAcpCredentialRelPaths,
} from "./agents/google-antigravity-acp.js";
import {
  cancelAntigravityAcpLogin,
  describeAntigravityAcpSignIn,
  getAntigravityAcpLoginState,
  logoutAntigravityAcp,
  relayAntigravityAcpOAuthCallback,
  startAntigravityAcpLogin,
  type StartAntigravityAcpLoginInput,
} from "./agents/google-antigravity-acp-auth.js";

export type HarnessCliAuthBackendId =
  | "cursor-acp"
  | "grok-build"
  | "opencode-server"
  | "devin-acp"
  | "codex-app-server"
  | "codex-acp"
  | "claude-code-sdk"
  | "google-antigravity-cli"
  | "google-antigravity-acp";

export type HarnessCliAuthStatus =
  | "idle"
  | "pending"
  | "awaiting-confirmation"
  | "success"
  | "failed";

export type HarnessCliAuthMethodInfo = {
  id: string;
  name: string;
  description: string;
  requiresGcp: boolean;
  browserLogin: boolean;
  apiKeyEnvVar: string | null;
};

export type HarnessCliAuthState = {
  backendId: HarnessCliAuthBackendId;
  installed: boolean;
  signedIn: boolean | null;
  accountLabel?: string;
  status: HarnessCliAuthStatus;
  verificationUrl?: string;
  userCode?: string;
  outputTail?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  loginCommand: string;
  logoutCommand: string;
  /** ACP-driven auth (Antigravity): the selectable `authenticate` methods. */
  authMethods?: HarnessCliAuthMethodInfo[];
  /** ACP-driven auth: method in flight or recorded in the server's settings. */
  authMethodId?: string | null;
  /** ACP-driven auth: loopback port Google's redirect targets (for the relay). */
  callbackPort?: number;
  callbackRelayed?: boolean;
  /** ACP-driven auth: a Gemini API key is resolvable for `gemini-api-key`. */
  apiKeyAvailable?: boolean;
  gcpConfigured?: boolean;
  /** ACP-driven auth: the `$GEMINI_HOME` the server stores credentials under. */
  stateHome?: string;
};

type AuthSpec = {
  backendId: HarnessCliAuthBackendId;
  harnessCliId: HarnessCliId;
  /** `cli` (default) spawns the vendor login command; `acp` drives `authenticate` over ACP. */
  mode?: "cli" | "acp";
  loginArgs: string[];
  logoutArgs: string[];
  statusArgs?: string[];
  credentialRelPaths: string[][];
  loginCommand: string;
  logoutCommand: string;
};

export type HarnessCliLoginOptions = StartAntigravityAcpLoginInput;

const AUTH_SPECS: Record<HarnessCliAuthBackendId, AuthSpec> = {
  "cursor-acp": {
    backendId: "cursor-acp",
    harnessCliId: "cursor",
    loginArgs: ["login"],
    logoutArgs: ["logout"],
    statusArgs: ["status"],
    credentialRelPaths: [
      [".cursor", "cli-config.json"],
      [".cursor", "auth.json"],
      [".config", "cursor", "auth.json"],
    ],
    loginCommand: "agent login",
    logoutCommand: "agent logout",
  },
  "grok-build": {
    backendId: "grok-build",
    harnessCliId: "grok",
    loginArgs: ["login", "--device-auth"],
    logoutArgs: ["logout"],
    credentialRelPaths: [[".grok", "auth.json"], [".grok", "credentials.json"]],
    loginCommand: "grok login --device-auth",
    logoutCommand: "grok logout",
  },
  "opencode-server": {
    backendId: "opencode-server",
    harnessCliId: "opencode",
    loginArgs: ["auth", "login"],
    logoutArgs: ["auth", "logout"],
    statusArgs: ["auth", "list"],
    credentialRelPaths: [
      [".local", "share", "opencode", "auth.json"],
      [".opencode", "auth.json"],
    ],
    loginCommand: "opencode auth login",
    logoutCommand: "opencode auth logout",
  },
  "devin-acp": {
    backendId: "devin-acp",
    harnessCliId: "devin",
    loginArgs: ["auth", "login"],
    logoutArgs: ["auth", "logout"],
    statusArgs: ["auth", "status"],
    credentialRelPaths: [[".devin", "auth.json"], [".config", "devin", "auth.json"]],
    loginCommand: "devin auth login",
    logoutCommand: "devin auth logout",
  },
  "codex-app-server": {
    backendId: "codex-app-server",
    harnessCliId: "codex",
    loginArgs: ["login"],
    logoutArgs: ["logout"],
    credentialRelPaths: [[".codex", "auth.json"], [".codex", "config.toml"]],
    loginCommand: "codex login",
    logoutCommand: "codex logout",
  },
  "codex-acp": {
    backendId: "codex-acp",
    harnessCliId: "codex",
    loginArgs: ["login"],
    logoutArgs: ["logout"],
    credentialRelPaths: [[".codex", "auth.json"], [".codex", "config.toml"]],
    loginCommand: "codex login",
    logoutCommand: "codex logout",
  },
  "claude-code-sdk": {
    backendId: "claude-code-sdk",
    harnessCliId: "claude",
    loginArgs: ["auth", "login"],
    logoutArgs: ["auth", "logout"],
    statusArgs: ["auth", "status"],
    credentialRelPaths: [[".claude", ".credentials.json"], [".claude", "auth.json"]],
    loginCommand: "claude auth login",
    logoutCommand: "claude auth logout",
  },
  "google-antigravity-cli": {
    backendId: "google-antigravity-cli",
    harnessCliId: "google-antigravity",
    loginArgs: ["auth", "login"],
    logoutArgs: ["auth", "logout"],
    credentialRelPaths: [
      [".agents", "auth.json"],
      [".antigravity", "auth.json"],
      [".config", "antigravity", "auth.json"],
    ],
    loginCommand: "agy auth login",
    logoutCommand: "agy auth logout",
  },
  "google-antigravity-acp": {
    backendId: "google-antigravity-acp",
    harnessCliId: "google-antigravity-acp",
    mode: "acp",
    loginArgs: [],
    logoutArgs: [],
    credentialRelPaths: antigravityAcpCredentialRelPaths(),
    loginCommand: "agy_acp_server -> authenticate (Log in with Google)",
    logoutCommand: "agy_acp_server -> logout",
  },
};

const OUTPUT_TAIL_LIMIT = 2_000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const STATUS_TIMEOUT_MS = 8_000;
const LOGOUT_TIMEOUT_MS = 20_000;

const activeByBackend = new Map<HarnessCliAuthBackendId, ChildProcessWithoutNullStreams>();
const stateByBackend = new Map<HarnessCliAuthBackendId, HarnessCliAuthState>();

export function isHarnessCliAuthBackendId(
  value: string
): value is HarnessCliAuthBackendId {
  return value in AUTH_SPECS;
}

export function harnessCliAuthBackendIds(): HarnessCliAuthBackendId[] {
  return Object.keys(AUTH_SPECS) as HarnessCliAuthBackendId[];
}

/**
 * Deduped union of home-relative credential paths for every backend that
 * authenticates through the given harness CLI (e.g. `codex-app-server` and
 * `codex-acp` both ride `~/.codex`). This is the write allowlist for
 * harness auth sync imports - nothing outside these paths is ever touched.
 */
export function harnessCliCredentialRelPaths(cliId: HarnessCliId): string[][] {
  const out: string[][] = [];
  const seen = new Set<string>();
  for (const spec of Object.values(AUTH_SPECS)) {
    if (spec.harnessCliId !== cliId) {
      continue;
    }
    for (const segments of spec.credentialRelPaths) {
      const key = segments.join("/");
      if (!seen.has(key)) {
        seen.add(key);
        out.push([...segments]);
      }
    }
  }
  return out;
}

/** Backend ids whose auth state should refresh after a credential import. */
export function harnessCliAuthBackendIdsForCli(
  cliId: HarnessCliId
): HarnessCliAuthBackendId[] {
  return (Object.values(AUTH_SPECS) as AuthSpec[])
    .filter((spec) => spec.harnessCliId === cliId)
    .map((spec) => spec.backendId);
}

/** Strip ANSI escapes so URL/code extraction works on styled CLI output. */
export function stripHarnessAuthAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/**
 * Extract the verification URL and user code from device-auth CLI output.
 * Tolerant of format changes: first URL wins; the code is either labeled
 * ("code: XXXX") or a standalone dash/space-grouped uppercase token.
 */
export function parseHarnessDeviceAuthOutput(raw: string): {
  verificationUrl?: string;
  userCode?: string;
} {
  const text = stripHarnessAuthAnsi(raw);
  const urlMatch = /https?:\/\/[^\s"'<>)\]]+/i.exec(text);
  const labeled = /code[^\S\r\n]*[:=][^\S\r\n]*([A-Z0-9]{4,}(?:-[A-Z0-9]{3,})*)/i.exec(text);
  const grouped = /\b([A-Z0-9]{4,8}(?:-[A-Z0-9]{3,8})+)\b/.exec(text);
  const userCode = labeled?.[1] ?? grouped?.[1];
  return {
    verificationUrl: urlMatch?.[0],
    userCode: userCode?.toUpperCase(),
  };
}

function emptyState(spec: AuthSpec, installed: boolean): HarnessCliAuthState {
  return {
    backendId: spec.backendId,
    installed,
    signedIn: installed ? detectCredentialFiles(spec) : false,
    status: "idle",
    loginCommand: spec.loginCommand,
    logoutCommand: spec.logoutCommand,
  };
}

function detectCredentialFiles(spec: AuthSpec): boolean | null {
  for (const home of harnessHomeDirCandidates()) {
    for (const segments of spec.credentialRelPaths) {
      const candidate = path.join(home, ...segments);
      try {
        if (existsSync(candidate)) {
          return true;
        }
      } catch {
        // unreadable path
      }
    }
  }
  void os;
  return null;
}

function isInstalled(spec: AuthSpec): boolean {
  return detectHarnessCli(spec.harnessCliId) != null;
}

function acpAuthMethodInfos(): HarnessCliAuthMethodInfo[] {
  return ANTIGRAVITY_ACP_AUTH_METHODS.map((method) => ({
    id: method.id,
    name: method.name,
    description: method.description,
    requiresGcp: method.requiresGcp,
    browserLogin: method.browserLogin,
    apiKeyEnvVar: method.apiKeyEnvVar,
  }));
}

/**
 * State for the ACP-driven spec: login progress comes from the in-memory
 * auth flow, the sign-in verdict from the server's settings/credential dir.
 */
function acpAuthState(
  spec: AuthSpec,
  signIn: Awaited<ReturnType<typeof describeAntigravityAcpSignIn>> | null
): HarnessCliAuthState {
  const login = getAntigravityAcpLoginState();
  const installed = isInstalled(spec);
  const status: HarnessCliAuthStatus = login.status;
  return {
    backendId: spec.backendId,
    installed,
    signedIn: installed
      ? signIn
        ? signIn.signedIn
        : login.status === "success"
          ? true
          : detectCredentialFiles(spec)
      : false,
    status,
    verificationUrl: login.verificationUrl,
    outputTail: login.outputTail,
    error: login.error,
    startedAt: login.startedAt,
    finishedAt: login.finishedAt,
    loginCommand: spec.loginCommand,
    logoutCommand: spec.logoutCommand,
    authMethods: acpAuthMethodInfos(),
    // The method recorded on disk is what sessions actually use; an in-flight
    // login only becomes "current" once it succeeds and the server records it.
    authMethodId: signIn?.configuredAuthType ?? login.methodId ?? null,
    callbackPort: login.callbackPort,
    callbackRelayed: login.callbackRelayed,
    apiKeyAvailable: signIn?.apiKeyAvailable,
    gcpConfigured: signIn?.gcpConfigured,
    stateHome: signIn?.geminiHome,
  };
}

export function getHarnessCliAuthState(
  backendId: HarnessCliAuthBackendId
): HarnessCliAuthState {
  const spec = AUTH_SPECS[backendId];
  if (spec.mode === "acp") {
    return acpAuthState(spec, null);
  }
  const current = stateByBackend.get(backendId);
  const installed = isInstalled(spec);
  if (!current) {
    const next = emptyState(spec, installed);
    stateByBackend.set(backendId, next);
    return { ...next };
  }
  return {
    ...current,
    installed,
    signedIn:
      current.status === "success"
        ? true
        : current.signedIn ?? detectCredentialFiles(spec),
  };
}

async function probeStatusCommand(spec: AuthSpec): Promise<boolean | null> {
  if (!spec.statusArgs) {
    return detectCredentialFiles(spec);
  }
  const invocation = buildHarnessInvocation(spec.harnessCliId, spec.statusArgs);
  if (!invocation) {
    return detectCredentialFiles(spec);
  }
  return await new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args ?? [], {
      env: { ...spawnSafeEnv(), ...(invocation.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(detectCredentialFiles(spec));
    }, STATUS_TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(true);
        return;
      }
      const files = detectCredentialFiles(spec);
      resolve(files);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(detectCredentialFiles(spec));
    });
  });
}

export async function refreshHarnessCliAuthState(
  backendId: HarnessCliAuthBackendId
): Promise<HarnessCliAuthState> {
  const spec = AUTH_SPECS[backendId];
  if (spec.mode === "acp") {
    const signIn = isInstalled(spec) ? await describeAntigravityAcpSignIn() : null;
    return acpAuthState(spec, signIn);
  }
  const current = getHarnessCliAuthState(backendId);
  if (current.status === "pending" || current.status === "awaiting-confirmation") {
    return current;
  }
  const installed = isInstalled(spec);
  const signedIn = installed ? await probeStatusCommand(spec) : false;
  const next: HarnessCliAuthState = {
    ...current,
    installed,
    signedIn,
    status: current.status === "failed" ? current.status : "idle",
  };
  stateByBackend.set(backendId, next);
  return { ...next };
}

export async function startHarnessCliLogin(
  backendId: HarnessCliAuthBackendId,
  options: HarnessCliLoginOptions = {}
): Promise<HarnessCliAuthState> {
  const spec = AUTH_SPECS[backendId];
  if (spec.mode === "acp") {
    await startAntigravityAcpLogin(options);
    return refreshHarnessCliAuthState(backendId);
  }
  if (activeByBackend.get(backendId)) {
    return getHarnessCliAuthState(backendId);
  }
  const invocation = buildHarnessInvocation(spec.harnessCliId, spec.loginArgs);
  if (!invocation) {
    const failed: HarnessCliAuthState = {
      ...emptyState(spec, false),
      status: "failed",
      error: `${spec.loginCommand} is unavailable. Install the CLI on the server host, then retry.`,
      finishedAt: Date.now(),
    };
    stateByBackend.set(backendId, failed);
    return { ...failed };
  }

  const pending: HarnessCliAuthState = {
    ...emptyState(spec, true),
    status: "pending",
    startedAt: Date.now(),
    outputTail: "",
  };
  stateByBackend.set(backendId, pending);

  const child = spawn(invocation.command, invocation.args ?? [], {
    env: { ...spawnSafeEnv(), ...(invocation.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  activeByBackend.set(backendId, child);

  let buffered = "";
  const onOutput = (chunk: Buffer) => {
    buffered = `${buffered}${chunk.toString("utf8")}`.slice(-OUTPUT_TAIL_LIMIT * 4);
    const parsed = parseHarnessDeviceAuthOutput(buffered);
    const prev = stateByBackend.get(backendId) ?? pending;
    stateByBackend.set(backendId, {
      ...prev,
      status:
        parsed.verificationUrl || parsed.userCode ? "awaiting-confirmation" : prev.status,
      verificationUrl: parsed.verificationUrl ?? prev.verificationUrl,
      userCode: parsed.userCode ?? prev.userCode,
      outputTail: stripHarnessAuthAnsi(buffered).slice(-OUTPUT_TAIL_LIMIT),
    });
  };
  child.stdout.on("data", onOutput);
  child.stderr.on("data", onOutput);

  const timer = setTimeout(() => {
    if (activeByBackend.get(backendId) === child) {
      child.kill("SIGTERM");
    }
  }, LOGIN_TIMEOUT_MS);

  child.on("exit", (code) => {
    clearTimeout(timer);
    if (activeByBackend.get(backendId) === child) {
      activeByBackend.delete(backendId);
    }
    const prev = stateByBackend.get(backendId) ?? pending;
    stateByBackend.set(backendId, {
      ...prev,
      status: code === 0 ? "success" : "failed",
      signedIn: code === 0 ? true : prev.signedIn,
      error:
        code === 0
          ? undefined
          : prev.error ??
            `${spec.loginCommand} exited with code ${code ?? "unknown"}. ${
              prev.outputTail?.split("\n").slice(-3).join(" ").trim() ?? ""
            }`.trim(),
      finishedAt: Date.now(),
    });
  });
  child.on("error", (error) => {
    clearTimeout(timer);
    if (activeByBackend.get(backendId) === child) {
      activeByBackend.delete(backendId);
    }
    const prev = stateByBackend.get(backendId) ?? pending;
    stateByBackend.set(backendId, {
      ...prev,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      finishedAt: Date.now(),
    });
  });

  const deadline = Date.now() + 8_000;
  while (
    Date.now() < deadline &&
    (stateByBackend.get(backendId)?.status ?? "pending") === "pending" &&
    activeByBackend.get(backendId) === child
  ) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return getHarnessCliAuthState(backendId);
}

export function cancelHarnessCliLogin(
  backendId: HarnessCliAuthBackendId
): HarnessCliAuthState {
  const spec = AUTH_SPECS[backendId];
  if (spec.mode === "acp") {
    cancelAntigravityAcpLogin();
    return getHarnessCliAuthState(backendId);
  }
  const child = activeByBackend.get(backendId);
  if (child) {
    child.kill("SIGTERM");
    activeByBackend.delete(backendId);
    const prev = getHarnessCliAuthState(backendId);
    const next: HarnessCliAuthState = {
      ...prev,
      status: "failed",
      error: "Login cancelled.",
      finishedAt: Date.now(),
    };
    stateByBackend.set(backendId, next);
    return { ...next };
  }
  return getHarnessCliAuthState(backendId);
}

/**
 * ACP-driven auth only: forward a pasted OAuth redirect URL to the server's
 * loopback listener on this host (remote-browser fallback).
 */
export async function relayHarnessCliOAuthCallback(
  backendId: HarnessCliAuthBackendId,
  pastedUrl: string
): Promise<HarnessCliAuthState> {
  const spec = AUTH_SPECS[backendId];
  if (spec.mode !== "acp") {
    throw new Error(`${spec.loginCommand} does not use a loopback OAuth callback.`);
  }
  await relayAntigravityAcpOAuthCallback(pastedUrl);
  return refreshHarnessCliAuthState(backendId);
}

export async function startHarnessCliLogout(
  backendId: HarnessCliAuthBackendId
): Promise<HarnessCliAuthState> {
  const spec = AUTH_SPECS[backendId];
  if (spec.mode === "acp") {
    await logoutAntigravityAcp();
    return refreshHarnessCliAuthState(backendId);
  }
  cancelHarnessCliLogin(backendId);
  const invocation = buildHarnessInvocation(spec.harnessCliId, spec.logoutArgs);
  if (!invocation) {
    const failed: HarnessCliAuthState = {
      ...getHarnessCliAuthState(backendId),
      status: "failed",
      error: `${spec.logoutCommand} is unavailable. Install the CLI on the server host, then retry.`,
      finishedAt: Date.now(),
    };
    stateByBackend.set(backendId, failed);
    return { ...failed };
  }

  const pending: HarnessCliAuthState = {
    ...getHarnessCliAuthState(backendId),
    status: "pending",
    startedAt: Date.now(),
    error: undefined,
    outputTail: "",
  };
  stateByBackend.set(backendId, pending);

  return await new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args ?? [], {
      env: { ...spawnSafeEnv(), ...(invocation.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffered = "";
    const onOutput = (chunk: Buffer) => {
      buffered = `${buffered}${chunk.toString("utf8")}`.slice(-OUTPUT_TAIL_LIMIT);
      const prev = stateByBackend.get(backendId) ?? pending;
      stateByBackend.set(backendId, {
        ...prev,
        outputTail: stripHarnessAuthAnsi(buffered).slice(-OUTPUT_TAIL_LIMIT),
      });
    };
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, LOGOUT_TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      const next: HarnessCliAuthState = {
        ...getHarnessCliAuthState(backendId),
        status: code === 0 ? "idle" : "failed",
        signedIn: code === 0 ? false : getHarnessCliAuthState(backendId).signedIn,
        error:
          code === 0
            ? undefined
            : `${spec.logoutCommand} exited with code ${code ?? "unknown"}.`,
        finishedAt: Date.now(),
      };
      stateByBackend.set(backendId, next);
      resolve({ ...next });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      const next: HarnessCliAuthState = {
        ...getHarnessCliAuthState(backendId),
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        finishedAt: Date.now(),
      };
      stateByBackend.set(backendId, next);
      resolve({ ...next });
    });
  });
}

export function isHarnessCliAuthSupported(backendId: AgentBackendId): boolean {
  return isHarnessCliAuthBackendId(backendId);
}
