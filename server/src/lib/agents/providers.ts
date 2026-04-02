import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { AcpStdioClient } from "./acp-transport.js";
import {
  type AcpSharedBridge,
  makeAcpPoolKey,
  retainAcpSharedBridge,
} from "./acp-shared-bridge.js";
import {
  createClaudeAdapterProvider,
  createCodexAdapterProvider,
  type CliRuntimeSpec,
} from "./cli-adapter.js";
import {
  readAgentBackendConfigCache,
  writeAgentBackendConfigCache,
} from "./provider-cache-store.js";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConfigOption,
  AgentConfigOptionCategory,
  AgentConversationMode,
  AgentConversationRecord,
  AgentPermissionOption,
  AgentPlanEntry,
  AgentProvider,
  AgentProviderCapabilities,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
  AgentToolCallStatus,
} from "./types.js";
import {
  configOptionMatchesCategory,
  findPrimaryModelConfigOption,
  findPrimaryModeConfigOption,
} from "./config-option-utils.js";
import { formatRejectedToolDetail } from "./tool-rejection-utils.js";

type AcpRuntimeSpec = CliRuntimeSpec;

const openCodeCapabilities: AgentProviderCapabilities = {
  supportsLoadSession: true,
  supportsModeSelection: true,
  supportsModelSelection: true,
  supportsSlashCommands: true,
  supportsPermissions: true,
  supportsToolCalls: true,
  supportsStructuredPlans: true,
  supportsTodos: true,
  supportsSessionResume: true,
};

const basicCliCapabilities: AgentProviderCapabilities = {
  supportsLoadSession: false,
  supportsModeSelection: false,
  supportsModelSelection: true,
  supportsSlashCommands: false,
  supportsPermissions: false,
  supportsToolCalls: false,
  supportsStructuredPlans: false,
  supportsTodos: false,
  supportsSessionResume: false,
};

const cursorAcpCapabilities: AgentProviderCapabilities = {
  supportsLoadSession: true,
  supportsModeSelection: true,
  supportsModelSelection: true,
  supportsSlashCommands: false,
  supportsPermissions: true,
  supportsToolCalls: true,
  supportsStructuredPlans: true,
  supportsTodos: true,
  supportsSessionResume: true,
};

const geminiCapabilities: AgentProviderCapabilities = {
  supportsLoadSession: true,
  supportsModeSelection: true,
  supportsModelSelection: true,
  supportsSlashCommands: false,
  supportsPermissions: true,
  supportsToolCalls: true,
  supportsStructuredPlans: false,
  supportsTodos: false,
  supportsSessionResume: true,
};

const LEGACY_MODE_CONFIG_ID = "__acp_legacy_mode__";
const LEGACY_MODEL_CONFIG_ID = "__acp_legacy_model__";

/**
 * Declares what the OpenCursor Node client can delegate when the agent asks.
 * Defaults are conservative. For headless / CI, Cursor may require overrides —
 * set `OPENCURSOR_ACP_CLIENT_CAPABILITIES_JSON` (partial JSON merged on top).
 */
function buildAcpClientCapabilities(): Record<string, unknown> {
  const base: Record<string, unknown> = {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  };
  const raw = process.env.OPENCURSOR_ACP_CLIENT_CAPABILITIES_JSON?.trim();
  if (!raw) {
    return base;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return base;
    }
    const p = parsed as Record<string, unknown>;
    const next: Record<string, unknown> = { ...base, ...p };
    if (p.fs && typeof p.fs === "object" && !Array.isArray(p.fs)) {
      next.fs = {
        ...(base.fs as Record<string, unknown>),
        ...(p.fs as Record<string, unknown>),
      };
    }
    return next;
  } catch {
    return base;
  }
}

/** Extra argv merged after the resolved Cursor `agent` binary (JSON string array). */
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

function summarizeAuthenticateResult(raw: unknown): string | undefined {
  if (raw == null) {
    return undefined;
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  for (const key of [
    "message",
    "instructions",
    "detail",
    "url",
    "loginUrl",
    "verificationUrl",
  ] as const) {
    const v = r[key];
    if (typeof v === "string" && v.trim()) {
      const t = v.trim();
      if (key === "url" || key === "loginUrl" || key === "verificationUrl") {
        return `Open or complete: ${t}`;
      }
      return t;
    }
  }
  return undefined;
}

async function runAcpTransportBootstrap(transport: AcpStdioClient): Promise<string[]> {
  const messages: string[] = [];
  const init = (await transport.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: buildAcpClientCapabilities(),
    clientInfo: {
      name: "opencursor-server",
      title: "OpenCursor Server",
      version: "0.1.0",
    },
  })) as Record<string, unknown> | undefined;

  const authMethods = Array.isArray(init?.authMethods) ? init.authMethods : [];
  const seen = new Set<string>();
  for (const entry of authMethods) {
    const id =
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? parseConfigOptionString((entry as Record<string, unknown>).id)
        : typeof entry === "string"
          ? entry.trim()
          : "";
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    if (id === "cursor_login") {
      try {
        const authResult = await transport.request("authenticate", { methodId: "cursor_login" });
        const note = summarizeAuthenticateResult(authResult);
        if (note) {
          messages.push(`Cursor CLI authentication: ${note}`);
        }
      } catch (error) {
        const errText = error instanceof Error ? error.message : String(error);
        messages.push(
          `Cursor CLI authentication failed: ${errText}. Sign in on the server host with your Cursor CLI, set OPENCURSOR_CURSOR_CLI_BIN to that binary, and redeploy.`
        );
      }
    } else {
      messages.push(
        `ACP lists authentication method "${id}". If the agent stalls, complete any login this method requires on the server (TTY or documented OAuth); OpenCursor only bridges stdio.`
      );
    }
  }
  return messages;
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

function resolveCursorCliRuntime(): CliRuntimeSpec | null {
  const envOverrides = {
    ...process.env,
    CURSOR_INVOKED_AS: process.env.CURSOR_INVOKED_AS || "agent.cmd",
  };
  const extraArgs = [...parseCursorAgentExtraArgs(), "acp"];
  const configured = resolveConfiguredRuntime(
    process.env.OPENCURSOR_CURSOR_CLI_BIN ?? process.env.OPENCURSOR_CURSOR_ACP_BIN,
    extraArgs,
    envOverrides
  );
  if (configured) {
    return configured;
  }

  const pathHit = findExecutableOnPath(
    process.platform === "win32"
      ? ["agent.exe", "agent.cmd", "cursor-agent.cmd", "agent"]
      : ["agent"]
  );
  if (pathHit) {
    return buildInvocation(pathHit, extraArgs, envOverrides);
  }

  return null;
}

