import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { AcpStdioClient } from "./acp-transport.js";
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
} from "./types.js";
import { createUnavailableCapabilities } from "./types.js";
import {
  configOptionMatchesCategory,
  findPrimaryModelConfigOption,
  findPrimaryModeConfigOption,
} from "./config-option-utils.js";

type AcpRuntimeSpec = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  commandPreview: string;
};

const cursorCapabilities: AgentProviderCapabilities = {
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

const LEGACY_MODE_CONFIG_ID = "__acp_legacy_mode__";
const LEGACY_MODEL_CONFIG_ID = "__acp_legacy_model__";

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

function resolveLatestCursorVersionDir(baseDir: string): string | null {
  try {
    const entries = readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => /^\d{4}\.\d{1,2}\.\d{1,2}-[a-f0-9]+$/u.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (entries.length === 0) {
      return null;
    }
    return path.join(baseDir, entries[0]!);
  } catch {
    return null;
  }
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

function resolveCursorAcpRuntime(): AcpRuntimeSpec | null {
  const envOverrides = {
    ...process.env,
    CURSOR_INVOKED_AS: process.env.CURSOR_INVOKED_AS || "agent.cmd",
  };
  const configured = resolveConfiguredRuntime(
    process.env.OPENCURSOR_CURSOR_ACP_BIN,
    ["acp"],
    envOverrides
  );
  if (configured) {
    return configured;
  }

  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (localAppData) {
    const cursorRoot = path.join(localAppData, "cursor-agent");
    const latestVersion = resolveLatestCursorVersionDir(path.join(cursorRoot, "versions"));
    if (latestVersion) {
      const nodePath = path.join(latestVersion, "node.exe");
      const indexPath = path.join(latestVersion, "index.js");
      if (fileExists(nodePath) && fileExists(indexPath)) {
        return {
          command: nodePath,
          args: [indexPath, "acp"],
          env: envOverrides,
          commandPreview: [
            quotePreview(nodePath),
            quotePreview(indexPath),
            "acp",
          ].join(" "),
        };
      }
    }

    const cmdWrapper = path.join(cursorRoot, "agent.cmd");
    if (fileExists(cmdWrapper)) {
      return buildInvocation(cmdWrapper, ["acp"], envOverrides);
    }
  }

  const pathHit = findExecutableOnPath(
    process.platform === "win32"
      ? ["agent.exe", "agent.cmd", "cursor-agent.cmd", "agent"]
      : ["agent"]
  );
  if (pathHit) {
    return buildInvocation(pathHit, ["acp"], envOverrides);
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

const CURSOR_RUNTIME = resolveCursorAcpRuntime();
const OPENCODE_RUNTIME = resolveOpenCodeAcpRuntime();

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
    label: "Cursor ACP",
    description: "Cursor Agent CLI over ACP stdio.",
    commandPreview: CURSOR_RUNTIME?.commandPreview ?? "Cursor CLI not found",
    available: CURSOR_RUNTIME !== null,
    capabilities: cursorCapabilities,
    defaultMode: "agent",
    defaultModelId: "auto",
    defaultModelName: "Auto",
  }),
  "opencode-acp": createBackendInfo({
    id: "opencode-acp",
    label: "OpenCode ACP",
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
    label: "Codex adapter",
    description: "Reserved for experimental Codex ACP adapter work.",
    experimental: true,
    available: false,
    capabilities: createUnavailableCapabilities(),
    defaultMode: "agent",
    defaultModelId: "codex",
    defaultModelName: "Codex",
  }),
  "claude-adapter": createBackendInfo({
    id: "claude-adapter",
    label: "Claude adapter",
    description: "Reserved for experimental Claude Code ACP adapter work.",
    experimental: true,
    available: false,
    capabilities: createUnavailableCapabilities(),
    defaultMode: "agent",
    defaultModelId: "claude",
    defaultModelName: "Claude",
  }),
};

export function listAgentBackends(): AgentBackendInfo[] {
  return Object.values(AGENT_BACKENDS);
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
  if (option.options.some((value) => value.value === requested)) {
    return requested;
  }
  const rawCandidates =
    requested === "agent" || requested === "code"
      ? ["agent", "code", "build"]
      : requested === "plan"
        ? ["plan", "architect"]
        : requested === "ask"
          ? ["ask", "review", "readonly", "read-only"]
          : requested === "debug"
            ? ["debug", "build", "agent", "code"]
            : [requested];
  const available = new Set(option.options.map((value) => value.value));
  for (const candidate of rawCandidates) {
    if (available.has(candidate)) {
      return candidate;
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
  if (record.content && typeof record.content === "object") {
    const content = record.content as Record<string, unknown>;
    if (typeof content.text === "string" && content.text.trim()) {
      return content.text.trim();
    }
  }
  if (typeof record.text === "string" && record.text.trim()) {
    return record.text.trim();
  }
  return undefined;
}

function parsePermissionOptions(raw: unknown): AgentPermissionOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      const optionId =
        typeof record.optionId === "string" ? record.optionId : undefined;
      const name = typeof record.name === "string" ? record.name : optionId;
      const kind = record.kind;
      if (
        !optionId ||
        !name ||
        (kind !== "allow_once" &&
          kind !== "allow_always" &&
          kind !== "reject_once" &&
          kind !== "reject_always")
      ) {
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

function normalizeToolCallId(record: Record<string, unknown>): string {
  if (typeof record.toolCallId === "string" && record.toolCallId.trim()) {
    return record.toolCallId;
  }
  if (typeof record.id === "string" && record.id.trim()) {
    return record.id;
  }
  if (typeof record.title === "string" && record.title.trim()) {
    return `tool-${record.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  }
  return "tool-call";
}

class AcpSessionHandle implements AgentSessionHandle {
  readonly sessionId: string;
  configOptions: AgentConfigOption[];
  capabilities: AgentProviderCapabilities;

  private readonly pendingPermissionRequestIds = new Map<string, number | string>();
  private currentAssistantMessageId: string | null = null;
  private disposed = false;
  private readonly transport: AcpStdioClient;
  private readonly callbacks: AgentRuntimeCallbacks;
  private readonly backend: AgentBackendInfo;

  private constructor(input: {
    transport: AcpStdioClient;
    callbacks: AgentRuntimeCallbacks;
    backend: AgentBackendInfo;
    sessionId: string;
    configOptions: AgentConfigOption[];
    capabilities: AgentProviderCapabilities;
  }) {
    this.transport = input.transport;
    this.callbacks = input.callbacks;
    this.backend = input.backend;
    this.sessionId = input.sessionId;
    this.configOptions = input.configOptions;
    this.capabilities = input.capabilities;
    this.bindIncomingMessages();
  }

  static async create(input: {
    backend: AgentBackendInfo;
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    callbacks: AgentRuntimeCallbacks;
    loadSessionId?: string | null;
  }): Promise<AcpSessionHandle> {
    const transport = await AcpStdioClient.spawn({
      command: input.command,
      args: input.args,
      cwd: input.callbacks.workspace.root,
      env: input.env ?? process.env,
    });
    const bufferedConfigNotifications: Array<{
      method: string;
      params?: unknown;
    }> = [];
    const disposeBufferedNotifications = transport.onNotification((notification) => {
      if (notification.method !== "session/update") {
        return;
      }
      const update =
        notification.params && typeof notification.params === "object"
          ? (notification.params as Record<string, unknown>).update
          : null;
      if (
        update &&
        typeof update === "object" &&
        ((update as Record<string, unknown>).sessionUpdate === "config_option_update" ||
          (update as Record<string, unknown>).sessionUpdate === "current_mode_update")
      ) {
        bufferedConfigNotifications.push(notification);
      }
    });
    try {
      const init = (await transport.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: "opencursor-server",
        title: "OpenCursor Server",
        version: "0.1.0",
      },
      })) as Record<string, unknown> | undefined;

      const authMethods = Array.isArray(init?.authMethods)
        ? init?.authMethods
        : [];
      const authMethodIds = authMethods
        .map((entry) =>
          entry && typeof entry === "object"
            ? (entry as Record<string, unknown>).id
            : entry
        )
        .filter((value): value is string => typeof value === "string");
      if (authMethodIds.includes("cursor_login")) {
        await transport.request("authenticate", { methodId: "cursor_login" });
      }

      const openResult = (await transport.request(
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
      disposeBufferedNotifications();
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

      const configOptions = mergeSessionConfigOptions(
        parseConfigOptions(openResultRecord.configOptions),
        parseLegacySessionConfigOptions(openResultRecord)
      );
      const handle = new AcpSessionHandle({
        transport,
        callbacks: input.callbacks,
        backend: input.backend,
        sessionId,
        configOptions,
        capabilities: input.backend.capabilities,
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

      if (configOptions.length > 0) {
        await handle.persistConfigOptions(configOptions);
      }
      for (const notification of bufferedConfigNotifications) {
        await handle.handleNotification(notification.method, notification.params);
      }
      await handle.applyConversationConfig(input.callbacks.conversation);
      return handle;
    } catch (error) {
      disposeBufferedNotifications();
      await transport.close().catch(() => undefined);
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
      const result = (await this.transport.request("session/prompt", {
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
    this.transport.notify("session/cancel", { sessionId: this.sessionId });
    for (const requestId of this.pendingPermissionRequestIds.values()) {
      this.transport.respond(requestId, {
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
    if (configId === LEGACY_MODE_CONFIG_ID) {
      await this.transport.request("session/set_mode", {
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
      await this.transport.request("session/set_model", {
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
    const result = (await this.transport.request("session/set_config_option", {
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
    this.transport.respond(rawId, {
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
    await this.transport.close();
  }

  private async persistConfigOptions(
    nextConfigOptions: AgentConfigOption[]
  ): Promise<void> {
    if (nextConfigOptions.length === 0) {
      return;
    }
    this.configOptions = nextConfigOptions;
    await this.callbacks.updateConversation((current) => {
      const modeOption = findPrimaryModeConfigOption(nextConfigOptions);
      const modelOption = findPrimaryModelConfigOption(nextConfigOptions);
      const modelId = modelOption?.currentValue || current.config.modelId;
      const modelName =
        modelOption?.options.find((option) => option.value === modelId)?.name ??
        current.config.modelName;
      return {
        ...current,
        configOptions: nextConfigOptions,
        config: {
          ...current.config,
          mode: normalizeProviderMode(modeOption?.currentValue, current.config.mode),
          modelId,
          modelName,
        },
      };
    });
  }

  private bindIncomingMessages(): void {
    this.transport.onNotification((notification) => {
      void this.handleNotification(notification.method, notification.params);
    });
    this.transport.onRequest((request) => {
      void this.handleRequest(request.id, request.method, request.params);
    });
    this.transport.onStderr((line) => {
      void this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "warning",
          text: `[${this.backend.label}] ${line}`,
        },
      ]);
    });
    this.transport.onExit((code) => {
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
        if (!text || !this.currentAssistantMessageId) {
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
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "tool_call",
            toolCallId: normalizeToolCallId(record),
            title:
              typeof record.title === "string"
                ? record.title
                : "Tool call",
            toolKind:
              typeof record.kind === "string" ? record.kind : "tool",
            status:
              record.status === "pending" ||
              record.status === "in_progress" ||
              record.status === "completed" ||
              record.status === "failed" ||
              record.status === "cancelled"
                ? record.status
                : "pending",
            detail: summarizeToolContent(record.content),
            locations: Array.isArray(record.locations)
              ? (() => {
                  const locations: { path: string; line?: number }[] = [];
                  for (const location of record.locations) {
                    if (!location || typeof location !== "object") {
                      continue;
                    }
                    const locationRecord = location as Record<string, unknown>;
                    if (typeof locationRecord.path !== "string") {
                      continue;
                    }
                    locations.push({
                      path: locationRecord.path,
                      line:
                        typeof locationRecord.line === "number"
                          ? locationRecord.line
                          : undefined,
                    });
                  }
                  return locations;
                })()
              : undefined,
            raw: params,
          },
        ]);
        return;
      }
      case "tool_call_update": {
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "tool_call_update",
            toolCallId: normalizeToolCallId(record),
            status:
              record.status === "pending" ||
              record.status === "in_progress" ||
              record.status === "completed" ||
              record.status === "failed" ||
              record.status === "cancelled"
                ? record.status
                : "in_progress",
            detail: summarizeToolContent(record.content),
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
          : {};
      const title =
        typeof toolCall.title === "string"
          ? toolCall.title
          : typeof toolCall.toolCallId === "string"
            ? `Permission required for ${toolCall.toolCallId}`
            : "Permission required";
      const options = parsePermissionOptions(record.options);
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "permission_request",
          requestId: requestKey,
          title,
          toolCallId:
            typeof toolCall.toolCallId === "string"
              ? toolCall.toolCallId
              : undefined,
          options,
          raw: params,
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "awaiting_permission",
          detail: title,
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "awaiting_permission",
        pendingPermission: {
          requestId: requestKey,
          requestedAt: Date.now(),
          title,
          toolCallId:
            typeof toolCall.toolCallId === "string"
              ? toolCall.toolCallId
              : undefined,
          options,
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
      this.transport.respond(requestId, {});
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
      this.transport.respond(requestId, {});
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
      this.transport.respond(requestId, {});
      return;
    }

    this.transport.respond(requestId, {});
  }
}

export async function createAgentProvider(
  backendId: AgentBackendId
): Promise<AgentProvider> {
  const backend = AGENT_BACKENDS[backendId];
  if (!backend) {
    throw new Error(`Unknown backend: ${backendId}`);
  }

  if (backendId === "cursor-acp" || backendId === "opencode-acp") {
    const runtime = backendId === "cursor-acp" ? CURSOR_RUNTIME : OPENCODE_RUNTIME;
    if (!runtime) {
      throw new Error(`${backend.label} is not installed or could not be resolved.`);
    }
    return {
      backend,
      startSession(callbacks) {
        return AcpSessionHandle.create({
          backend,
          command: runtime.command,
          args: runtime.args,
          env: runtime.env,
          callbacks,
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
        });
      },
    };
  }

  throw new Error(
    `${backend.label} is an experimental placeholder and is not implemented yet.`
  );
}
