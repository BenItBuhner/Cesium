import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type CliRuntimeSpec } from "./cli-adapter.js";
import { AGENT_CAPABILITIES } from "./agent-contract.js";
import { getCursorSdkCredentialStatus } from "../cursor-sdk-credentials.js";
import { getCesiumCredentialStatus } from "../cesium-agent-settings.js";
import {
  describePiAgentAuthStatus,
  hasPiAgentStoredAuthConfig,
} from "../pi-agent-settings.js";
import { readAgentBackendConfigCache } from "./provider-cache-store.js";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConversationMode,
  AgentProvider,
  AgentProviderCapabilities,
} from "./types.js";
import {
  describeClaudeCodeSdkAuthStatus,
  getClaudeCodeSdkProxyModel,
  getClaudeCodeSdkProxyModelName,
  hasClaudeCodeSdkAuthConfig,
  hasClaudeCodeSdkProxyConfig,
} from "../claude-code-sdk-credentials.js";
import { AcpSessionHandle } from "./acp/acp-session.js";

type AcpRuntimeSpec = CliRuntimeSpec;

/**
 * Gemini CLI ACP invocation: default `gemini --acp` (see Gemini CLI ACP docs).
 * Override with JSON array if your build uses different flags, e.g. `["--experimental-acp"]`.
 */
function parseGeminiCliAcpArgs(): string[] {
  const rawJson = process.env.OPENCURSOR_GEMINI_CLI_ARGS?.trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return parsed;
      }
    } catch {
      // ignore invalid JSON
    }
  }
  return ["--acp"];
}

/**
 * Devin CLI ACP invocation: default `devin acp` (see https://docs.devin.ai/cli/acp/jetbrains).
 * Override with JSON array if your build uses different flags.
 */
function parseDevinCliAcpArgs(): string[] {
  const rawJson = process.env.OPENCURSOR_DEVIN_CLI_ARGS?.trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return parsed;
      }
    } catch {
      // ignore invalid JSON
    }
  }
  return ["acp"];
}

function fileExists(filePath: string): boolean {
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}