function resolveOpenCodeAcpRuntime(): AcpRuntimeSpec | null {
  const configured = resolveConfiguredRuntime(
    process.env.OPENCURSOR_OPENCODE_ACP_BIN,
    ["acp"]
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
    return buildInvocation(pathHit, ["acp"]);
  }

  if (process.platform === "win32") {
    const roamingNpm = process.env.APPDATA?.trim()
      ? path.join(process.env.APPDATA, "npm", "opencode.cmd")
      : null;
    if (roamingNpm && fileExists(roamingNpm)) {
      return buildInvocation(roamingNpm, ["acp"]);
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

function resolveClaudeCliRuntime(): CliRuntimeSpec | null {
  const configured = resolveConfiguredRuntime(process.env.OPENCURSOR_CLAUDE_BIN, []);
  if (configured) {
    return configured;
  }

  const pathHit = findExecutableOnPath(
    process.platform === "win32"
      ? ["claude.exe", "claude.cmd", "claude.bat", "claude"]
      : ["claude"]
  );
  return pathHit ? buildInvocation(pathHit, []) : null;
}

function resolveGeminiAcpRuntime(): AcpRuntimeSpec | null {
  const configured = resolveConfiguredRuntime(
    process.env.OPENCURSOR_GEMINI_ACP_BIN ?? process.env.OPENCURSOR_GEMINI_BIN,
    ["--acp"]
  );
  if (configured) {
    return configured;
  }

  const pathHit = findExecutableOnPath(
    process.platform === "win32"
      ? ["gemini.exe", "gemini.cmd", "gemini.bat", "gemini"]
      : ["gemini"]
  );
  return pathHit ? buildInvocation(pathHit, ["--acp"]) : null;
}

const CURSOR_RUNTIME = resolveCursorCliRuntime();
const OPENCODE_RUNTIME = resolveOpenCodeAcpRuntime();
const CODEX_RUNTIME = resolveCodexCliRuntime();
const CLAUDE_RUNTIME = resolveClaudeCliRuntime();
const GEMINI_RUNTIME = resolveGeminiAcpRuntime();

export type CursorAgentDeploymentHints = {
  resolved: boolean;
  commandPreview: string | null;
  extraArgs: string[];
  permissionModeEnv: string | null;
  acpCapabilitiesJsonSet: boolean;
  cursorBinEnvSet: boolean;
};

export function getCursorAgentDeploymentHints(): CursorAgentDeploymentHints {
  return {
    resolved: CURSOR_RUNTIME !== null,
    commandPreview: CURSOR_RUNTIME?.commandPreview ?? null,
    extraArgs: parseCursorAgentExtraArgs(),
    permissionModeEnv: process.env.OPENCURSOR_CURSOR_PERMISSION_MODE?.trim() || null,
    acpCapabilitiesJsonSet: Boolean(process.env.OPENCURSOR_ACP_CLIENT_CAPABILITIES_JSON?.trim()),
    cursorBinEnvSet: Boolean(
      (process.env.OPENCURSOR_CURSOR_CLI_BIN ?? process.env.OPENCURSOR_CURSOR_ACP_BIN)?.trim()
    ),
  };
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

export const AGENT_BACKENDS: Record<AgentBackendId, AgentBackendInfo> = {
  "cursor-acp": createBackendInfo({
    id: "cursor-acp",
    label: "Cursor",
    description: "Cursor CLI over ACP stdio with full model variants.",
    commandPreview: CURSOR_RUNTIME?.commandPreview ?? "Cursor CLI not found",
    available: CURSOR_RUNTIME !== null,
    capabilities: cursorAcpCapabilities,
    defaultMode: "agent",
    defaultModelId: "auto",
    defaultModelName: "Auto",
  }),
  "opencode-acp": createBackendInfo({
    id: "opencode-acp",
    label: "Opencode",
    description: "OpenCode CLI over ACP stdio.",
    commandPreview: OPENCODE_RUNTIME?.commandPreview ?? "OpenCode CLI not found",
    available: OPENCODE_RUNTIME !== null,
    capabilities: openCodeCapabilities,
    defaultMode: "agent",
    defaultModelId: "auto",
    defaultModelName: "Auto",
  }),
  "codex-adapter": createBackendInfo({
    id: "codex-adapter",
    label: "Codex",
    description: "Official Codex CLI via non-interactive adapter.",
    experimental: false,
    commandPreview: CODEX_RUNTIME?.commandPreview ?? "Codex CLI not found",
    available: CODEX_RUNTIME !== null,
    capabilities: basicCliCapabilities,
    defaultMode: "agent",
    defaultModelId: "__default__",
    defaultModelName: "Default",
  }),
  "claude-adapter": createBackendInfo({
    id: "claude-adapter",
    label: "Claude Code",
    description: "Official Claude Code CLI routed through the local model proxy.",
    experimental: false,
    commandPreview: CLAUDE_RUNTIME?.commandPreview ?? "Claude Code CLI not found",
    available: CLAUDE_RUNTIME !== null,
    capabilities: basicCliCapabilities,
    defaultMode: "agent",
    defaultModelId: "turbo",
    defaultModelName: "Turbo",
  }),
  "gemini-adapter": createBackendInfo({
    id: "gemini-adapter",
    label: "Gemini",
    description: "Official Gemini CLI over ACP stdio.",
    experimental: false,
    commandPreview: GEMINI_RUNTIME?.commandPreview ?? "Gemini CLI not found",
    available: GEMINI_RUNTIME !== null,
    capabilities: geminiCapabilities,
    defaultMode: "agent",
    defaultModelId: "gemini-2.5-pro",
    defaultModelName: "Gemini 2.5 Pro",
  }),
};

export function listAgentBackends(): AgentBackendInfo[] {
  return Object.values(AGENT_BACKENDS);
}

export async function listAgentBackendsWithCache(): Promise<AgentBackendInfo[]> {
  return Promise.all(
    Object.values(AGENT_BACKENDS).map(async (backend) => ({
      ...backend,
      cachedConfigOptions: await readAgentBackendConfigCache(backend.id),
    }))
  );
}

function parseConfigOptionCategory(value: unknown): AgentConfigOptionCategory {
  if (
    value === "mode" ||
    value === "model" ||
    value === "thought_level" ||
    value === "permission" ||
    value === "other"
  ) {
    return value;
  }
  return "other";
}

function parseConfigOptionString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function inferConfigOptionCategory(
  record: Record<string, unknown>,
  id: string,
  name: string
): AgentConfigOptionCategory {
  const direct = parseConfigOptionCategory(record.category);
  if (direct !== "other") {
    return direct;
  }
  const lowerId = id.toLowerCase();
  const lowerName = name.toLowerCase();
  if (
    lowerId.includes("thought") ||
    lowerName.includes("thought") ||
    lowerId.includes("reasoning") ||
    lowerName.includes("reasoning") ||
    lowerId.includes("effort") ||
    lowerName.includes("effort") ||
    lowerId.includes("thinking") ||
    lowerName.includes("thinking") ||
    lowerId.includes("speed") ||
    lowerName.includes("speed") ||
    lowerId.includes("tier") ||
    lowerName.includes("tier")
  ) {
    return "thought_level";
  }
  if (
    lowerId === "mode" ||
    lowerId.endsWith("mode") ||
    lowerName.includes("mode") ||
    lowerName.includes("agent")
  ) {
    return "mode";
  }
  if (
    lowerId === "model" ||
    lowerId.endsWith("model") ||
    lowerName.includes("model")
  ) {
    return "model";
  }
  if (lowerId.includes("permission") || lowerName.includes("permission")) {
    return "permission";
  }
  return "other";
}

function resolveConfigOptionCurrentValue(
  record: Record<string, unknown>,
  options: AgentConfigOption["options"]
): string {
  const directKeys = ["currentValue", "selectedValue", "value", "defaultValue"];
  for (const key of directKeys) {
    const candidate = parseConfigOptionString(record[key]);
    if (candidate) {
      return candidate;
    }
  }

  const rawOptions = Array.isArray(record.options)
    ? record.options
    : Array.isArray(record.values)
      ? record.values
      : Array.isArray(record.items)
        ? record.items
        : [];
  for (const rawOption of rawOptions) {
    if (!rawOption || typeof rawOption !== "object") {
      continue;
    }
    const optionRecord = rawOption as Record<string, unknown>;
    if (
      optionRecord.selected === true ||
      optionRecord.current === true ||
      optionRecord.active === true ||
      optionRecord.default === true
    ) {
      const selectedValue =
        parseConfigOptionString(optionRecord.value) ||
        parseConfigOptionString(optionRecord.id) ||
        parseConfigOptionString(optionRecord.key);
      if (selectedValue) {
        return selectedValue;
      }
    }
  }

  return options[0]?.value ?? "";
}

function normalizeProviderMode(
  rawValue: string | undefined,
  fallback: AgentConversationMode
): AgentConversationMode {
  const normalized = rawValue?.trim();
  return normalized ? (normalized as AgentConversationMode) : fallback;
}

function isCursorCliModelId(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && !trimmed.includes("[");
}

function parseCursorBracketModelValue(value: string): {
  params: Record<string, string>;
} {
  const match = /^.+?\[(.*)\]$/.exec(value.trim());
  if (!match) {
    return { params: {} };
  }
  const params = Object.fromEntries(
    match[1]
      .split(",")
      .map((entry) => {
        const [rawKey, rawValue] = entry.split("=");
        return [rawKey?.trim() ?? "", rawValue?.trim() ?? ""];
      })
      .filter(([key]) => key.length > 0)
  );
  return { params };
}

function parseCursorSeedVariant(value: string): {
  effort?: string;
  fast: boolean;
  thinking: boolean;
} {
  let rest = value.trim().toLowerCase();
  let fast = false;
  let thinking = false;
  let effort: string | undefined;

  if (rest.endsWith("-fast")) {
    fast = true;
    rest = rest.slice(0, -5);
  }

  if (rest.endsWith("-thinking")) {
    thinking = true;
    rest = rest.slice(0, -9);
  }

  for (const candidate of ["none", "low", "medium", "high", "xhigh"] as const) {
    if (rest.endsWith(`-${candidate}`)) {
      effort = candidate;
      break;
    }
  }

  if (!effort && rest.startsWith("claude-") && rest.endsWith("-max")) {
    effort = "max";
  }

  return { effort, fast, thinking };
}

function parseCursorLiveVariant(value: string): {
  effort?: string;
  fast: boolean;
  thinking: boolean;
} {
  const params = parseCursorBracketModelValue(value).params;
  const rawEffort = params.reasoning || params.effort || "";
  return {
    effort: rawEffort ? rawEffort.toLowerCase() : undefined,
    fast: params.fast === "true",
    thinking: params.thinking === "true",
  };
}

function tokenizeCursorModelLabel(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function resolveCursorSeedModelValue(input: {
  seedModelOption: AgentConfigOption;
  liveModelOption?: AgentConfigOption;
  selectedModelId?: string;
  selectedModelName?: string;
}): string {
  const { seedModelOption, liveModelOption, selectedModelId, selectedModelName } = input;
  const directModelId = selectedModelId?.trim() ?? "";
  if (directModelId && seedModelOption.options.some((option) => option.value === directModelId)) {
    return directModelId;
  }

  const directName = selectedModelName?.trim() ?? "";
  if (directName) {
    const exactName = seedModelOption.options.find((option) => option.name === directName);
    if (exactName) {
      return exactName.value;
    }
  }

  const liveCurrentValue = liveModelOption?.currentValue?.trim() ?? "";
  const liveCurrentOption =
    liveModelOption?.options.find((option) => option.value === liveCurrentValue) ?? null;
  const liveName = directName || liveCurrentOption?.name?.trim() || "";
  const liveVariant = parseCursorLiveVariant(directModelId || liveCurrentValue);
  const liveTokens = new Set(tokenizeCursorModelLabel(liveName));

  let bestMatch: { value: string; score: number } | null = null;
  for (const option of seedModelOption.options) {
    const seedTokens = new Set(tokenizeCursorModelLabel(option.name));
    let matchedTokenCount = 0;
    for (const token of liveTokens) {
      if (seedTokens.has(token)) {
        matchedTokenCount += 1;
      }
    }
    if (liveTokens.size > 0 && matchedTokenCount === 0) {
      continue;
    }

    const seedVariant = parseCursorSeedVariant(option.value);
    let score = matchedTokenCount * 10;
    if (liveTokens.size > 0 && matchedTokenCount === liveTokens.size) {
      score += 20;
    }
    if ((seedVariant.effort ?? "") === (liveVariant.effort ?? "")) {
      score += 12;
    } else if (liveVariant.effort) {
      score -= 12;
    }
    if (seedVariant.fast === liveVariant.fast) {
      score += 6;
    } else if (liveVariant.fast || seedVariant.fast) {
      score -= 6;
    }
    if (seedVariant.thinking === liveVariant.thinking) {
      score += 6;
    } else if (liveVariant.thinking || seedVariant.thinking) {
      score -= 6;
    }

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { value: option.value, score };
    }
  }

  if (bestMatch) {
    return bestMatch.value;
  }

  return seedModelOption.currentValue;
}

function mergeCursorSeedConfigOptions(
  seedConfigOptions: AgentConfigOption[] | undefined,
  liveConfigOptions: AgentConfigOption[],
  selectedConfig: AgentConversationRecord["config"]
): AgentConfigOption[] {
  if (!seedConfigOptions || seedConfigOptions.length === 0) {
    return liveConfigOptions;
  }

  const seedById = new Map(seedConfigOptions.map((option) => [option.id, option]));
  const liveById = new Map(liveConfigOptions.map((option) => [option.id, option]));
  const merged: AgentConfigOption[] = [];

  for (const seedOption of seedConfigOptions) {
    const liveOption = liveById.get(seedOption.id);
    if (seedOption.category === "model") {
      merged.push({
        ...seedOption,
        currentValue: resolveCursorSeedModelValue({
          seedModelOption: seedOption,
          liveModelOption: liveOption,
          selectedModelId: selectedConfig.modelId,
          selectedModelName: selectedConfig.modelName,
        }),
      });
      continue;
    }
    merged.push(liveOption ? { ...seedOption, currentValue: liveOption.currentValue } : seedOption);
  }

  for (const liveOption of liveConfigOptions) {
    if (!seedById.has(liveOption.id)) {
      merged.push(liveOption);
    }
  }

  return merged;
}

function parseConfigOptions(raw: unknown): AgentConfigOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const parsed: AgentConfigOption[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = parseConfigOptionString(record.id);
    const name =
      parseConfigOptionString(record.name) ||
      parseConfigOptionString(record.label) ||
      id;
    if (!id) {
      continue;
    }
    const options: AgentConfigOption["options"] = [];
    const rawOptions = Array.isArray(record.options)
      ? record.options
      : Array.isArray(record.values)
        ? record.values
        : Array.isArray(record.items)
          ? record.items
          : [];
    if (rawOptions.length > 0) {
      for (const option of rawOptions) {
        if (!option || typeof option !== "object") {
          continue;
        }
        const optionRecord = option as Record<string, unknown>;
        const value =
          parseConfigOptionString(optionRecord.value) ||
          parseConfigOptionString(optionRecord.id) ||
          parseConfigOptionString(optionRecord.key);
        const optionName =
          parseConfigOptionString(optionRecord.name) ||
          parseConfigOptionString(optionRecord.label) ||
          value;
        if (!value || !optionName) {
          continue;
        }
        options.push({
          value,
          name: optionName,
          description:
            typeof optionRecord.description === "string"
              ? optionRecord.description
              : undefined,
        });
      }
    }
    const currentValue = resolveConfigOptionCurrentValue(record, options);
    parsed.push({
      id,
      name,
      description:
        typeof record.description === "string" ? record.description : undefined,
      category: inferConfigOptionCategory(record, id, name),
      currentValue,
      options,
    });
  }
  return parsed;
}

function parseLegacySessionConfigOptions(
  session: Record<string, unknown>
): AgentConfigOption[] {
  const parsed: AgentConfigOption[] = [];

  const rawModes =
    session.modes && typeof session.modes === "object"
      ? (session.modes as Record<string, unknown>)
      : null;
  if (rawModes && Array.isArray(rawModes.availableModes)) {
    const options: AgentConfigOption["options"] = [];
    for (const entry of rawModes.availableModes) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const value =
        parseConfigOptionString(record.id) ||
        parseConfigOptionString(record.modeId);
      const name =
        parseConfigOptionString(record.name) ||
        parseConfigOptionString(record.label) ||
        value;
      if (!value || !name) {
        continue;
      }
      options.push({
        value,
        name,
        description:
          typeof record.description === "string" ? record.description : undefined,
      });
    }
    if (options.length > 0) {
      parsed.push({
        id: LEGACY_MODE_CONFIG_ID,
        name: "Mode",
        category: "mode",
        currentValue:
          parseConfigOptionString(rawModes.currentModeId) || options[0]?.value || "",
        options,
      });
    }
  }

  const rawModels =
    session.models && typeof session.models === "object"
      ? (session.models as Record<string, unknown>)
      : null;
  if (rawModels && Array.isArray(rawModels.availableModels)) {
    const options: AgentConfigOption["options"] = [];
    for (const entry of rawModels.availableModels) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const value =
        parseConfigOptionString(record.modelId) ||
        parseConfigOptionString(record.id) ||
        parseConfigOptionString(record.value);
      const name =
        parseConfigOptionString(record.name) ||
        parseConfigOptionString(record.label) ||
        value;
      if (!value || !name) {
        continue;
      }
      options.push({
        value,
        name,
        description:
          typeof record.description === "string" ? record.description : undefined,
      });
    }
    if (options.length > 0) {
      parsed.push({
        id: LEGACY_MODEL_CONFIG_ID,
        name: "Model",
        category: "model",
        currentValue:
          parseConfigOptionString(rawModels.currentModelId) || options[0]?.value || "",
        options,
      });
    }
  }

  return parsed;
}

function mergeSessionConfigOptions(
  configOptions: AgentConfigOption[],
  legacyOptions: AgentConfigOption[]
): AgentConfigOption[] {
  const merged = [...configOptions];
  for (const option of legacyOptions) {
    if (
      merged.some((existing) => existing.id === option.id) ||
      merged.some((existing) => configOptionMatchesCategory(existing, option.category))
    ) {
      continue;
    }
    merged.push(option);
  }
  return merged;
}

function normalizeConversationModeForProvider(
  requested: AgentConversationMode,
  option: AgentConfigOption | undefined
): string | null {
  if (!option) {
    return null;
  }
  const req = typeof requested === "string" ? requested.trim() : "";
  if (option.options.some((value) => value.value === requested)) {
    return requested;
  }
  const requestedLower = req.toLowerCase();
  const caseMatch = option.options.find((v) => v.value.toLowerCase() === requestedLower);
  if (caseMatch) {
    return caseMatch.value;
  }
  const rawCandidates =
    requestedLower === "agent" || requestedLower === "code"
      ? ["agent", "code", "build"]
      : requestedLower === "plan"
        ? ["plan", "architect"]
        : requestedLower === "ask"
          ? ["ask", "review", "readonly", "read-only"]
          : requestedLower === "debug"
            ? ["debug", "build", "agent", "code"]
            : [req];
  const available = new Set(option.options.map((value) => value.value));
  for (const candidate of rawCandidates) {
    if (available.has(candidate)) {
      return candidate;
    }
  }
  for (const candidate of rawCandidates) {
    const found = option.options.find((v) => v.value.toLowerCase() === candidate.toLowerCase());
    if (found) {
      return found.value;
    }
  }
  return null;
}

function summarizeToolContent(raw: unknown): string | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const first = raw[0];
  if (!first || typeof first !== "object") {
    return undefined;
  }
  const record = first as Record<string, unknown>;
  if (typeof record.path === "string" && typeof record.newText === "string") {
    return `Updated ${record.path}`;
  }
  const summarizeInlineText = (value: unknown): string | undefined => {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.includes("\n") || trimmed.length > 240) {
      return undefined;
    }
    return trimmed;
  };
  if (record.content && typeof record.content === "object") {
    const content = record.content as Record<string, unknown>;
    const inlineText = summarizeInlineText(content.text);
    if (inlineText) {
      return inlineText;
    }
  }
  const inlineText = summarizeInlineText(record.text);
  if (inlineText) {
    return inlineText;
  }
  return undefined;
}

