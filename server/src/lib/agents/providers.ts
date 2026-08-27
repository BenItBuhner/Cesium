import { existsSync } from "node:fs";
import path from "node:path";
import { type CliRuntimeSpec } from "./cli-adapter.js";
import {
  ACTIVE_AGENT_BACKEND_IDS,
  isHarnessEnabled,
} from "../active-agent-backends.js";
import {
  harnessFamilyForBackend,
  isHarnessFamilyEnabled,
  resolvePreferredHarnessBackendId,
} from "@cesium/core";
import { getGlobalSettings } from "../global-settings-store.js";
import { AGENT_CAPABILITIES } from "./agent-contract.js";
import { getCursorSdkCredentialStatus } from "../cursor-sdk-credentials.js";
import { getCesiumCredentialStatus } from "../cesium-agent-settings.js";
import {
  describePiAgentAuthStatus,
  hasPiAgentStoredAuthConfig,
} from "../pi-agent-settings.js";
import {
  createGrokBuildModeConfigOption,
  readAgentBackendConfigCache,
} from "./provider-cache-store.js";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentBackendRuntimeInfo,
  AgentConversationMode,
  AgentProvider,
  AgentProviderCapabilities,
} from "./types.js";
import {
  describeClaudeCodeSdkAuthStatus,
  getClaudeCodeSdkProxyModel,
  getClaudeCodeSdkProxyModelName,
  hasClaudeCodeAmbientCliAuth,
  hasClaudeCodeSdkAuthConfig,
  hasClaudeCodeSdkProxyConfig,
} from "../claude-code-sdk-credentials.js";
import { AcpSessionHandle } from "./acp/acp-session.js";
import {
  buildCliInvocation,
  buildHarnessInvocation,
  detectHarnessCli,
  harnessDefaultArgs,
  probeHarnessCliVersion,
  resolveHarnessRuntimeSpec,
  type HarnessCliId,
} from "./harness-runtime.js";
import {
  openCodeHarnessAvailable,
  openCodeHarnessCommandPreview,
} from "./opencode-generation.js";

/**
 * Maps CLI-backed agent backends onto the harness runtime descriptor that
 * discovers their executable. SDK/credential backends have no CLI to detect.
 */
const BACKEND_HARNESS_CLI: Partial<Record<AgentBackendId, HarnessCliId>> = {
  "opencode-server": "opencode",
  "opencode-v2-beta": "opencode-v2",
  "devin-acp": "devin",
  "grok-build": "grok",
  "codex-app-server": "codex",
  "codex-acp": "codex",
  "google-antigravity-cli": "google-antigravity",
  "claude-code-sdk": "claude",
  "cursor-acp": "cursor",
};

function parseCursorAgentExtraArgs(): string[] {
  const rawJson = process.env.OPENCURSOR_CURSOR_AGENT_ARGS?.trim();
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
  const permissionMode = process.env.OPENCURSOR_CURSOR_PERMISSION_MODE?.trim();
  if (permissionMode) {
    return ["--permission-mode", permissionMode];
  }
  return [];
}

function parseCodexAcpExtraArgs(): string[] {
  const rawJson = process.env.OPENCURSOR_CODEX_ACP_ARGS?.trim();
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
  return [];
}

function resolveCodexAcpRuntime(): CliRuntimeSpec | null {
  const extra = parseCodexAcpExtraArgs();
  return buildHarnessInvocation("codex", [...extra, "acp"]);
}

function resolveCursorAcpRuntime(): CliRuntimeSpec | null {
  const detection = detectHarnessCli("cursor");
  if (!detection) {
    if (process.platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA?.trim();
      const cursorAgentScript = localAppData
        ? path.join(localAppData, "cursor-agent", "agent.ps1")
        : null;
      if (cursorAgentScript && existsSync(cursorAgentScript)) {
        return buildCliInvocation(
          cursorAgentScript,
          [...parseCursorAgentExtraArgs(), ...harnessDefaultArgs("cursor")],
          {
            CURSOR_INVOKED_AS: process.env.CURSOR_INVOKED_AS || "agent.cmd",
          }
        );
      }
    }
    return null;
  }
  return buildCliInvocation(
    detection.executablePath,
    [...parseCursorAgentExtraArgs(), ...harnessDefaultArgs("cursor")],
    {
      CURSOR_INVOKED_AS: process.env.CURSOR_INVOKED_AS || "agent.cmd",
    }
  );
}

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

