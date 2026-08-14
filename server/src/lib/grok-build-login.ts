/**
 * In-app device-auth login for the Grok Build harness.
 *
 * Spawns `grok login --device-auth` on the server host, parses the device
 * code + verification URL from the CLI output, and tracks the login until the
 * CLI exits. Once the CLI caches its token, the Grok Build ACP handshake
 * authenticates with `cached_token` automatically — no manual terminal work.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { buildHarnessInvocation, detectHarnessCli } from "./agents/harness-runtime.js";
import { spawnSafeEnv } from "./agents/spawn-env.js";

export type GrokBuildLoginState = {
  status: "idle" | "pending" | "awaiting-confirmation" | "success" | "failed";
  verificationUrl?: string;
  userCode?: string;
  /** Trailing CLI output for diagnostics (secrets are not printed by the CLI). */
  outputTail?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
};

const OUTPUT_TAIL_LIMIT = 2_000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

let activeProcess: ChildProcessWithoutNullStreams | null = null;
let state: GrokBuildLoginState = { status: "idle" };

/** Strip ANSI escapes so URL/code extraction works on styled CLI output. */
function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/**
 * Extract the verification URL and user code from device-auth CLI output.
 * Tolerant of format changes: first URL wins; the code is either labeled
 * ("code: XXXX") or a standalone dash/space-grouped uppercase token.
 */
export function parseGrokDeviceAuthOutput(raw: string): {
  verificationUrl?: string;
  userCode?: string;
} {
  const text = stripAnsi(raw);
  const urlMatch = /https?:\/\/[^\s"'<>)\]]+/i.exec(text);
  const labeled = /code[^\S\r\n]*[:=][^\S\r\n]*([A-Z0-9]{4,}(?:-[A-Z0-9]{3,})*)/i.exec(text);
  const grouped = /\b([A-Z0-9]{4,8}(?:-[A-Z0-9]{3,8})+)\b/.exec(text);
  const userCode = labeled?.[1] ?? grouped?.[1];
  return {
    verificationUrl: urlMatch?.[0],
    userCode: userCode?.toUpperCase(),
  };
}

export function getGrokBuildLoginState(): GrokBuildLoginState {
  return { ...state };
}

export function isGrokCliInstalled(): boolean {
  return detectHarnessCli("grok") != null;
}

export async function startGrokBuildDeviceLogin(): Promise<GrokBuildLoginState> {
  if (activeProcess) {
    // A login is already running; report its current state instead of racing it.
    return getGrokBuildLoginState();
  }
  const invocation = buildHarnessInvocation("grok", ["login", "--device-auth"]);
  if (!invocation) {
    state = {
      status: "failed",
      error:
        "Grok CLI not found on the server. Install it (https://docs.x.ai/grok-build) or set OPENCURSOR_GROK_BUILD_BIN, then retry. Alternatively set XAI_API_KEY.",
      finishedAt: Date.now(),
    };
    return getGrokBuildLoginState();
  }

  state = { status: "pending", startedAt: Date.now(), outputTail: "" };
  const child = spawn(invocation.command, invocation.args ?? [], {
    env: { ...spawnSafeEnv(), ...(invocation.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  activeProcess = child;

  let buffered = "";
  const onOutput = (chunk: Buffer) => {
    buffered = `${buffered}${chunk.toString("utf8")}`.slice(-OUTPUT_TAIL_LIMIT * 4);
    const parsed = parseGrokDeviceAuthOutput(buffered);
    state = {
      ...state,
      status:
        parsed.verificationUrl || parsed.userCode ? "awaiting-confirmation" : state.status,
      verificationUrl: parsed.verificationUrl ?? state.verificationUrl,
      userCode: parsed.userCode ?? state.userCode,
      outputTail: stripAnsi(buffered).slice(-OUTPUT_TAIL_LIMIT),
    };
  };
  child.stdout.on("data", onOutput);
  child.stderr.on("data", onOutput);

  const timer = setTimeout(() => {
    if (activeProcess === child) {
      child.kill("SIGTERM");
    }
  }, LOGIN_TIMEOUT_MS);

  child.on("exit", (code) => {
    clearTimeout(timer);
    if (activeProcess === child) {
      activeProcess = null;
    }
    state = {
      ...state,
      status: code === 0 ? "success" : "failed",
      error:
        code === 0
          ? undefined
          : state.error ??
            `grok login exited with code ${code ?? "unknown"}. ${state.outputTail?.split("\n").slice(-3).join(" ").trim() ?? ""}`.trim(),
      finishedAt: Date.now(),
    };
  });
  child.on("error", (error) => {
    clearTimeout(timer);
    if (activeProcess === child) {
      activeProcess = null;
    }
    state = {
      ...state,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      finishedAt: Date.now(),
    };
  });

  // Give the CLI a moment to print the device code before responding.
  const deadline = Date.now() + 8_000;
  while (
    Date.now() < deadline &&
    state.status === "pending" &&
    activeProcess === child
  ) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return getGrokBuildLoginState();
}

export function cancelGrokBuildDeviceLogin(): GrokBuildLoginState {
  if (activeProcess) {
    activeProcess.kill("SIGTERM");
    activeProcess = null;
    state = {
      ...state,
      status: "failed",
      error: "Login cancelled.",
      finishedAt: Date.now(),
    };
  }
  return getGrokBuildLoginState();
}