function humanizeAcpToolCallName(value: string): string {
  return value
    .replace(/ToolCall$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .trim();
}

function isGenericAcpToolTitle(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    !normalized ||
    normalized === "tool call" ||
    normalized === "tool" ||
    normalized === "function call" ||
    normalized === "function"
  );
}

type AcpToolCallEntry = {
  rawName: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

function extractAcpToolCallEntries(
  record: Record<string, unknown>
): AcpToolCallEntry[] {
  const toolCall =
    record.tool_call && typeof record.tool_call === "object" && !Array.isArray(record.tool_call)
      ? (record.tool_call as Record<string, unknown>)
      : record.toolCall && typeof record.toolCall === "object" && !Array.isArray(record.toolCall)
        ? (record.toolCall as Record<string, unknown>)
        : undefined;
  if (!toolCall) {
    return [];
  }
  const entries: AcpToolCallEntry[] = [];
  for (const [rawName, value] of Object.entries(toolCall)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const entry = value as Record<string, unknown>;
    const args =
      entry.args && typeof entry.args === "object" && !Array.isArray(entry.args)
        ? (entry.args as Record<string, unknown>)
        : entry.input && typeof entry.input === "object" && !Array.isArray(entry.input)
          ? (entry.input as Record<string, unknown>)
          : undefined;
    const result =
      entry.result && typeof entry.result === "object" && !Array.isArray(entry.result)
        ? (entry.result as Record<string, unknown>)
        : undefined;
    entries.push({ rawName, args, result });
  }
  return entries;
}

function extractAcpToolCallPayload(record: Record<string, unknown>): {
  rawName?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
} {
  const [entry] = extractAcpToolCallEntries(record);
  return entry ?? {};
}

function hashDeterministicId(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (Math.imul(31, hash) + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16);
}

function buildAcpToolCallFallbackId(record: Record<string, unknown>): string {
  const entries = extractAcpToolCallEntries(record);
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (
    entries.length === 0 &&
    !title &&
    typeof record.session_id !== "string" &&
    typeof record.model_call_id !== "string"
  ) {
    return "tool-call";
  }
  const seed = JSON.stringify({
    title: title || undefined,
    sessionId: typeof record.session_id === "string" ? record.session_id : undefined,
    modelCallId: typeof record.model_call_id === "string" ? record.model_call_id : undefined,
    entries: entries.map((entry) => ({
      rawName: entry.rawName,
      path:
        typeof entry.args?.path === "string"
          ? entry.args.path
          : typeof entry.args?.filePath === "string"
            ? entry.args.filePath
            : undefined,
      pattern:
        typeof entry.args?.pattern === "string"
          ? entry.args.pattern
          : typeof entry.args?.query === "string"
            ? entry.args.query
            : typeof entry.args?.globPattern === "string"
              ? entry.args.globPattern
              : undefined,
      command:
        typeof entry.args?.command === "string"
          ? entry.args.command
          : typeof entry.args?.cmd === "string"
            ? entry.args.cmd
            : undefined,
    })),
  });
  return `tool-${hashDeterministicId(seed)}`;
}

function inferAcpToolKind(rawName: string | undefined): string {
  const name = humanizeAcpToolCallName(rawName ?? "").toLowerCase();
  if (!name) {
    return "tool";
  }
  if (name.includes("todo")) {
    return "todo";
  }
  if (name.includes("shell") || name.includes("terminal") || name.includes("command")) {
    return "terminal";
  }
  if (name.includes("grep")) {
    return "grep";
  }
  if (name.includes("glob") || name.includes("find") || name.includes("search")) {
    return "search";
  }
  if (name.includes("delete") || name.includes("remove") || name.includes("unlink")) {
    return "delete";
  }
  if (
    name.includes("write") ||
    name.includes("edit") ||
    name.includes("patch") ||
    name.includes("apply") ||
    name.includes("update") ||
    name.includes("create") ||
    name.includes("insert") ||
    name.includes("str replace") ||
    name.includes("rename")
  ) {
    return "edit";
  }
  if (name.includes("read") || name.includes("open")) {
    return "read";
  }
  return "tool";
}

function acpRecordHasAnyKey(
  record: Record<string, unknown> | undefined,
  keys: readonly string[]
): boolean {
  if (!record) {
    return false;
  }
  return keys.some((key) => key in record && record[key] != null);
}

function looksLikeAcpEditPayload(record: Record<string, unknown> | undefined): boolean {
  if (!record) {
    return false;
  }
  if (
    acpRecordHasAnyKey(record, [
      "diffString",
      "linesAdded",
      "linesRemoved",
      "beforeFullFileContent",
      "afterFullFileContent",
      "old_string",
      "new_string",
      "oldString",
      "newString",
      "replacement",
      "replacements",
      "patch",
      "edits",
      "contents",
      "renameTo",
      "newPath",
    ])
  ) {
    return true;
  }
  const errorText =
    typeof record.error === "string"
      ? record.error
      : record.error &&
          typeof record.error === "object" &&
          typeof (record.error as Record<string, unknown>).error === "string"
        ? ((record.error as Record<string, unknown>).error as string)
        : undefined;
  return Boolean(errorText && /failed to find context|apply patch|replace/i.test(errorText));
}

function looksLikeAcpReadPayload(record: Record<string, unknown> | undefined): boolean {
  if (!record || looksLikeAcpEditPayload(record)) {
    return false;
  }
  return acpRecordHasAnyKey(record, [
    "content",
    "text",
    "totalLines",
    "readRange",
    "contentBlobId",
    "isEmpty",
    "exceededLimit",
  ]);
}

function inferAcpToolKindFromEntry(payload: {
  rawName?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
}): string {
  if (looksLikeAcpEditPayload(payload.result) || looksLikeAcpEditPayload(payload.args)) {
    return "edit";
  }
  const fromName = inferAcpToolKind(payload.rawName);
  if (fromName !== "tool") {
    return fromName;
  }
  if (looksLikeAcpReadPayload(payload.result) || looksLikeAcpReadPayload(payload.args)) {
    return "read";
  }
  return "tool";
}

function summarizeAcpToolCallTitle(record: Record<string, unknown>): string | undefined {
  const entries = extractAcpToolCallEntries(record);
  if (entries.length > 1) {
    const parts = entries
      .map((entry) =>
        summarizeAcpToolCallTitle({
          ...record,
          tool_call: { [entry.rawName]: { args: entry.args, result: entry.result } },
        })
      )
      .filter((value): value is string => Boolean(value));
    const uniqueParts = parts.filter((value, index) => parts.indexOf(value) === index);
    if (uniqueParts.length > 0) {
      return uniqueParts.join(" + ");
    }
  }
  const payload = entries[0];
  if (!payload) {
    return undefined;
  }
  const args = payload.args ?? {};
  const path =
    typeof args.path === "string"
      ? args.path
      : typeof args.filePath === "string"
        ? args.filePath
        : undefined;
  const pattern =
    typeof args.pattern === "string"
      ? args.pattern
      : typeof args.query === "string"
        ? args.query
        : typeof args.globPattern === "string"
          ? args.globPattern
          : undefined;
  const command =
    typeof args.command === "string"
      ? args.command
      : typeof args.cmd === "string"
        ? args.cmd
        : undefined;
  const toolKind = inferAcpToolKindFromEntry(payload);
  if (toolKind === "read") {
    return path ? `Read ${path}` : "Read file";
  }
  if (toolKind === "grep") {
    return pattern ? `Grep "${pattern}"` : "Grep workspace";
  }
  if (toolKind === "search") {
    return pattern ? `Find "${pattern}"` : "Find workspace matches";
  }
  if (toolKind === "delete") {
    return path ? `Delete ${path}` : "Delete file";
  }
  if (toolKind === "edit") {
    return path ? `Update ${path}` : "Update file";
  }
  if (toolKind === "todo") {
    return "Update todo list";
  }
  if (command) {
    return command;
  }
  return payload.rawName ? humanizeAcpToolCallName(payload.rawName) : undefined;
}

function summarizeAcpToolCallDetail(record: Record<string, unknown>): string | undefined {
  const payloads = extractAcpToolCallEntries(record);
  const rejected = payloads
    .map((payload) =>
      payload.result?.rejected &&
      typeof payload.result.rejected === "object" &&
      !Array.isArray(payload.result.rejected)
        ? (payload.result.rejected as Record<string, unknown>)
        : undefined
    )
    .find((value) => value != null);
  if (rejected) {
    return formatRejectedToolDetail(rejected);
  }
  for (const payload of payloads) {
    if (typeof payload.args?.description === "string" && payload.args.description.trim()) {
      return payload.args.description.trim();
    }
  }
  return summarizeToolContent(record.content);
}

function normalizeAcpToolCallStatus(
  record: Record<string, unknown>,
  fallback: AgentToolCallStatus
): AgentToolCallStatus {
  if (record.status === "failed" || record.status === "cancelled") {
    return record.status;
  }
  if (
    extractAcpToolCallEntries(record).some((payload) => Boolean(payload.result?.rejected))
  ) {
    return "failed";
  }
  if (record.status === "completed") {
    return "completed";
  }
  if (record.subtype === "completed") {
    return "completed";
  }
  if (
    record.subtype === "started" &&
    (record.status == null || record.status === "pending")
  ) {
    return "in_progress";
  }
  if (
    record.status === "pending" ||
    record.status === "in_progress"
  ) {
    return record.status;
  }
  if (record.subtype === "started") {
    return "in_progress";
  }
  return fallback;
}

function humanizePermissionOptionLabel(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (!cleaned) {
    return "Option";
  }
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function normalizePermissionOptionKind(input: {
  kind?: unknown;
  optionId?: string;
  name?: string;
}): AgentPermissionOption["kind"] | null {
  const direct =
    typeof input.kind === "string"
      ? input.kind.trim().toLowerCase().replace(/[\s-]+/g, "_")
      : "";
  if (
    direct === "allow_once" ||
    direct === "allow_always" ||
    direct === "reject_once" ||
    direct === "reject_always"
  ) {
    return direct;
  }
  const seed = `${input.optionId ?? ""} ${input.name ?? ""} ${direct}`
    .trim()
    .toLowerCase();
  if (!seed) {
    return null;
  }
  const isAllow = /(allow|approve|accept|continue|yes|grant)/.test(seed);
  const isReject = /(reject|deny|decline|block|cancel|stop|no)/.test(seed);
  const isAlways = /(always|permanent|persist|remember|future)/.test(seed);
  if (isAllow) {
    return isAlways ? "allow_always" : "allow_once";
  }
  if (isReject) {
    return isAlways ? "reject_always" : "reject_once";
  }
  if (direct === "allow") {
    return "allow_once";
  }
  if (direct === "reject" || direct === "deny") {
    return "reject_once";
  }
  return null;
}

function parsePermissionOptions(raw: unknown): AgentPermissionOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      if (typeof item === "string" && item.trim()) {
        const optionId = item.trim();
        const name = humanizePermissionOptionLabel(optionId);
        const kind = normalizePermissionOptionKind({ optionId, name });
        return kind
          ? ({
              optionId,
              name,
              kind,
            } satisfies AgentPermissionOption)
          : null;
      }
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      const optionId =
        typeof record.optionId === "string"
          ? record.optionId.trim()
          : typeof record.id === "string"
            ? record.id.trim()
            : typeof record.value === "string"
              ? record.value.trim()
              : typeof record.key === "string"
                ? record.key.trim()
                : typeof record.actionId === "string"
                  ? record.actionId.trim()
                  : undefined;
      const name =
        typeof record.name === "string"
          ? record.name.trim()
          : typeof record.label === "string"
            ? record.label.trim()
            : typeof record.title === "string"
              ? record.title.trim()
              : typeof record.text === "string"
                ? record.text.trim()
                : optionId
                  ? humanizePermissionOptionLabel(optionId)
                  : undefined;
      const kind = normalizePermissionOptionKind({
        kind: record.kind ?? record.type ?? record.action,
        optionId,
        name,
      });
      if (!optionId || !name || !kind) {
        return null;
      }
      return {
        optionId,
        name,
        kind,
      } satisfies AgentPermissionOption;
    })
    .filter((value): value is AgentPermissionOption => value !== null);
}