/**
 * Builds a backend's info from *live* CLI detection. Called on every access
 * of `AGENT_BACKENDS[...]` / `listAgentBackends()`, so availability follows
 * installs and uninstalls without a server restart (detection is TTL-cached
 * in `harness-runtime.ts`, so repeated access stays cheap).
 */
function computeBackendInfo(id: AgentBackendId): AgentBackendInfo {
  switch (id) {
    case "cesium-agent":
      return createBackendInfo({
        id: "cesium-agent",
        label: "Cesium Agent (Beta)",
        description:
          "First-party Cesium harness with direct provider APIs, tools, subagents, and compression.",
        experimental: true,
        commandPreview: "Cesium first-party runtime",
        available: true,
        capabilities: AGENT_CAPABILITIES["cesium-agent"],
        defaultMode: "agent",
        defaultModelId: "openai/gpt-5.1",
        defaultModelName: "OpenAI/GPT-5.1",
      });
    case "cursor-sdk":
      return createBackendInfo({
        id: "cursor-sdk",
        label: "Cursor",
        description:
          "Cursor TypeScript SDK local agent runtime with OpenCursor MCP settings bridged in memory.",
        experimental: true,
        commandPreview: "@cursor/sdk local agent · API key via Settings → Agents",
        available: true,
        capabilities: AGENT_CAPABILITIES["cursor-sdk"],
        defaultMode: "agent",
        defaultModelId: "composer-2.5",
        defaultModelName: "Composer 2.5",
      });
    case "cursor-acp": {
      const runtime = resolveCursorAcpRuntime();
      return createBackendInfo({
        id: "cursor-acp",
        label: "Cursor",
        description:
          "Cursor Agent CLI over ACP (`agent acp`). Supports CLI OAuth (`agent login`) that the TypeScript SDK does not expose.",
        experimental: true,
        commandPreview: runtime?.commandPreview ?? "Cursor Agent CLI not found",
        available: runtime !== null,
        capabilities: AGENT_CAPABILITIES["cursor-acp"],
        defaultMode: "agent",
        defaultModelId: "auto",
        defaultModelName: "Auto",
      });
    }
    case "opencode-server":
    case "opencode-v2-beta": {
      return createBackendInfo({
        id,
        label: "OpenCode",
        description:
          "OpenCode native HTTP/SSE harness. Current talks to OpenCode 1; v2 Beta is packaged in the same option for durable logs, background subagents, PTY/shell, forms, and v2 permissions until OpenCode 2.0 is standardized.",
        experimental: true,
        commandPreview: openCodeHarnessCommandPreview(),
        available: openCodeHarnessAvailable(),
        capabilities: AGENT_CAPABILITIES[id],
        defaultMode: "build",
        defaultModelId: "auto",
        defaultModelName: "Auto",
      });
    }
    case "devin-acp": {
      const runtime = resolveHarnessRuntimeSpec("devin");
      return createBackendInfo({
        id: "devin-acp",
        label: "Devin",
        description:
          "Cognition Devin CLI over ACP stdio (`devin acp`). Uses ambient `devin auth login` credentials or `WINDSURF_API_KEY`.",
        experimental: true,
        commandPreview: runtime?.commandPreview ?? "Devin CLI not found",
        available: runtime !== null,
        capabilities: AGENT_CAPABILITIES["devin-acp"],
        defaultMode: "agent",
        defaultModelId: "auto",
        defaultModelName: "Auto",
      });
    }
    case "grok-build": {
      const runtime = resolveHarnessRuntimeSpec("grok");
      return createBackendInfo({
        id: "grok-build",
        label: "Grok Build",
        description:
          "SpaceXAI Grok Build CLI over its official ACP stdio transport (`grok agent stdio`). Uses ambient `grok login` credentials or `XAI_API_KEY`.",
        experimental: true,
        commandPreview: runtime?.commandPreview ?? "Grok Build CLI not found",
        available: runtime !== null,
        capabilities: AGENT_CAPABILITIES["grok-build"],
        defaultMode: "agent",
        defaultModelId: "grok-4.5",
        defaultModelName: "Grok 4.5",
      });
    }
    case "codex-app-server": {
      const runtime = resolveHarnessRuntimeSpec("codex");
      return createBackendInfo({
        id: "codex-app-server",
        label: "Codex",
        description:
          "Official Codex App Server over JSON-RPC stdio with canonical tool and plan-file mirroring.",
        experimental: true,
        commandPreview: runtime
          ? `${runtime.commandPreview} app-server`
          : "Codex CLI not found",
        available: runtime !== null,
        capabilities: AGENT_CAPABILITIES["codex-app-server"],
        defaultMode: "agent",
        defaultModelId: "__default__",
        defaultModelName: "Codex App Server Default",
      });
    }
    case "codex-acp": {
      const runtime = resolveCodexAcpRuntime();
      return createBackendInfo({
        id: "codex-acp",
        label: "Codex",
        description:
          "Codex CLI over ACP (`codex acp`). Uses ambient Codex auth; choose this when you prefer the Agent Client Protocol session model.",
        experimental: true,
        commandPreview: runtime?.commandPreview ?? "Codex CLI not found",
        available: runtime !== null,
        capabilities: AGENT_CAPABILITIES["codex-acp"],
        defaultMode: "agent",
        defaultModelId: "auto",
        defaultModelName: "Auto",
      });
    }
    case "claude-code-sdk": {
      // The Claude Agent SDK ships its own CLI runtime, so ambient host
      // credentials (native `claude login`, installed CLI) make the backend
      // usable without any explicit key. Explicit auth config always wins.
      const hasAuth = hasClaudeCodeSdkAuthConfig() || hasClaudeCodeAmbientCliAuth();
      return createBackendInfo({
        id: "claude-code-sdk",
        label: "Claude Code SDK",
        description: hasAuth
          ? "Anthropic Claude Agent SDK with stock Claude Code tools and OpenCursor MCP settings bridged in memory."
          : "Claude Code SDK requires ANTHROPIC_API_KEY, a configured proxy, a supported provider env, or an installed `claude` CLI login. Open Settings -> Agents to configure it.",
        experimental: true,
        commandPreview: `@anthropic-ai/claude-agent-sdk · ${describeClaudeCodeSdkAuthStatus()}`,
        available: hasAuth,
        capabilities: AGENT_CAPABILITIES["claude-code-sdk"],
        defaultMode: "agent",
        defaultModelId: hasClaudeCodeSdkProxyConfig()
          ? getClaudeCodeSdkProxyModel()
          : "claude-sonnet-4-5",
        defaultModelName: hasClaudeCodeSdkProxyConfig()
          ? getClaudeCodeSdkProxyModelName()
          : "Claude Sonnet 4.5",
      });
    }
    case "pi-agent":
      return createBackendInfo({
        id: "pi-agent",
        label: "Pi Agent",
        description:
          "Native Pi coding agent SDK. Loads ~/.pi/agent (packages, extensions, skills, settings) plus project .pi/ customization.",
        experimental: true,
        commandPreview: `@earendil-works/pi-coding-agent · API key via settings`,
        available: false,
        capabilities: AGENT_CAPABILITIES["pi-agent"],
        defaultMode: "agent",
        defaultModelId: "auto",
        defaultModelName: "Auto",
      });
    case "google-antigravity-cli": {
      const runtime = resolveHarnessRuntimeSpec("google-antigravity");
      return createBackendInfo({
        id: "google-antigravity-cli",
        label: "Google Antigravity CLI",
        description:
          "Google Antigravity CLI (`agy`) - successor to Gemini CLI. Uses ambient Google OAuth from the CLI login on the host; OpenCursor does not broker tokens.",
        experimental: true,
        commandPreview: runtime
          ? `${runtime.commandPreview} interactive`
          : "Antigravity CLI (agy) not found",
        available: runtime !== null,
        capabilities: AGENT_CAPABILITIES["google-antigravity-cli"],
        defaultMode: "agent",
        defaultModelId: "auto",
        defaultModelName: "Auto",
      });
    }
  }
}