function quotePreview(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

function quoteCmdArg(value: string): string {
  if (value.length === 0) {
    return '""';
  }
  return /[\s"]/u.test(value)
    ? `"${value.replace(/"/g, '\\"')}"`
    : value;
}

function buildInvocation(
  executablePath: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): AcpRuntimeSpec {
  const ext = path.extname(executablePath).toLowerCase();
  if (process.platform === "win32" && (ext === ".cmd" || ext === ".bat")) {
    const comspec =
      process.env.ComSpec ??
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    const commandLine = [quoteCmdArg(executablePath), ...args.map(quoteCmdArg)].join(" ");
    return {
      command: comspec,
      args: ["/d", "/s", "/c", commandLine],
      env,
      commandPreview: [quotePreview(executablePath), ...args.map(quotePreview)].join(" "),
    };
  }

  if (process.platform === "win32" && ext === ".ps1") {
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
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", executablePath, ...args],
      env,
      commandPreview: [quotePreview(executablePath), ...args.map(quotePreview)].join(" "),
    };
  }

  return {
    command: executablePath,
    args,
    env,
    commandPreview: [quotePreview(executablePath), ...args.map(quotePreview)].join(" "),
  };
}

function findExecutableOnPath(names: string[]): string | null {
  const rawPath = process.env.PATH ?? "";
  const directories = rawPath
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (fileExists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function resolveConfiguredRuntime(
  configured: string | undefined,
  args: string[],
  env?: NodeJS.ProcessEnv
): AcpRuntimeSpec | null {
  const trimmed = configured?.trim();
  if (!trimmed) {
    return null;
  }
  const direct =
    trimmed.includes("\\") ||
    trimmed.includes("/") ||
    /^[a-zA-Z]:/.test(trimmed)
      ? trimmed
      : findExecutableOnPath(
          process.platform === "win32"
            ? [trimmed, `${trimmed}.exe`, `${trimmed}.cmd`, `${trimmed}.bat`, `${trimmed}.ps1`]
            : [trimmed]
        );
  if (!direct) {
    return null;
  }
  return buildInvocation(direct, args, env);
}

function openCodeHomeDirCandidates(): string[] {
  const raw = process.env.OPENCURSOR_REAL_HOME?.trim();
  const out: string[] = [];
  const push = (value: string | undefined) => {
    const t = value?.trim();
    if (t && !out.includes(t)) {
      out.push(t);
    }
  };
  push(raw || undefined);
  if (process.env.USER?.trim()) {
    push(`/home/${process.env.USER!.trim()}`);
  }
  push(os.homedir());
  return out;
}

function resolveOpenCodeBundledBinary(): string | null {
  const names =
    process.platform === "win32"
      ? ["opencode.exe", "opencode.cmd", "opencode.bat", "opencode"]
      : ["opencode"];
  for (const home of openCodeHomeDirCandidates()) {
    for (const name of names) {
      const candidate = path.join(home, ".opencode", "bin", name);
      if (fileExists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function resolveGeminiAcpRuntime(): AcpRuntimeSpec | null {
  const acpArgs = parseGeminiCliAcpArgs();
  const configured = resolveConfiguredRuntime(process.env.OPENCURSOR_GEMINI_CLI_BIN, acpArgs);
  if (configured) {
    return configured;
  }

  const pathHit = findExecutableOnPath(
    process.platform === "win32"
      ? ["gemini.exe", "gemini.cmd", "gemini.bat", "gemini"]
      : ["gemini"]
  );
  if (pathHit) {
    return buildInvocation(pathHit, acpArgs);
  }

  if (process.platform === "win32") {
    const roamingNpm = process.env.APPDATA?.trim()
      ? path.join(process.env.APPDATA, "npm", "gemini.cmd")
      : null;
    if (roamingNpm && fileExists(roamingNpm)) {
      return buildInvocation(roamingNpm, acpArgs);
    }
  }

  return null;
}

function resolveDevinLocalBin(): string | null {
  const names =
    process.platform === "win32"
      ? ["devin.exe", "devin.cmd", "devin.bat", "devin"]
      : ["devin"];
  for (const home of openCodeHomeDirCandidates()) {
    for (const name of names) {
      const candidate = path.join(home, ".local", "bin", name);
      if (fileExists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function resolveDevinAcpRuntime(): AcpRuntimeSpec | null {
  const acpArgs = parseDevinCliAcpArgs();
  const configured = resolveConfiguredRuntime(process.env.OPENCURSOR_DEVIN_CLI_BIN, acpArgs);
  if (configured) {
    return configured;
  }

  const pathHit = findExecutableOnPath(
    process.platform === "win32"
      ? ["devin.exe", "devin.cmd", "devin.bat", "devin"]
      : ["devin"]
  );
  if (pathHit) {
    return buildInvocation(pathHit, acpArgs);
  }

  const localBin = resolveDevinLocalBin();
  if (localBin) {
    return buildInvocation(localBin, acpArgs);
  }

  if (process.platform === "win32") {
    const roamingNpm = process.env.APPDATA?.trim()
      ? path.join(process.env.APPDATA, "npm", "devin.cmd")
      : null;
    if (roamingNpm && fileExists(roamingNpm)) {
      return buildInvocation(roamingNpm, acpArgs);
    }
  }

  return null;
}

function resolveOpenCodeCliRuntime(): CliRuntimeSpec | null {
  const configured = resolveConfiguredRuntime(
    process.env.OPENCURSOR_OPENCODE_SERVER_BIN?.trim() ||
      process.env.OPENCURSOR_OPENCODE_ACP_BIN?.trim(),
    []
  );
  if (configured) {
    return configured;
  }

  const pathHit = findExecutableOnPath(
    process.platform === "win32"
      ? ["opencode.exe", "opencode.cmd", "opencode.bat", "opencode"]
      : ["opencode"]
  );
  if (pathHit) {
    return buildInvocation(pathHit, []);
  }

  const bundled = resolveOpenCodeBundledBinary();
  if (bundled) {
    return buildInvocation(bundled, []);
  }

  if (process.platform === "win32") {
    const roamingNpm = process.env.APPDATA?.trim()
      ? path.join(process.env.APPDATA, "npm", "opencode.cmd")
      : null;
    if (roamingNpm && fileExists(roamingNpm)) {
      return buildInvocation(roamingNpm, []);
    }
  }

  return null;
}

function resolveCodexCliRuntime(): CliRuntimeSpec | null {
  const configured = resolveConfiguredRuntime(process.env.OPENCURSOR_CODEX_BIN, []);
  if (configured) {
    return configured;
  }

  const pathHit = findExecutableOnPath(
    process.platform === "win32"
      ? ["codex.exe", "codex.cmd", "codex.bat", "codex"]
      : ["codex"]
  );
  return pathHit ? buildInvocation(pathHit, []) : null;
}

function resolveGoogleAntigravityCliRuntime(): CliRuntimeSpec | null {
  const configured = resolveConfiguredRuntime(
    process.env.OPENCURSOR_ANTIGRAVITY_CLI_BIN ?? process.env.OPENCURSOR_AGY_BIN,
    []
  );
  if (configured) {
    return configured;
  }

  const pathHit = findExecutableOnPath(
    process.platform === "win32"
      ? ["agy.exe", "agy.cmd", "agy.bat", "agy"]
      : ["agy"]
  );
  if (pathHit) {
    return buildInvocation(pathHit, []);
  }

  if (process.platform === "win32") {
    const roamingNpm = process.env.APPDATA?.trim()
      ? path.join(process.env.APPDATA, "npm", "agy.cmd")
      : null;
    if (roamingNpm && fileExists(roamingNpm)) {
      return buildInvocation(roamingNpm, []);
    }
  }

  return null;
}

const OPENCODE_RUNTIME = resolveOpenCodeCliRuntime();
const GEMINI_RUNTIME = resolveGeminiAcpRuntime();
const DEVIN_RUNTIME = resolveDevinAcpRuntime();
const CODEX_RUNTIME = resolveCodexCliRuntime();
const GOOGLE_ANTIGRAVITY_RUNTIME = resolveGoogleAntigravityCliRuntime();

function createBackendInfo(input: {
  id: AgentBackendId;
  label: string;
  description: string;
  commandPreview?: string;
  experimental?: boolean;
  available?: boolean;
  capabilities: AgentProviderCapabilities;
  defaultMode?: AgentConversationMode;
  defaultModelId?: string;
  defaultModelName?: string;
}): AgentBackendInfo {
  return {
    id: input.id,
    label: input.label,
    description: input.description,
    commandPreview: input.commandPreview,
    experimental: input.experimental ?? false,
    available: input.available ?? true,
    capabilities: input.capabilities,
    defaultMode: input.defaultMode ?? "agent",
    defaultModelId: input.defaultModelId ?? "auto",
    defaultModelName: input.defaultModelName ?? "Auto",
  };
}

export const AGENT_BACKENDS: Record<AgentBackendId, AgentBackendInfo> = {
  "cesium-agent": createBackendInfo({
    id: "cesium-agent",
    label: "Cesium Agent (Beta)",
    description: "First-party Cesium harness with direct provider APIs, tools, subagents, and compression.",
    experimental: true,
    commandPreview: "Cesium first-party runtime",
    available: true,
    capabilities: AGENT_CAPABILITIES["cesium-agent"],
    defaultMode: "agent",
    defaultModelId: "openai/gpt-5.1",
    defaultModelName: "OpenAI/GPT-5.1",
  }),
  "cursor-sdk": createBackendInfo({
    id: "cursor-sdk",
    label: "Cursor SDK",
    description: "Cursor TypeScript SDK local agent runtime with OpenCursor MCP settings bridged in memory.",
    experimental: true,
    commandPreview: "@cursor/sdk local agent · API key via Settings → Agents",
    available: true,
    capabilities: AGENT_CAPABILITIES["cursor-sdk"],
    defaultMode: "agent",
    defaultModelId: "composer-2.5",
    defaultModelName: "Composer 2.5",
  }),
  "opencode-server": createBackendInfo({
    id: "opencode-server",
    label: "OpenCode Server",
    description: "OpenCode native HTTP/SSE server API with root and child-session event routing.",
    experimental: true,
    commandPreview: process.env.OPENCURSOR_OPENCODE_SERVER_URL?.trim()
      ? `OpenCode server at ${process.env.OPENCURSOR_OPENCODE_SERVER_URL.trim()}`
      : OPENCODE_RUNTIME
        ? `${OPENCODE_RUNTIME.commandPreview} serve`
        : "OpenCode server not configured",
    available: Boolean(process.env.OPENCURSOR_OPENCODE_SERVER_URL?.trim()) || OPENCODE_RUNTIME !== null,
    capabilities: AGENT_CAPABILITIES["opencode-server"],
    defaultMode: "build",
    defaultModelId: "auto",
    defaultModelName: "Auto",
  }),
  "gemini-acp": createBackendInfo({
    id: "gemini-acp",
    label: "Gemini",
    description: "Gemini CLI over ACP stdio (`gemini --acp`).",
    commandPreview: GEMINI_RUNTIME?.commandPreview ?? "Gemini CLI not found",
    available: GEMINI_RUNTIME !== null,
    capabilities: AGENT_CAPABILITIES["gemini-acp"],
    defaultMode: "agent",
    defaultModelId: "auto",
    defaultModelName: "Auto",
  }),
  "devin-acp": createBackendInfo({
    id: "devin-acp",
    label: "Devin",
    description:
      "Cognition Devin CLI over ACP stdio (`devin acp`). Uses ambient `devin auth login` credentials or `WINDSURF_API_KEY`.",
    experimental: true,
    commandPreview: DEVIN_RUNTIME?.commandPreview ?? "Devin CLI not found",
    available: DEVIN_RUNTIME !== null,
    capabilities: AGENT_CAPABILITIES["devin-acp"],
    defaultMode: "agent",
    defaultModelId: "auto",
    defaultModelName: "Auto",
  }),
  "codex-app-server": createBackendInfo({
    id: "codex-app-server",
    label: "Codex App Server",
    description: "Official Codex App Server over JSON-RPC stdio with canonical tool and plan-file mirroring.",
    experimental: true,
    commandPreview: CODEX_RUNTIME
      ? `${CODEX_RUNTIME.commandPreview} app-server`
      : "Codex CLI not found",
    available: CODEX_RUNTIME !== null,
    capabilities: AGENT_CAPABILITIES["codex-app-server"],
    defaultMode: "agent",
    defaultModelId: "__default__",
    defaultModelName: "Codex App Server Default",
  }),
  "claude-code-sdk": createBackendInfo({
    id: "claude-code-sdk",
    label: "Claude Code SDK",
    description: "Anthropic Claude Agent SDK with stock Claude Code tools and OpenCursor MCP settings bridged in memory.",
    experimental: true,
    commandPreview: `@anthropic-ai/claude-agent-sdk · ${describeClaudeCodeSdkAuthStatus()}`,
    available: hasClaudeCodeSdkAuthConfig(),
    capabilities: AGENT_CAPABILITIES["claude-code-sdk"],
    defaultMode: "agent",
    defaultModelId: hasClaudeCodeSdkProxyConfig() ? getClaudeCodeSdkProxyModel() : "claude-sonnet-4-5",
    defaultModelName: hasClaudeCodeSdkProxyConfig() ? getClaudeCodeSdkProxyModelName() : "Claude Sonnet 4.5",
  }),
  "pi-agent": createBackendInfo({
    id: "pi-agent",
    label: "Pi Agent",
    description: "Pi coding agent SDK with built-in read, edit, grep, and bash tools.",
    experimental: true,
    commandPreview: `@earendil-works/pi-coding-agent · API key via settings`,
    available: false,
    capabilities: AGENT_CAPABILITIES["pi-agent"],
    defaultMode: "agent",
    defaultModelId: "auto",
    defaultModelName: "Auto",
  }),
  "google-antigravity-cli": createBackendInfo({
    id: "google-antigravity-cli",
    label: "Google Antigravity CLI",
    description:
      "Google Antigravity CLI harness using installed agy, ambient CLI auth, OpenCursor plan/tool rendering, and Antigravity workspace MCP config.",
    experimental: true,
    commandPreview: GOOGLE_ANTIGRAVITY_RUNTIME
      ? `${GOOGLE_ANTIGRAVITY_RUNTIME.commandPreview} interactive`
      : "Antigravity CLI (agy) not found",
    available: GOOGLE_ANTIGRAVITY_RUNTIME !== null,
    capabilities: AGENT_CAPABILITIES["google-antigravity-cli"],
    defaultMode: "agent",
    defaultModelId: "auto",
    defaultModelName: "Auto",
  }),
};

/** Stable ordering for harness/model-picker menus (Cesium first, then Cursor, Codex, OpenCode, Claude, Gemini, Devin). */
const AGENT_BACKEND_MENU_ORDER = [
  "cesium-agent",
  "cursor-sdk",
  "codex-app-server",
  "opencode-server",
  "gemini-acp",
  "devin-acp",
  "claude-code-sdk",
  "pi-agent",
  "google-antigravity-cli",
] as const satisfies readonly AgentBackendId[];

export function listAgentBackends(): AgentBackendInfo[] {
  return AGENT_BACKEND_MENU_ORDER.map((id) => AGENT_BACKENDS[id]);
}

export async function listAgentBackendsWithCache(): Promise<AgentBackendInfo[]> {
  const [cursorSdkStatus, cesiumStatus, piAgentStatus, piAgentAuthStatus] = await Promise.all([
    getCursorSdkCredentialStatus().catch(() => ({
      configured: false,
      source: null,
    })),
    getCesiumCredentialStatus().catch(() => ({
      configured: false,
      providerKeys: [],
    })),
    hasPiAgentStoredAuthConfig().catch(() => false),
    describePiAgentAuthStatus().catch(() => "API key not configured"),
  ]);
  return Promise.all(
    AGENT_BACKEND_MENU_ORDER.map(async (id) => {
      const backend = AGENT_BACKENDS[id];
      const cachedConfigOptions = await readAgentBackendConfigCache(backend.id);
      return {
        ...backend,
        available:
          backend.id === "cesium-agent"
            ? cesiumStatus.configured
            : backend.id === "cursor-sdk"
            ? cursorSdkStatus.configured
            : backend.id === "pi-agent"
            ? piAgentStatus
            : backend.available,
        commandPreview:
          backend.id === "pi-agent"
            ? `@earendil-works/pi-coding-agent · ${piAgentAuthStatus}`
            : backend.commandPreview,
        description:
          backend.id === "cesium-agent" && !cesiumStatus.configured
            ? "Cesium Agent requires at least one OpenAI, Anthropic, Google, or custom provider API key. Open Settings -> Agents to configure it."
            : backend.id === "cursor-sdk" && !cursorSdkStatus.configured
            ? "Cursor SDK requires a Cursor API key. Open Settings -> Agents to configure it."
            : backend.id === "pi-agent" && !piAgentStatus
            ? "Pi Agent requires at least one provider credential (OAuth or API key). Open Settings -> Agents to configure it."
            : backend.description,
        cachedConfigOptions,
      };
    })
  );
}

export async function createAgentProvider(
  backendId: AgentBackendId
): Promise<AgentProvider> {
  const backend = AGENT_BACKENDS[backendId];
  if (!backend) {
    throw new Error(`Unknown backend: ${backendId}`);
  }

  if (backendId === "cursor-sdk") {
    const { createCursorSdkProvider } = await import("./cursor-sdk-provider.js");
    return createCursorSdkProvider({
      backend,
      configOptions: await readAgentBackendConfigCache(backendId),
    });
  }

  if (backendId === "cesium-agent") {
    const { createCesiumAgentProvider } = await import("./cesium-provider.js");
    return createCesiumAgentProvider({
      backend,
      configOptions: await readAgentBackendConfigCache(backendId),
    });
  }

  if (backendId === "opencode-server") {
    if (!process.env.OPENCURSOR_OPENCODE_SERVER_URL?.trim() && !OPENCODE_RUNTIME) {
      throw new Error(`${backend.label} is not installed or configured.`);
    }
    const { createOpenCodeServerProvider } = await import("./opencode-server-provider.js");
    return createOpenCodeServerProvider({
      backend,
      configOptions: await readAgentBackendConfigCache(backendId),
    });
  }

  if (backendId === "gemini-acp") {
    if (!GEMINI_RUNTIME) {
      throw new Error(`${backend.label} is not installed or could not be resolved.`);
    }
    return {
      backend,
      startSession(callbacks) {
        return AcpSessionHandle.create({
          backend,
          command: GEMINI_RUNTIME.command,
          args: GEMINI_RUNTIME.args,
          env: GEMINI_RUNTIME.env,
          callbacks,
        });
      },
      loadSession(callbacks, providerSessionId) {
        return AcpSessionHandle.create({
          backend,
          command: GEMINI_RUNTIME.command,
          args: GEMINI_RUNTIME.args,
          env: GEMINI_RUNTIME.env,
          callbacks,
          loadSessionId: providerSessionId,
        });
      },
    };
  }

  if (backendId === "devin-acp") {
    if (!DEVIN_RUNTIME) {
      throw new Error(`${backend.label} is not installed or could not be resolved.`);
    }
    return {
      backend,
      startSession(callbacks) {
        return AcpSessionHandle.create({
          backend,
          command: DEVIN_RUNTIME.command,
          args: DEVIN_RUNTIME.args,
          env: DEVIN_RUNTIME.env,
          callbacks,
        });
      },
      loadSession(callbacks, providerSessionId) {
        return AcpSessionHandle.create({
          backend,
          command: DEVIN_RUNTIME.command,
          args: DEVIN_RUNTIME.args,
          env: DEVIN_RUNTIME.env,
          callbacks,
          loadSessionId: providerSessionId,
        });
      },
    };
  }

  if (backendId === "codex-app-server") {
    if (!CODEX_RUNTIME) {
      throw new Error(`${backend.label} is not installed or could not be resolved.`);
    }
    const { createCodexAppServerProvider } = await import("./codex-app-server-provider.js");
    return createCodexAppServerProvider({
      backend,
      runtime: CODEX_RUNTIME,
      configOptions: await readAgentBackendConfigCache(backendId),
    });
  }

  if (backendId === "claude-code-sdk") {
    const { createClaudeCodeSdkProvider } = await import("./claude-code-sdk-provider.js");
    return createClaudeCodeSdkProvider({
      backend,
      configOptions: await readAgentBackendConfigCache(backendId),
    });
  }

  if (backendId === "pi-agent") {
    if (!(await hasPiAgentStoredAuthConfig())) {
      throw new Error(`${backend.label} requires a provider API key. Open Settings -> Agents to configure it.`);
    }
    const { createPiAgentProvider } = await import("./pi-agent-provider.js");
    return createPiAgentProvider({
      backend,
      configOptions: await readAgentBackendConfigCache(backendId),
    });
  }

  if (backendId === "google-antigravity-cli") {
    if (!GOOGLE_ANTIGRAVITY_RUNTIME) {
      throw new Error(`${backend.label} requires the agy binary to be installed and available on PATH.`);
    }
    const { createGoogleAntigravityCliProvider } = await import("./google-antigravity-cli-provider.js");
    return createGoogleAntigravityCliProvider({
      backend,
      runtime: GOOGLE_ANTIGRAVITY_RUNTIME,
      configOptions: await readAgentBackendConfigCache(backendId),
    });
  }

  throw new Error(`${backend.label} is not implemented yet.`);
}