function buildFallbackPermissionOptions(
  backendId: AgentBackendId
): AgentPermissionOption[] {
  if (backendId === "cursor-acp") {
    return [
      {
        optionId: "allow-once",
        name: "Allow once",
        kind: "allow_once",
      },
      {
        optionId: "allow-always",
        name: "Always allow",
        kind: "allow_always",
      },
      {
        optionId: "reject-once",
        name: "Reject",
        kind: "reject_once",
      },
    ];
  }
  return [
    {
      optionId: "allow_once",
      name: "Allow once",
      kind: "allow_once",
    },
    {
      optionId: "reject_once",
      name: "Reject",
      kind: "reject_once",
    },
  ];
}

function normalizeToolCallId(record: Record<string, unknown>): string {
  const readIdFromNestedRecord = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const nested = value as Record<string, unknown>;
    if (typeof nested.toolCallId === "string" && nested.toolCallId.trim()) {
      return nested.toolCallId;
    }
    if (typeof nested.toolUseId === "string" && nested.toolUseId.trim()) {
      return nested.toolUseId;
    }
    if (typeof nested.tool_use_id === "string" && nested.tool_use_id.trim()) {
      return nested.tool_use_id;
    }
    if (typeof nested.call_id === "string" && nested.call_id.trim()) {
      return nested.call_id;
    }
    if (typeof nested.callId === "string" && nested.callId.trim()) {
      return nested.callId;
    }
    if (typeof nested.id === "string" && nested.id.trim()) {
      return nested.id;
    }
    return undefined;
  };
  if (typeof record.toolCallId === "string" && record.toolCallId.trim()) {
    return record.toolCallId;
  }
  if (typeof record.toolUseId === "string" && record.toolUseId.trim()) {
    return record.toolUseId;
  }
  if (typeof record.tool_use_id === "string" && record.tool_use_id.trim()) {
    return record.tool_use_id;
  }
  if (typeof record.call_id === "string" && record.call_id.trim()) {
    return record.call_id;
  }
  if (typeof record.callId === "string" && record.callId.trim()) {
    return record.callId;
  }
  if (typeof record.id === "string" && record.id.trim()) {
    return record.id;
  }
  for (const payload of extractAcpToolCallEntries(record)) {
    const nestedId = readIdFromNestedRecord(payload.args) ?? readIdFromNestedRecord(payload.result);
    if (nestedId) {
      return nestedId;
    }
  }
  return buildAcpToolCallFallbackId(record);
}