/**
 * Stable ordering for harness/model-picker menus. Derived from the shared
 * active-backend registry so the server menu, model toggles, and frontend
 * settings can never drift apart.
 */
const AGENT_BACKEND_MENU_ORDER: readonly AgentBackendId[] = ACTIVE_AGENT_BACKEND_IDS;

/**
 * Live backend registry. Property reads compute fresh info from the current
 * CLI detection state, so `AGENT_BACKENDS["grok-build"].available` flips as
 * soon as the CLI is installed/uninstalled - no server restart or module
 * reload required. Spreads, `Object.entries`, and `in` checks all behave like
 * a plain record.
 */
const HIDDEN_AGENT_BACKEND_IDS = ["opencode-v2-beta"] as const satisfies readonly AgentBackendId[];

export const AGENT_BACKENDS: Record<AgentBackendId, AgentBackendInfo> = (() => {
  const registry = {} as Record<AgentBackendId, AgentBackendInfo>;
  const hidden = new Set<string>(HIDDEN_AGENT_BACKEND_IDS);
  for (const id of [...AGENT_BACKEND_MENU_ORDER, ...HIDDEN_AGENT_BACKEND_IDS]) {
    Object.defineProperty(registry, id, {
      enumerable: !hidden.has(id),
      get: () => computeBackendInfo(id),
    });
  }
  return registry;
})();