function extractAcpLocations(record: Record<string, unknown>): { path: string; line?: number }[] | undefined {
  if (!Array.isArray(record.locations)) {
    return undefined;
  }
  const nextLocations: { path: string; line?: number }[] = [];
  for (const location of record.locations) {
    if (!location || typeof location !== "object") {
      continue;
    }
    const locationRecord = location as Record<string, unknown>;
    if (typeof locationRecord.path !== "string") {
      continue;
    }
    nextLocations.push({
      path: locationRecord.path,
      line:
        typeof locationRecord.line === "number"
          ? locationRecord.line
          : undefined,
    });
  }
  return nextLocations;
}

function extractPermissionRequestDetail(
  record: Record<string, unknown>,
  toolCall: Record<string, unknown>
): string | undefined {
  for (const key of [
    "message",
    "description",
    "detail",
    "rationale",
    "reason",
    "summary",
    "prompt",
  ] as const) {
    const v = record[key];
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }
  for (const key of ["message", "description", "detail", "reason"] as const) {
    const v = toolCall[key];
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }
  const args =
    toolCall.args && typeof toolCall.args === "object" && !Array.isArray(toolCall.args)
      ? (toolCall.args as Record<string, unknown>)
      : undefined;
  if (args) {
    const desc = args.description ?? args.prompt;
    if (typeof desc === "string" && desc.trim()) {
      return desc.trim();
    }
    const cmd = args.command ?? args.cmd;
    if (typeof cmd === "string" && cmd.trim()) {
      return `Command: ${cmd.trim()}`;
    }
  }
  return undefined;
}

class AcpSessionHandle implements AgentSessionHandle {
  readonly sessionId: string;
  configOptions: AgentConfigOption[];
  capabilities: AgentProviderCapabilities;

  private readonly pendingPermissionRequestIds = new Map<string, number | string>();
  private currentAssistantMessageId: string | null = null;
  private disposed = false;
  private readonly bridge: AcpSharedBridge;
  private readonly releaseBridge: () => Promise<void>;
  private readonly callbacks: AgentRuntimeCallbacks;
  private readonly backend: AgentBackendInfo;
  private readonly seedConfigOptions: AgentConfigOption[] | undefined;
  private suppressedAssistantChunks: string[] | null = null;

  private constructor(input: {
    bridge: AcpSharedBridge;
    releaseBridge: () => Promise<void>;
    callbacks: AgentRuntimeCallbacks;
    backend: AgentBackendInfo;
    sessionId: string;
    configOptions: AgentConfigOption[];
    capabilities: AgentProviderCapabilities;
    seedConfigOptions?: AgentConfigOption[];
  }) {
    this.bridge = input.bridge;
    this.releaseBridge = input.releaseBridge;
    this.callbacks = input.callbacks;
    this.backend = input.backend;
    this.sessionId = input.sessionId;
    this.configOptions = input.configOptions;
    this.capabilities = input.capabilities;
    this.seedConfigOptions = input.seedConfigOptions;
    this.registerBridgeHandlers();
  }

  static async create(input: {
    backend: AgentBackendInfo;
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    callbacks: AgentRuntimeCallbacks;
    loadSessionId?: string | null;
    seedConfigOptions?: AgentConfigOption[];
  }): Promise<AcpSessionHandle> {
    const poolKey = makeAcpPoolKey({
      workspaceRoot: input.callbacks.workspace.root,
      backendId: input.backend.id,
      command: input.command,
      args: input.args,
    });
    const { bridge, release, bootstrapSystemMessages } = await retainAcpSharedBridge({
      poolKey,
      spawn: () =>
        AcpStdioClient.spawn({
          command: input.command,
          args: input.args,
          cwd: input.callbacks.workspace.root,
          env: input.env ?? process.env,
        }),
      afterSpawn: (transport) => runAcpTransportBootstrap(transport),
    });

    bridge.startCreationCapture();
    try {
      const openResult = (await bridge.request(
        input.loadSessionId ? "session/load" : "session/new",
        input.loadSessionId
          ? {
              sessionId: input.loadSessionId,
              cwd: input.callbacks.workspace.root,
              mcpServers: [],
            }
          : {
              cwd: input.callbacks.workspace.root,
              mcpServers: [],
            }
      )) as Record<string, unknown> | null | undefined;

      const openResultRecord =
        openResult && typeof openResult === "object"
          ? (openResult as Record<string, unknown>)
          : {};

      const sessionId =
        typeof openResultRecord.sessionId === "string"
          ? openResultRecord.sessionId
          : input.loadSessionId;
      if (!sessionId) {
        throw new Error("ACP session did not return a sessionId.");
      }

      const liveConfigOptions = mergeSessionConfigOptions(
        parseConfigOptions(openResultRecord.configOptions),
        parseLegacySessionConfigOptions(openResultRecord)
      );
      const configOptions =
        input.backend.id === "cursor-acp"
          ? mergeCursorSeedConfigOptions(
              input.seedConfigOptions,
              liveConfigOptions,
              input.callbacks.conversation.config
            )
          : liveConfigOptions;

      const handle = new AcpSessionHandle({
        bridge,
        releaseBridge: release,
        callbacks: input.callbacks,
        backend: input.backend,
        sessionId,
        configOptions,
        capabilities: input.backend.capabilities,
        seedConfigOptions: input.seedConfigOptions,
      });

      await input.callbacks.updateConversation((current) => ({
        ...current,
        providerSessionId: sessionId,
        configOptions: configOptions.length > 0 ? configOptions : current.configOptions,
        capabilities: input.backend.capabilities,
        status: "idle",
        pendingPermission: null,
        lastError: null,
      }));

      if (bootstrapSystemMessages.length > 0) {
        await input.callbacks.appendEvents(
          bootstrapSystemMessages.map((text) => ({
            eventId: randomUUID(),
            conversationId: input.callbacks.conversation.id,
            kind: "system" as const,
            level: "info" as const,
            text,
          }))
        );
      }

      if (configOptions.length > 0) {
        await handle.persistConfigOptions(configOptions);
      }
      bridge.endCreationCapture(sessionId, (method, params) => {
        void handle.handleNotification(method, params);
      });
      await handle.applyConversationConfig(input.callbacks.conversation);
      return handle;
    } catch (error) {
      bridge.cancelCreationCapture();
      await release();
      throw error;
    }
  }