export function listAgentBackends(): AgentBackendInfo[] {
  return AGENT_BACKEND_MENU_ORDER.map((id) => computeBackendInfo(id));
}

/** Live detection details (path/source/version) for a CLI-backed backend. */
async function describeBackendRuntime(
  backendId: AgentBackendId
): Promise<AgentBackendRuntimeInfo | null> {
  const harness = BACKEND_HARNESS_CLI[backendId];
  if (!harness) {
    return null;
  }
  const detection = detectHarnessCli(harness);
  if (!detection) {
    return null;
  }
  const version = await probeHarnessCliVersion(harness).catch(() => null);
  return {
    executablePath: detection.executablePath,
    source: detection.source,
    version,
  };
}

export async function listAgentBackendsWithCache(): Promise<AgentBackendInfo[]> {
  const [cursorSdkStatus, cesiumStatus, piAgentStatus, piAgentAuthStatus, globalSettings] =
    await Promise.all([
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
    getGlobalSettings().catch(() => null),
  ]);
  const enabledHarnesses = globalSettings?.agents.enabledHarnesses;
  const harnessTransports = globalSettings?.agents.harnessTransports;
  return Promise.all(
    AGENT_BACKEND_MENU_ORDER.map(async (id) => {
      const backend = computeBackendInfo(id);
      const family = harnessFamilyForBackend(backend.id);
      const familyEnabled = family
        ? isHarnessFamilyEnabled(enabledHarnesses, family)
        : isHarnessEnabled(enabledHarnesses, backend.id);
      const preferredId = family
        ? resolvePreferredHarnessBackendId(family, { enabledHarnesses, harnessTransports })
        : backend.id;
      const [cachedConfigOptions, runtime] = await Promise.all([
        readAgentBackendConfigCache(backend.id),
        describeBackendRuntime(backend.id),
      ]);
      return {
        ...backend,
        enabled: familyEnabled && backend.id === preferredId,
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
            : runtime?.version && backend.commandPreview
            ? `${backend.commandPreview} · v${runtime.version}`
            : backend.commandPreview,
        description:
          backend.id === "cesium-agent" && !cesiumStatus.configured
            ? "Cesium Agent requires at least one OpenAI, Anthropic, Google, or custom provider API key. Open Settings -> Agents to configure it."
            : backend.id === "cursor-sdk" && !cursorSdkStatus.configured
            ? "Cursor SDK requires a Cursor API key. Open Settings -> Agents to configure it."
            : backend.id === "cursor-acp" && !backend.available
            ? "Cursor ACP requires the Cursor Agent CLI (`agent`) on the server host. Install it or set OPENCURSOR_CURSOR_CLI_BIN, then sign in with `agent login`."
            : backend.id === "codex-acp" && !backend.available
            ? "Codex ACP requires the Codex CLI on the server host. Install it or set OPENCURSOR_CODEX_BIN, then sign in with `codex login`."
            : backend.id === "pi-agent" && !piAgentStatus
            ? "Pi Agent requires at least one provider credential (OAuth or API key in Settings, env keys, or native ~/.pi/agent auth). Open Settings -> Agents to configure it."
            : backend.description,
        runtime,
        cachedConfigOptions,
      };
    })
  );
}

function createAcpProvider(input: {
  backend: AgentBackendInfo;
  runtime: CliRuntimeSpec;
  seedConfigOptions?: Parameters<typeof AcpSessionHandle.create>[0]["seedConfigOptions"];
}): AgentProvider {
  const { backend, runtime, seedConfigOptions } = input;
  return {
    backend,
    startSession(callbacks) {
      return AcpSessionHandle.create({
        backend,
        command: runtime.command,
        args: runtime.args,
        env: runtime.env,
        callbacks,
        seedConfigOptions,
      });
    },
    loadSession(callbacks, providerSessionId) {
      return AcpSessionHandle.create({
        backend,
        command: runtime.command,
        args: runtime.args,
        env: runtime.env,
        callbacks,
        loadSessionId: providerSessionId,
        seedConfigOptions,
      });
    },
  };
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

  if (backendId === "cursor-acp") {
    const runtime = resolveCursorAcpRuntime();
    if (!runtime) {
      throw new Error(
        `${backend.label} requires the Cursor Agent CLI. Install it or set OPENCURSOR_CURSOR_CLI_BIN / OPENCURSOR_CURSOR_ACP_BIN.`
      );
    }
    return createAcpProvider({
      backend,
      runtime,
      seedConfigOptions: await readAgentBackendConfigCache(backendId),
    });
  }

  if (backendId === "cesium-agent") {
    const { createCesiumAgentProvider } = await import("./cesium-provider.js");
    return createCesiumAgentProvider({
      backend,
      configOptions: await readAgentBackendConfigCache(backendId),
    });
  }

  if (backendId === "opencode-server" || backendId === "opencode-v2-beta") {
    if (!openCodeHarnessAvailable()) {
      throw new Error(`${backend.label} is not installed or configured.`);
    }
    const { createOpenCodeProvider } = await import("./opencode-provider.js");
    return createOpenCodeProvider({
      backend: AGENT_BACKENDS["opencode-server"],
      configOptions: await readAgentBackendConfigCache("opencode-server"),
    });
  }

  if (backendId === "devin-acp") {
    const runtime = resolveHarnessRuntimeSpec("devin");
    if (!runtime) {
      throw new Error(`${backend.label} is not installed or could not be resolved.`);
    }
    return createAcpProvider({ backend, runtime });
  }

  if (backendId === "grok-build") {
    const runtime = resolveHarnessRuntimeSpec("grok");
    if (!runtime) {
      throw new Error(
        `${backend.label} requires the grok binary. Install it from https://x.ai/cli or configure OPENCURSOR_GROK_BUILD_BIN.`
      );
    }
    const cachedConfigOptions = await readAgentBackendConfigCache(backendId);
    const seedConfigOptions = cachedConfigOptions.some(
      (option) => option.category === "mode"
    )
      ? cachedConfigOptions
      : [createGrokBuildModeConfigOption(), ...cachedConfigOptions];
    return createAcpProvider({ backend, runtime, seedConfigOptions });
  }

  if (backendId === "codex-app-server") {
    const runtime = resolveHarnessRuntimeSpec("codex");
    if (!runtime) {
      throw new Error(`${backend.label} is not installed or could not be resolved.`);
    }
    const { createCodexAppServerProvider } = await import("./codex-app-server-provider.js");
    return createCodexAppServerProvider({
      backend,
      runtime,
      configOptions: await readAgentBackendConfigCache(backendId),
    });
  }

  if (backendId === "codex-acp") {
    const runtime = resolveCodexAcpRuntime();
    if (!runtime) {
      throw new Error(
        `${backend.label} requires the Codex CLI. Install it or set OPENCURSOR_CODEX_BIN.`
      );
    }
    return createAcpProvider({
      backend,
      runtime,
      seedConfigOptions: await readAgentBackendConfigCache(backendId),
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
    const runtime = resolveHarnessRuntimeSpec("google-antigravity");
    if (!runtime) {
      throw new Error(`${backend.label} requires the agy binary to be installed and available on PATH.`);
    }
    const { createGoogleAntigravityCliProvider } = await import("./google-antigravity-cli-provider.js");
    return createGoogleAntigravityCliProvider({
      backend,
      runtime,
      configOptions: await readAgentBackendConfigCache(backendId),
    });
  }

  throw new Error(`${backend.label} is not implemented yet.`);
}