  async prompt(input: { text: string; userMessageId: string }): Promise<void> {
    const assistantMessageId = randomUUID();
    this.currentAssistantMessageId = assistantMessageId;
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
      lastError: null,
    }));

    try {
      const result = (await this.bridge.request("session/prompt", {
        sessionId: this.sessionId,
        messageId: input.userMessageId,
        prompt: [{ type: "text", text: input.text }],
      })) as Record<string, unknown> | undefined;

      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "assistant_message_end",
          messageId: assistantMessageId,
          stopReason:
            typeof result?.stopReason === "string"
              ? result.stopReason
              : undefined,
          raw: result,
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "idle",
          detail:
            typeof result?.stopReason === "string"
              ? `Stop reason: ${result.stopReason}`
              : undefined,
        },
      ]);

      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "idle",
        pendingPermission: null,
        lastError: null,
      }));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "ACP prompt failed.";
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "error",
          text: message,
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "failed",
          detail: message,
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "failed",
        lastError: message,
      }));
      throw error;
    }
  }

  async cancel(): Promise<void> {
    this.bridge.notify("session/cancel", { sessionId: this.sessionId });
    for (const requestId of this.pendingPermissionRequestIds.values()) {
      this.bridge.respond(requestId, {
        outcome: {
          outcome: "cancelled",
        },
      });
    }
    this.pendingPermissionRequestIds.clear();
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "cancelled",
        detail: "Prompt turn cancelled by the client.",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "idle",
      pendingPermission: null,
    }));
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    const modelOption = findPrimaryModelConfigOption(this.configOptions);
    if (
      this.backend.id === "cursor-acp" &&
      modelOption &&
      modelOption.id === configId
    ) {
      const trimmedValue = value.trim();
      if (isCursorCliModelId(trimmedValue)) {
        await this.runCursorModelSlashCommand(trimmedValue);
        await this.persistConfigOptions(
          this.configOptions.map((option) =>
            option.id === configId ? { ...option, currentValue: trimmedValue } : option
          )
        );
        return;
      }
      if (trimmedValue.includes("[")) {
        await this.bridge.request("session/set_model", {
          sessionId: this.sessionId,
          modelId: trimmedValue,
        });
        await this.persistConfigOptions(
          this.configOptions.map((option) =>
            option.id === configId ? { ...option, currentValue: trimmedValue } : option
          )
        );
        return;
      }
    }
    if (configId === LEGACY_MODE_CONFIG_ID) {
      await this.bridge.request("session/set_mode", {
        sessionId: this.sessionId,
        modeId: value,
      });
      await this.persistConfigOptions(
        this.configOptions.map((option) =>
          option.id === configId ? { ...option, currentValue: value } : option
        )
      );
      return;
    }
    if (configId === LEGACY_MODEL_CONFIG_ID) {
      await this.bridge.request("session/set_model", {
        sessionId: this.sessionId,
        modelId: value,
      });
      await this.persistConfigOptions(
        this.configOptions.map((option) =>
          option.id === configId ? { ...option, currentValue: value } : option
        )
      );
      return;
    }
    const result = (await this.bridge.request("session/set_config_option", {
      sessionId: this.sessionId,
      configId,
      value,
    })) as Record<string, unknown> | undefined;
    const parsed = mergeSessionConfigOptions(
      parseConfigOptions(result?.configOptions),
      parseLegacySessionConfigOptions(result ?? {})
    );
    if (parsed.length > 0) {
      await this.persistConfigOptions(parsed);
      return;
    }
    this.configOptions = this.configOptions.map((option) =>
      option.id === configId ? { ...option, currentValue: value } : option
    );
    await this.callbacks.updateConversation((current) => ({
      ...current,
      configOptions: this.configOptions,
    }));
  }

  async answerPermission(input: {
    requestId: string;
    optionId?: string;
    cancelled?: boolean;
  }): Promise<void> {
    const rawId = this.pendingPermissionRequestIds.get(input.requestId);
    if (rawId === undefined) {
      throw new Error(`Unknown pending permission request: ${input.requestId}`);
    }
    this.bridge.respond(rawId, {
      outcome: input.cancelled
        ? { outcome: "cancelled" }
        : {
            outcome: "selected",
            optionId: input.optionId,
          },
    });
    this.pendingPermissionRequestIds.delete(input.requestId);
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "permission_resolved",
        requestId: input.requestId,
        outcome: input.cancelled ? "cancelled" : "selected",
        optionId: input.optionId,
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "running",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
    }));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.bridge.unregister(this.sessionId);
    await this.releaseBridge();
  }

  private async persistConfigOptions(
    nextConfigOptions: AgentConfigOption[]
  ): Promise<void> {
    if (nextConfigOptions.length === 0) {
      return;
    }
    let persistedConfigOptions = nextConfigOptions;
    await this.callbacks.updateConversation((current) => {
      persistedConfigOptions =
        this.backend.id === "cursor-acp"
          ? mergeCursorSeedConfigOptions(this.seedConfigOptions, nextConfigOptions, current.config)
          : nextConfigOptions;
      this.configOptions = persistedConfigOptions;
      const modeOption = findPrimaryModeConfigOption(persistedConfigOptions);
      const modelOption = findPrimaryModelConfigOption(persistedConfigOptions);
      const modelId = modelOption?.currentValue || current.config.modelId;
      const modelName =
        modelOption?.options.find((option) => option.value === modelId)?.name ??
        current.config.modelName;
      return {
        ...current,
        configOptions: persistedConfigOptions,
        config: {
          ...current.config,
          mode: normalizeProviderMode(modeOption?.currentValue, current.config.mode),
          modelId,
          modelName,
        },
      };
    });
    await writeAgentBackendConfigCache(this.backend.id, persistedConfigOptions);
  }

  private async runCursorModelSlashCommand(modelId: string): Promise<void> {
    if (this.suppressedAssistantChunks) {
      throw new Error("Cursor model switch already in progress.");
    }
    this.suppressedAssistantChunks = [];
    try {
      await this.bridge.request("session/prompt", {
        sessionId: this.sessionId,
        messageId: `cursor-model-${randomUUID()}`,
        prompt: [{ type: "text", text: `/model ${modelId}` }],
      });
      const responseText = this.suppressedAssistantChunks.join("").trim();
      if (responseText && /unknown model|invalid model|not found|failed/i.test(responseText)) {
        throw new Error(responseText);
      }
    } finally {
      this.suppressedAssistantChunks = null;
    }
  }

  private registerBridgeHandlers(): void {
    this.bridge.register(this.sessionId, {
      onNotification: (method, params) => {
        void this.handleNotification(method, params);
      },
      onRequest: (id, method, params) => {
        void this.handleRequest(id, method, params);
      },
      onStderr: (line) => {
        void this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "system",
            level: "warning",
            text: `[${this.backend.label}] ${line}`,
          },
        ]);
      },
      onExit: (code) => {
        if (this.disposed) {
          return;
        }
        this.callbacks.markRuntimeStale?.();
        void this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "status",
            status: "interrupted",
            detail: `ACP process exited${code == null ? "" : ` with code ${code}`}.`,
          },
        ]);
        void this.callbacks.updateConversation((current) => ({
          ...current,
          status:
            current.status === "idle" || current.status === "cancelled"
              ? current.status
              : "interrupted",
        }));
      },
    });
  }

  private async applyConversationConfig(
    conversation: AgentConversationRecord
  ): Promise<void> {
    const modeOption = findPrimaryModeConfigOption(this.configOptions);
    const modelOption = findPrimaryModelConfigOption(this.configOptions);

    const nextModeValue = normalizeConversationModeForProvider(
      conversation.config.mode,
      modeOption
    );
    if (modeOption && nextModeValue && modeOption.currentValue !== nextModeValue) {
      await this.setConfigOption(modeOption.id, nextModeValue);
    }

    if (
      modelOption &&
      modelOption.options.some(
        (option) =>
          option.value === conversation.config.modelId ||
          option.name === conversation.config.modelName
      )
    ) {
      const modelValue =
        modelOption.options.find(
          (option) => option.value === conversation.config.modelId
        )?.value ??
        modelOption.options.find(
          (option) => option.name === conversation.config.modelName
        )?.value;
      if (modelValue && modelOption.currentValue !== modelValue) {
        await this.setConfigOption(modelOption.id, modelValue);
      }
    } else if (
      modelOption &&
      conversation.config.backendId === "cursor-acp" &&
      conversation.config.modelId &&
      modelOption.currentValue !== conversation.config.modelId
    ) {
      await this.setConfigOption(modelOption.id, conversation.config.modelId);
    }
  }

  private async handleNotification(
    method: string,
    params: unknown
  ): Promise<void> {
    if (method !== "session/update") {
      return;
    }
    const update = params && typeof params === "object"
      ? (params as Record<string, unknown>).update
      : null;
    if (!update || typeof update !== "object") {
      return;
    }
    const record = update as Record<string, unknown>;
    const sessionUpdate = record.sessionUpdate;
    if (typeof sessionUpdate !== "string") {
      return;
    }

    switch (sessionUpdate) {
      case "agent_message_chunk": {
        const text =
          record.content &&
          typeof record.content === "object" &&
          typeof (record.content as Record<string, unknown>).text === "string"
            ? ((record.content as Record<string, unknown>).text as string)
            : null;
        if (!text) {
          return;
        }
        if (this.suppressedAssistantChunks) {
          this.suppressedAssistantChunks.push(text);
          return;
        }
        if (!this.currentAssistantMessageId) {
          return;
        }
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "assistant_message_chunk",
            messageId: this.currentAssistantMessageId,
            text,
            raw: params,
          },
        ]);
        return;
      }
      case "tool_call": {
        const normalizedStatus = normalizeAcpToolCallStatus(record, "pending");
        const toolCallId = normalizeToolCallId(record);
        const detail = summarizeAcpToolCallDetail(record);
        const locations = extractAcpLocations(record);
        const title =
          typeof record.title === "string" &&
          record.title.trim() &&
          !isGenericAcpToolTitle(record.title)
            ? record.title
            : summarizeAcpToolCallTitle(record) ?? "Tool call";
        const toolKind =
          typeof record.kind === "string" && record.kind !== "tool"
            ? record.kind
            : inferAcpToolKindFromEntry(extractAcpToolCallPayload(record));
        if (record.subtype === "completed") {
          await this.callbacks.appendEvents([
            {
              eventId: randomUUID(),
              conversationId: this.callbacks.conversation.id,
              kind: "tool_call_update",
              toolCallId,
              title,
              toolKind,
              status: normalizedStatus,
              detail,
              locations,
              raw: params,
            },
          ]);
          return;
        }
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "tool_call",
            toolCallId,
            title,
            toolKind,
            status: normalizedStatus,
            detail,
            locations,
            raw: params,
          },
        ]);
        return;
      }
      case "tool_call_update": {
        const title =
          typeof record.title === "string" &&
          record.title.trim() &&
          !isGenericAcpToolTitle(record.title)
            ? record.title
            : summarizeAcpToolCallTitle(record);
        const toolKind =
          typeof record.kind === "string" && record.kind !== "tool"
            ? record.kind
            : inferAcpToolKindFromEntry(extractAcpToolCallPayload(record));
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "tool_call_update",
            toolCallId: normalizeToolCallId(record),
            title,
            toolKind,
            status: normalizeAcpToolCallStatus(record, "in_progress"),
            detail: summarizeAcpToolCallDetail(record),
            locations: extractAcpLocations(record),
            raw: params,
          },
        ]);
        return;
      }
      case "plan": {
        const entries: AgentPlanEntry[] = [];
        if (Array.isArray(record.entries)) {
          for (const [index, entry] of record.entries.entries()) {
            if (!entry || typeof entry !== "object") {
              continue;
            }
            const entryRecord = entry as Record<string, unknown>;
            const content =
              typeof entryRecord.content === "string" ? entryRecord.content : "";
            const status =
              entryRecord.status === "pending" ||
              entryRecord.status === "in_progress" ||
              entryRecord.status === "completed"
                ? entryRecord.status
                : "pending";
            if (!content) {
              continue;
            }
            entries.push({
              id:
                typeof entryRecord.id === "string"
                  ? entryRecord.id
                  : `${this.callbacks.conversation.id}-plan-${index}`,
              content,
              priority:
                typeof entryRecord.priority === "string"
                  ? entryRecord.priority
                  : undefined,
              status,
            });
          }
        }
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "plan",
            planId: `${this.callbacks.conversation.id}-plan`,
            entries,
            raw: params,
          },
        ]);
        return;
      }
      case "config_option_update": {
        const nextConfigOptions = mergeSessionConfigOptions(
          parseConfigOptions(record.configOptions),
          parseLegacySessionConfigOptions(record)
        );
        if (nextConfigOptions.length > 0) {
          await this.persistConfigOptions(nextConfigOptions);
        }
        return;
      }
      case "current_mode_update": {
        const modeId = parseConfigOptionString(record.modeId);
        if (!modeId) {
          return;
        }
        const nextConfigOptions = this.configOptions.map((option) =>
          option.id === LEGACY_MODE_CONFIG_ID ? { ...option, currentValue: modeId } : option
        );
        await this.persistConfigOptions(nextConfigOptions);
        return;
      }
      default:
        return;
    }
  }

  private async handleRequest(
    requestId: number | string,
    method: string,
    params: unknown
  ): Promise<void> {
    if (method === "session/request_permission") {
      const record =
        params && typeof params === "object"
          ? (params as Record<string, unknown>)
          : {};
      const requestKey = String(requestId);
      this.pendingPermissionRequestIds.set(requestKey, requestId);
      const toolCall =
        record.toolCall && typeof record.toolCall === "object"
          ? (record.toolCall as Record<string, unknown>)
          : record.tool_call && typeof record.tool_call === "object"
            ? (record.tool_call as Record<string, unknown>)
          : {};
      const toolCallId = normalizeToolCallId(toolCall);
      const summarizedToolTitle = summarizeAcpToolCallTitle(toolCall);
      const hasConcreteToolCallId = toolCallId !== "tool-call";
      let title = "Permission required";
      if (
        typeof toolCall.title === "string" &&
        !isGenericAcpToolTitle(toolCall.title)
      ) {
        title = toolCall.title;
      } else if (summarizedToolTitle) {
        title = `Permission required for ${summarizedToolTitle}`;
      } else if (hasConcreteToolCallId) {
        title = `Permission required for ${toolCallId}`;
      }
      const detail = extractPermissionRequestDetail(record, toolCall);
      const options =
        parsePermissionOptions(
        Array.isArray(record.options)
          ? record.options
          : Array.isArray(record.choices)
            ? record.choices
            : Array.isArray(record.actions)
              ? record.actions
              : Array.isArray(record.permissions)
                ? record.permissions
                : []
        ) || [];
      const normalizedOptions =
        options.length > 0 ? options : buildFallbackPermissionOptions(this.backend.id);
      const statusDetail = detail ? `${title} — ${detail}` : title;
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "permission_request",
          requestId: requestKey,
          title,
          detail,
          toolCallId: hasConcreteToolCallId ? toolCallId : undefined,
          options: normalizedOptions,
          raw: params,
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "awaiting_permission",
          detail: statusDetail,
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "awaiting_permission",
        pendingPermission: {
          requestId: requestKey,
          requestedAt: Date.now(),
          title,
          detail,
          toolCallId: hasConcreteToolCallId ? toolCallId : undefined,
          options: normalizedOptions,
        },
      }));
      return;
    }

    const paramsRecord =
      params && typeof params === "object"
        ? (params as Record<string, unknown>)
        : {};
    if (method === "cursor/update_todos") {
      const todos = Array.isArray(paramsRecord.todos)
        ? paramsRecord.todos
        : Array.isArray(paramsRecord.items)
          ? paramsRecord.items
          : [];
      const entries: AgentPlanEntry[] = [];
      for (const [index, todo] of todos.entries()) {
        if (!todo || typeof todo !== "object") {
          continue;
        }
        const todoRecord = todo as Record<string, unknown>;
        const content =
          typeof todoRecord.content === "string"
            ? todoRecord.content
            : typeof todoRecord.text === "string"
              ? todoRecord.text
              : "";
        const status =
          todoRecord.status === "pending" ||
          todoRecord.status === "in_progress" ||
          todoRecord.status === "completed"
            ? todoRecord.status
            : "pending";
        if (!content) {
          continue;
        }
        entries.push({
          id:
            typeof todoRecord.id === "string"
              ? todoRecord.id
              : `${this.callbacks.conversation.id}-todo-${index}`,
          content,
          status,
        });
      }
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "plan",
          planId: `${this.callbacks.conversation.id}-todos`,
          entries,
          raw: params,
        },
      ]);
      this.bridge.respond(requestId, {});
      return;
    }

    if (method === "cursor/task" || method === "cursor/generate_image") {
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "info",
          text: `${method} extension event received.`,
          raw: params,
        },
      ]);
      this.bridge.respond(requestId, {});
      return;
    }

    if (method === "cursor/create_plan" || method === "cursor/ask_question") {
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "warning",
          text: `${method} is not fully interactive yet; applying fallback response.`,
          raw: params,
        },
      ]);
      this.bridge.respond(requestId, {});
      return;
    }

    this.bridge.respond(requestId, {});
  }
}

export async function createAgentProvider(
  backendId: AgentBackendId
): Promise<AgentProvider> {
  const backend = AGENT_BACKENDS[backendId];
  if (!backend) {
    throw new Error(`Unknown backend: ${backendId}`);
  }

  if (backendId === "cursor-acp") {
    if (!CURSOR_RUNTIME) {
      throw new Error(`${backend.label} is not installed or could not be resolved.`);
    }
    const cursorSeedConfigOptions = await readAgentBackendConfigCache(backendId);
    return {
      backend,
      startSession(callbacks) {
        return AcpSessionHandle.create({
          backend,
          command: CURSOR_RUNTIME.command,
          args: CURSOR_RUNTIME.args,
          env: CURSOR_RUNTIME.env,
          callbacks,
          seedConfigOptions: cursorSeedConfigOptions,
        });
      },
      loadSession(callbacks, providerSessionId) {
        return AcpSessionHandle.create({
          backend,
          command: CURSOR_RUNTIME.command,
          args: CURSOR_RUNTIME.args,
          env: CURSOR_RUNTIME.env,
          callbacks,
          loadSessionId: providerSessionId,
          seedConfigOptions: cursorSeedConfigOptions,
        });
      },
    };
  }

  if (backendId === "opencode-acp" || backendId === "gemini-adapter") {
    const resolvedRuntime = backendId === "gemini-adapter" ? GEMINI_RUNTIME : OPENCODE_RUNTIME;
    if (!resolvedRuntime) {
      throw new Error(`${backend.label} is not installed or could not be resolved.`);
    }
    return {
      backend,
      startSession(callbacks) {
        return AcpSessionHandle.create({
          backend,
          command: resolvedRuntime.command,
          args: resolvedRuntime.args,
          env: resolvedRuntime.env,
          callbacks,
        });
      },
      loadSession(callbacks, providerSessionId) {
        return AcpSessionHandle.create({
          backend,
          command: resolvedRuntime.command,
          args: resolvedRuntime.args,
          env: resolvedRuntime.env,
          callbacks,
          loadSessionId: providerSessionId,
        });
      },
    };
  }

  if (backendId === "codex-adapter") {
    if (!CODEX_RUNTIME) {
      throw new Error(`${backend.label} is not installed or could not be resolved.`);
    }
    return createCodexAdapterProvider({
      backend,
      runtime: CODEX_RUNTIME,
      configOptions: await readAgentBackendConfigCache(backendId),
      capabilities: basicCliCapabilities,
    });
  }

  if (backendId === "claude-adapter") {
    if (!CLAUDE_RUNTIME) {
      throw new Error(`${backend.label} is not installed or could not be resolved.`);
    }
    return createClaudeAdapterProvider({
      backend,
      runtime: CLAUDE_RUNTIME,
      configOptions: await readAgentBackendConfigCache(backendId),
      capabilities: basicCliCapabilities,
    });
  }

  throw new Error(`${backend.label} is not implemented yet.`);
}
