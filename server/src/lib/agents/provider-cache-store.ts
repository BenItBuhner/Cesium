import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { readJsonFile } from "../persistence.js";
import { getStorage } from "../../storage/runtime.js";
import { getCursorSdkApiKey } from "../cursor-sdk-credentials.js";
import {
  getClaudeCodeSdkProxyModel,
  getClaudeCodeSdkProxyModelName,
  hasClaudeCodeSdkAuthConfig,
  hasClaudeCodeSdkProxyConfig,
} from "../claude-code-sdk-credentials.js";
import { spawnSafeEnv } from "./spawn-env.js";
import { CodexAppServerTransport } from "./codex-app-server-transport.js";
import { OpenCodeServerClient, openCodeServerAuthFromEnv } from "./opencode-server-client.js";
import { encodeCursorSdkModelValue, type CursorSdkModelParam } from "./cursor-sdk-model-selection.js";
import type { AgentBackendId, AgentConfigOption, AgentConfigOptionValue } from "./types.js";

type AgentBackendCacheRecord = {
  schemaVersion: 1;
  backendId: AgentBackendId;
  updatedAt: number;
  configOptions: AgentConfigOption[];
};

type CommandInvocation = {
  command: string;
  args: string[];
};

const CACHE_TTL_MS = 5 * 60 * 1000;

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
}

async function execFileText(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options?.cwd,
        env: spawnSafeEnv(options?.env),
        maxBuffer: 1024 * 1024 * 8,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(`${stdout}${stderr}`);
      }
    );
  });
}

function resolveCursorCliInvocation(inputCommand?: string): CommandInvocation {
  const explicitCommand = inputCommand?.trim() || process.env.OPENCURSOR_CURSOR_CLI_BIN?.trim();
  if (explicitCommand) {
    return { command: explicitCommand, args: ["--list-models"] };
  }
  if (process.platform !== "win32") {
    return { command: "agent", args: ["--list-models"] };
  }

  const localAppData = process.env.LOCALAPPDATA?.trim();
  const systemRoot = process.env.SystemRoot?.trim() || "C:\\Windows";
  if (localAppData) {
    const cursorAgentScript = path.join(localAppData, "cursor-agent", "agent.ps1");
    return {
      command: path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        cursorAgentScript,
        "--list-models",
      ],
    };
  }
  return { command: "agent", args: ["--list-models"] };
}

function formatCursorCliModelDisplayName(value: string, cliParsedName: string): string {
  const name = cliParsedName.trim();
  const v = value.trim();
  if (name.length > 0 && name !== v && (/[A-Z]/.test(name) || name.includes(" "))) {
    return name;
  }
  return v
    .split("/")
    .map((segment) =>
      segment
        .replace(/[._-]+/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => {
          const lower = word.toLowerCase();
          if (lower === "gpt") return "GPT";
          if (lower === "api") return "API";
          if (/^o\d+/i.test(word)) return word.toUpperCase();
          if (/^\d+(\.\d+)?$/.test(word)) return word;
          if (word.length <= 4 && word === word.toUpperCase()) return word;
          return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        })
        .join(" ")
    )
    .join(" · ");
}

/**
 * The modern Cursor CLI (`agent --list-models`) emits one fully baked variant per
 * line — `gpt-5.4-xhigh-fast - GPT-5.4 Extra High Fast  (current)`. Each effort /
 * context / fast / thinking combination is a standalone model id, so there is no
 * cross-product to do on our side: we surface exactly what the CLI gives us and
 * let the user pick a concrete variant row. The old bracketed format (with per-
 * model knob metadata + a synthetic reasoning-effort dropdown) would double-
 * explode these rows and is no longer in use.
 */
export async function createCursorCliConfigOptions(input?: {
  command?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<AgentConfigOption[]> {
  const invocation = resolveCursorCliInvocation(input?.command);
  const raw = await execFileText(invocation.command, invocation.args, {
    cwd: input?.cwd,
    env: input?.env,
  }).catch(() => "");
  const cleaned = stripAnsi(raw);
  const options: AgentConfigOption["options"] = [];
  let currentValue: string | null = null;
  let defaultValue: string | null = null;

  for (const line of cleaned.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /^tip:/i.test(trimmed) || /^available models$/i.test(trimmed)) {
      continue;
    }
    const match = /^(\S+)\s+-\s+(.+?)(?:\s{2,}\(([^)]+)\))?$/.exec(trimmed);
    if (!match) {
      continue;
    }
    const value = (match[1] ?? "").trim();
    const name = (match[2] ?? "").trim();
    const flags = (match[3] ?? "").toLowerCase();
    if (!value || !name) {
      continue;
    }
    if (flags.includes("current")) {
      currentValue = value;
    } else if (flags.includes("default") && !defaultValue) {
      defaultValue = value;
    }
    options.push({
      value,
      name: formatCursorCliModelDisplayName(value, name),
    });
  }

  if (options.length === 0) {
    return [];
  }

  const resolvedCurrent =
    currentValue ??
    defaultValue ??
    options.find((o) => o.value === "auto")?.value ??
    options[0]?.value ??
    "auto";

  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "agent",
      options: [
        { value: "agent", name: "Agent" },
        { value: "plan", name: "Plan" },
        { value: "ask", name: "Ask" },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: resolvedCurrent,
      options,
    },
  ];
}

async function createOpenCodeCliConfigOptions(input?: {
  command?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<AgentConfigOption[]> {
  const command =
    input?.command ?? process.env.OPENCURSOR_OPENCODE_ACP_BIN ?? "opencode";
  const raw = await execFileText(command, ["models", "--verbose"], {
    cwd: input?.cwd,
    env: input?.env,
  }).catch(() => "");
  const lines = raw.split("\n");
  const options: AgentConfigOption["options"] = [];
  const formatProviderName = (value: string) => {
    const provider = value.split("/")[0]?.trim() ?? "";
    return provider
      .split(/[-_]+/)
      .filter(Boolean)
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join(" ");
  };

  for (let index = 0; index < lines.length; ) {
    const value = stripAnsi(lines[index] ?? "").trim();
    if (!value) {
      index += 1;
      continue;
    }
    if (stripAnsi(lines[index + 1] ?? "").trim() !== "{") {
      index += 1;
      continue;
    }

    const jsonLines: string[] = [];
    let depth = 0;
    for (index += 1; index < lines.length; index += 1) {
      const line = stripAnsi(lines[index] ?? "");
      jsonLines.push(line);
      depth += (line.match(/\{/g) ?? []).length;
      depth -= (line.match(/\}/g) ?? []).length;
      if (depth === 0) {
        index += 1;
        break;
      }
    }

    let record: Record<string, unknown> | null = null;
    try {
      record = JSON.parse(jsonLines.join("\n")) as Record<string, unknown>;
    } catch {
      record = null;
    }

    const baseName =
      typeof record?.name === "string" && record.name.trim()
        ? `${formatProviderName(value)}/${record.name.trim()}`
        : value;
    options.push({ value, name: baseName });

    const variants =
      record?.variants && typeof record.variants === "object" && !Array.isArray(record.variants)
        ? Object.keys(record.variants as Record<string, unknown>)
        : [];
    for (const variant of variants) {
      const trimmedVariant = variant.trim();
      if (!trimmedVariant) {
        continue;
      }
      options.push({
        value: `${value}/${trimmedVariant}`,
        name: `${baseName} (${trimmedVariant})`,
      });
    }
  }

  if (options.length === 0) {
    return [];
  }

  return [
    {
      id: "mode",
      name: "Session Mode",
      category: "mode",
      currentValue: "build",
      options: [
        { value: "build", name: "build" },
        { value: "plan", name: "plan" },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: options[0]?.value ?? "",
      options,
    },
  ];
}

function collectOpenCodeServerModelOptions(payload: unknown): AgentConfigOption["options"] {
  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
  const providers = Array.isArray(record.providers)
    ? record.providers
    : Array.isArray(record.all)
      ? record.all
      : [];
  const options: AgentConfigOption["options"] = [];
  for (const provider of providers) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
      continue;
    }
    const p = provider as Record<string, unknown>;
    const providerId =
      typeof p.id === "string"
        ? p.id
        : typeof p.providerID === "string"
          ? p.providerID
          : typeof p.name === "string"
            ? p.name
            : "";
    const providerName =
      typeof p.name === "string" && p.name.trim() ? p.name : providerId;
    const models =
      p.models && typeof p.models === "object" && !Array.isArray(p.models)
        ? Object.entries(p.models as Record<string, unknown>)
        : Array.isArray(p.models)
          ? p.models.map((model) => {
              const m = model && typeof model === "object" && !Array.isArray(model)
                ? (model as Record<string, unknown>)
                : {};
              const id = typeof m.id === "string" ? m.id : typeof m.modelID === "string" ? m.modelID : "";
              return [id, m] as const;
            })
          : [];
    for (const [modelId, model] of models) {
      if (!providerId || !modelId) {
        continue;
      }
      const modelRecord = model && typeof model === "object" && !Array.isArray(model)
        ? (model as Record<string, unknown>)
        : {};
      const modelName =
        typeof modelRecord.name === "string" && modelRecord.name.trim()
          ? modelRecord.name
          : modelId;
      options.push({
        value: `${providerId}/${modelId}`,
        name: `${providerName}/${modelName}`,
      });
    }
  }
  return options;
}

function collectOpenCodeServerAgentOptions(payload: unknown): AgentConfigOption["options"] {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).data)
      ? ((payload as Record<string, unknown>).data as unknown[])
      : [];
  const options = list.flatMap((entry) => {
    const record = entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)
      : {};
    const value =
      typeof record.name === "string"
        ? record.name
        : typeof record.id === "string"
          ? record.id
          : "";
    if (!value) {
      return [];
    }
    return [{ value, name: typeof record.name === "string" ? record.name : value }];
  });
  return options.length > 0 ? options : [{ value: "build", name: "build" }, { value: "plan", name: "plan" }];
}

async function createOpenCodeServerConfigOptions(): Promise<AgentConfigOption[]> {
  const baseUrl = process.env.OPENCURSOR_OPENCODE_SERVER_URL?.trim();
  if (!baseUrl) {
    return createOpenCodeCliConfigOptions();
  }
  try {
    const client = new OpenCodeServerClient({ baseUrl, ...openCodeServerAuthFromEnv(), timeoutMs: 10_000 });
    const [providers, provider, agents] = await Promise.all([
      client.request("/config/providers").catch(() => null),
      client.request("/provider").catch(() => null),
      client.request("/agent").catch(() => null),
    ]);
    const modelOptions = [
      ...collectOpenCodeServerModelOptions(providers),
      ...collectOpenCodeServerModelOptions(provider),
    ];
    const uniqueModels = Array.from(
      new Map(modelOptions.map((option) => [option.value, option])).values()
    );
    const agentOptions = collectOpenCodeServerAgentOptions(agents);
    return [
      {
        id: "agent",
        name: "Agent",
        category: "mode",
        currentValue: agentOptions[0]?.value ?? "build",
        options: agentOptions,
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        currentValue: uniqueModels[0]?.value ?? "auto",
        options: uniqueModels.length > 0 ? uniqueModels : [{ value: "auto", name: "Auto" }],
      },
    ];
  } catch {
    return createOpenCodeCliConfigOptions();
  }
}

/**
 * Seed model dropdown for Gemini CLI before the first ACP session lists options.
 * Values follow Gemini CLI model aliases and common model ids (see Gemini CLI docs).
 */
async function createGeminiCliConfigOptions(input?: {
  command?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<AgentConfigOption[]> {
  void input;
  const modelOptions: AgentConfigOption["options"] = [
    { value: "auto", name: "Auto" },
    { value: "pro", name: "Pro" },
    { value: "flash", name: "Flash" },
    { value: "flash-lite", name: "Flash Lite" },
    { value: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { value: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { value: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite" },
  ];
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "agent",
      options: [{ value: "agent", name: "Agent" }],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "auto",
      options: modelOptions,
    },
  ];
}

function parseTomlValue(source: string, key: string): string | null {
  const match = source.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"));
  return match?.[1] ?? null;
}

async function createCodexSeedConfigOptions(): Promise<AgentConfigOption[]> {
  const codexHome = path.join(os.homedir(), ".codex");
  const [modelsCache, configToml] = await Promise.all([
    readJsonFile<{ models?: Array<Record<string, unknown>> } | null>(
      path.join(codexHome, "models_cache.json"),
      null
    ),
    fs.readFile(path.join(codexHome, "config.toml"), "utf8").catch(() => ""),
  ]);

  const modelOptions: AgentConfigOption["options"] = [];
  if (Array.isArray(modelsCache?.models)) {
    for (const entry of modelsCache.models) {
      const slug = typeof entry.slug === "string" ? entry.slug : "";
      const name = typeof entry.display_name === "string" ? entry.display_name : slug;
      const description = typeof entry.description === "string" ? entry.description : undefined;
      if (!slug || !name) {
        continue;
      }
      modelOptions.push({ value: slug, name, description });
    }
  }

  if (Array.isArray(modelsCache?.models)) {
    for (const option of modelOptions) {
      const entry = modelsCache.models.find(
        (candidate) => candidate && typeof candidate === "object" && candidate.slug === option.value
      ) as Record<string, unknown> | undefined;
      const reasoningLevels = Array.isArray(entry?.supported_reasoning_levels)
        ? entry.supported_reasoning_levels
            .map((level) =>
              level && typeof level === "object" && typeof level.effort === "string"
                ? level.effort
                : null
            )
            .filter((value): value is string => Boolean(value))
        : [];
      if (reasoningLevels.length > 0) {
        option.metadata = {
          reasoningLevels,
        };
      }
    }
  }

  const reasoningOptions = Array.isArray(modelsCache?.models)
    ? Array.from(
        new Set(
          modelsCache.models.flatMap((entry) => {
            const levels = Array.isArray(entry.supported_reasoning_levels)
              ? entry.supported_reasoning_levels
              : [];
            return levels
              .map((level) =>
                level && typeof level === "object" && typeof level.effort === "string"
                  ? level.effort
                  : null
              )
              .filter((value): value is string => Boolean(value));
          })
        )
      ).map((effort) => ({
        value: effort,
        name: effort.charAt(0).toUpperCase() + effort.slice(1),
      }))
    : [];

  if (modelOptions.length === 0) {
    return [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        currentValue: "agent",
        options: [{ value: "agent", name: "Agent" }],
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "__default__",
        options: [
          {
            value: "__default__",
            name: "Default",
            description: "Use the Codex CLI default model selection.",
          },
        ],
      },
    ];
  }

  const preferredModel = modelOptions.find((option) => option.value === "gpt-5.4-mini")?.value;
  const preferredEffort = reasoningOptions.find((option) => option.value === "low")?.value;
  const selectedModel = preferredModel ?? parseTomlValue(configToml, "model") ?? modelOptions[0]?.value ?? "gpt-5.4-mini";
  const selectedEffort =
    preferredEffort ??
    parseTomlValue(configToml, "model_reasoning_effort") ??
    reasoningOptions[0]?.value ??
    "low";
  const selectedWebSearch = parseTomlValue(configToml, "web_search") ?? "cached";

  const next: AgentConfigOption[] = [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "agent",
      options: [{ value: "agent", name: "Agent" }],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: selectedModel,
      options: modelOptions,
    },
    {
      id: "permission",
      name: "Execution Mode",
      category: "permission",
      currentValue: "workspace-write",
      options: [
        { value: "read-only", name: "Read Only" },
        { value: "workspace-write", name: "Workspace Write" },
        { value: "bypassPermissions", name: "Bypass Permissions" },
      ],
    },
    {
      id: "web_search",
      name: "Web Search",
      category: "other",
      currentValue: selectedWebSearch,
      options: [
        { value: "disabled", name: "Disabled" },
        { value: "cached", name: "Cached" },
        { value: "live", name: "Live" },
      ],
    },
  ];

  if (reasoningOptions.length > 0) {
    next.push({
      id: "model_reasoning_effort",
      name: "Reasoning Effort",
      category: "thought_level",
      currentValue: selectedEffort,
      options: reasoningOptions,
    });
  }

  return next;
}

function titleCaseConfigValue(value: string): string {
  if (/^xhigh$/i.test(value)) {
    return "Extra High";
  }
  return value
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function createCodexAppServerFallbackConfigOptions(): AgentConfigOption[] {
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "agent",
      options: [
        { value: "agent", name: "Agent" },
        { value: "plan", name: "Plan" },
        { value: "ask", name: "Ask" },
        { value: "debug", name: "Debug" },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "__default__",
      options: [],
    },
    {
      id: "permission",
      name: "Execution Mode",
      category: "permission",
      currentValue: "workspace-write",
      options: [
        { value: "read-only", name: "Read Only" },
        { value: "workspace-write", name: "Workspace Write" },
        { value: "on-request", name: "Ask Every Time" },
        {
          value: "bypassPermissions",
          name: "Bypass Permissions",
          description: "Requires OPENCURSOR_CODEX_APP_SERVER_ALLOW_BYPASS=1.",
        },
      ],
    },
  ];
}

function codexAppServerEffortValues(entry: Record<string, unknown>): string[] {
  const raw = Array.isArray(entry.supportedReasoningEfforts)
    ? entry.supportedReasoningEfforts
    : [];
  return raw
    .map((effort) => {
      if (typeof effort === "string") {
        return effort;
      }
      const record =
        effort && typeof effort === "object" && !Array.isArray(effort)
          ? (effort as Record<string, unknown>)
          : null;
      return typeof record?.reasoningEffort === "string" ? record.reasoningEffort : "";
    })
    .filter(Boolean);
}

function codexAppServerOptionsFromModels(
  models: Array<Record<string, unknown>>
): AgentConfigOption[] {
  const modelOptions: AgentConfigOptionValue[] = models
    .map((entry) => {
      const value =
        typeof entry.id === "string"
          ? entry.id
          : typeof entry.model === "string"
            ? entry.model
            : "";
      const name =
        typeof entry.displayName === "string" && entry.displayName.trim()
          ? entry.displayName
          : value;
      if (!value || !name) {
        return null;
      }
      const reasoningLevels = codexAppServerEffortValues(entry);
      return {
        value,
        name,
        metadata: reasoningLevels.length > 0 ? { reasoningLevels } : undefined,
      };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value));

  const defaultModel =
    modelOptions.find((option) => !/-codex(?:-|$)/.test(option.value))?.value ??
    models.find((entry) => entry.isDefault === true && typeof entry.id === "string")?.id ??
    modelOptions[0]?.value ??
    "__default__";
  const effortSet = new Set<string>();
  for (const model of models) {
    for (const effort of codexAppServerEffortValues(model)) {
      effortSet.add(effort);
    }
  }
  const efforts = Array.from(effortSet);
  const baseOptions = createCodexAppServerFallbackConfigOptions().map((option) => {
    if (option.id === "model") {
      return {
        ...option,
        description: "Models reported by the Codex App Server model/list endpoint.",
        currentValue: String(defaultModel),
        options: modelOptions,
      };
    }
    return option;
  });
  if (efforts.length > 0) {
    baseOptions.push({
      id: "model_reasoning_effort",
      name: "Reasoning Effort",
      category: "thought_level",
      currentValue: efforts.includes("low") ? "low" : efforts[0]!,
      options: efforts.map((effort) => ({ value: effort, name: titleCaseConfigValue(effort) })),
    });
  }
  return baseOptions;
}

async function resolveCodexAppServerCommand(): Promise<string> {
  const configured = process.env.OPENCURSOR_CODEX_BIN?.trim();
  if (configured) {
    return configured;
  }
  if (process.platform === "win32" && process.env.APPDATA?.trim()) {
    const npmShim = path.join(process.env.APPDATA, "npm", "codex.cmd");
    try {
      await fs.access(npmShim);
      return npmShim;
    } catch {
      // Fall through to PATH resolution by child_process.
    }
  }
  return "codex";
}

async function createCodexAppServerConfigOptions(): Promise<AgentConfigOption[]> {
  let transport: CodexAppServerTransport | null = null;
  try {
    transport = new CodexAppServerTransport({
      command: await resolveCodexAppServerCommand(),
      args: ["app-server"],
      cwd: process.cwd(),
      requestTimeoutMs: 10_000,
    });
    await transport.request("initialize", {
      clientInfo: {
        name: "opencursor_codex_app_server_models",
        title: "OpenCursor Codex App Server Model Discovery",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    transport.notify("initialized");
    await transport.request("account/read", { refreshToken: false }).catch(() => undefined);
    const models: Array<Record<string, unknown>> = [];
    let cursor: string | null | undefined = null;
    do {
      const result = (await transport.request("model/list", {
        limit: 50,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      })) as { data?: Array<Record<string, unknown>>; nextCursor?: string | null };
      models.push(...(Array.isArray(result.data) ? result.data : []));
      cursor = result.nextCursor;
    } while (cursor);
    return codexAppServerOptionsFromModels(models);
  } catch {
    return createCodexAppServerFallbackConfigOptions();
  } finally {
    transport?.dispose();
  }
}

function createCursorSdkFallbackConfigOptions(): AgentConfigOption[] {
  return [
    {
      id: "mode",
      name: "OpenCursor Mode",
      category: "mode",
      currentValue: "agent",
      options: [
        { value: "agent", name: "Agent" },
        {
          value: "plan",
          name: "Plan",
          description: "Synthetic prompt prefix until Cursor SDK exposes native modes.",
        },
        {
          value: "ask",
          name: "Ask",
          description: "Synthetic prompt prefix until Cursor SDK exposes native modes.",
        },
        {
          value: "debug",
          name: "Debug",
          description: "Synthetic prompt prefix until Cursor SDK exposes native modes.",
        },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "composer-2",
      options: [
        {
          value: "composer-2",
          name: "Composer 2",
          description: "Cursor SDK default local coding model.",
        },
      ],
    },
    {
      id: "sdk_sandbox",
      name: "Local Sandbox",
      category: "permission",
      currentValue: process.platform === "win32" ? "disabled" : "enabled",
      options: [
        { value: "enabled", name: "Enabled" },
        { value: "disabled", name: "Disabled" },
      ],
    },
    {
      id: "setting_sources",
      name: "Cursor Settings Sources",
      category: "other",
      currentValue: "project,user,plugins",
      options: [
        { value: "project", name: "Project" },
        { value: "project,user,plugins", name: "Project + User + Plugins" },
        { value: "all", name: "All" },
      ],
    },
  ];
}

export function cursorSdkConfigOptionsFromModels(
  models: Array<{
    id: string;
    displayName: string;
    description?: string;
    parameters?: Array<{
      id: string;
      displayName?: string;
      values: Array<{ value: string; displayName?: string }>;
    }>;
    variants?: Array<{
      params: CursorSdkModelParam[];
      displayName: string;
      description?: string;
      isDefault?: boolean;
    }>;
  }>
): AgentConfigOption[] {
  const fallback = createCursorSdkFallbackConfigOptions();
  const modelRows = models.flatMap(cursorSdkModelRows);
  if (modelRows.length === 0) {
    return fallback;
  }
  return fallback.map((option) =>
    option.id === "model"
      ? {
          ...option,
          currentValue:
            modelRows.find((model) => model.value === "composer-2")?.value ??
            modelRows[0]?.value ??
            "composer-2",
          options: modelRows,
        }
      : option
  );
}

function cursorSdkModelRows(model: {
  id: string;
  displayName: string;
  description?: string;
  parameters?: Array<{
    id: string;
    displayName?: string;
    values: Array<{ value: string; displayName?: string }>;
  }>;
  variants?: Array<{
    params: CursorSdkModelParam[];
    displayName: string;
    description?: string;
    isDefault?: boolean;
  }>;
}): AgentConfigOption["options"] {
  const modelId = model.id.trim();
  if (!modelId) {
    return [];
  }

  const variants = model.variants?.filter((variant) => Array.isArray(variant.params)) ?? [];
  if (variants.length > 0) {
    return variants.map((variant) => {
      const params = normalizeCursorSdkParams(variant.params);
      const name = formatCursorSdkVariantName(model.displayName || modelId, variant.displayName, params);
      return {
        value: encodeCursorSdkModelValue(modelId, params),
        name,
        description: variant.description ?? model.description,
        metadata: cursorSdkModelMetadata(modelId, params, variant.isDefault),
      };
    });
  }

  const parameterVariants = expandCursorSdkParameterVariants(model.parameters ?? []);
  if (parameterVariants.length > 0) {
    return parameterVariants.map((params) => ({
      value: encodeCursorSdkModelValue(modelId, params),
      name: formatCursorSdkVariantName(model.displayName || modelId, "", params),
      ...(model.description ? { description: model.description } : {}),
      metadata: cursorSdkModelMetadata(modelId, params, false),
    }));
  }

  return [
    {
      value: modelId,
      name: model.displayName || modelId,
      ...(model.description ? { description: model.description } : {}),
      metadata: cursorSdkModelMetadata(modelId, [], false),
    },
  ];
}

function normalizeCursorSdkParams(params: CursorSdkModelParam[]): CursorSdkModelParam[] {
  return params
    .map((param) => ({ id: param.id.trim(), value: param.value.trim() }))
    .filter((param) => param.id.length > 0 && param.value.length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function cursorSdkModelMetadata(
  modelId: string,
  params: CursorSdkModelParam[],
  isDefault?: boolean
): Record<string, string | string[]> {
  return {
    cursorSdkModelId: modelId,
    cursorSdkParams: params.map((param) => `${param.id}=${param.value}`),
    ...(isDefault ? { cursorSdkDefault: "true" } : {}),
  };
}

function formatCursorSdkVariantName(
  baseName: string,
  variantName: string,
  params: CursorSdkModelParam[]
): string {
  const cleanBase = baseName.trim();
  const cleanVariant = variantName.trim();
  const paramLabels = cursorSdkVariantLabelsFromParams(params);
  if (paramLabels.length > 0) {
    return appendUniqueCursorSdkVariantLabels(cleanBase, paramLabels);
  }
  if (cleanVariant && !/^default$/i.test(cleanVariant)) {
    const variantLabels = cursorSdkVariantLabelsFromDisplayName(cleanVariant);
    if (variantLabels.length > 0) {
      return appendUniqueCursorSdkVariantLabels(cleanBase, variantLabels);
    }
  }
  if (params.length === 0) {
    return cleanBase;
  }
  return cleanBase;
}

function cursorSdkParamFallbackLabel(value: string): string {
  if (/^xhigh$/i.test(value)) {
    return "Extra High";
  }
  return value
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function appendUniqueCursorSdkVariantLabels(baseName: string, labels: string[]): string {
  const normalizedBase = baseName.toLowerCase();
  const unique = labels.filter((label, index, all) => {
    const normalized = label.toLowerCase();
    return (
      normalized.length > 0 &&
      !normalizedBase.includes(normalized) &&
      all.findIndex((candidate) => candidate.toLowerCase() === normalized) === index
    );
  });
  return unique.length > 0 ? `${baseName} ${unique.join(" ")}` : baseName;
}

function cursorSdkVariantLabelsFromParams(params: CursorSdkModelParam[]): string[] {
  return params.flatMap((param) => cursorSdkVariantLabel(param.id, param.value));
}

function cursorSdkVariantLabelsFromDisplayName(displayName: string): string[] {
  const cleaned = displayName.replace(/[()]/g, " ");
  return cleaned
    .split(/[,/]+/)
    .flatMap((part) => {
      const trimmed = part.trim();
      if (/^extra\s+high$/i.test(trimmed)) {
        return ["Extra High"];
      }
      return trimmed.split(/\s+/).flatMap((token) => cursorSdkVariantLabel("", token));
    });
}

function cursorSdkVariantLabel(paramId: string, rawValue: string): string[] {
  const id = paramId.trim().toLowerCase();
  const value = rawValue.trim();
  const normalizedValue = value.toLowerCase();
  if (
    !value ||
    normalizedValue === "none" ||
    normalizedValue === "default" ||
    normalizedValue === "auto" ||
    normalizedValue === "false"
  ) {
    return [];
  }
  if (/context|length|window|token/.test(id) || /^\d+\s*k$/i.test(value)) {
    return [];
  }
  if (/speed|fast/.test(id)) {
    return normalizedValue === "fast" || normalizedValue === "true"
      ? ["Fast"]
      : [cursorSdkParamFallbackLabel(value)];
  }
  if (/thinking|reason|effort/.test(id)) {
    return [cursorSdkParamFallbackLabel(value)];
  }
  if (
    ["low", "medium", "high", "xhigh", "extra-high", "extra high", "fast", "max", "thinking"].includes(
      normalizedValue
    )
  ) {
    return [cursorSdkParamFallbackLabel(value)];
  }
  return [];
}

function expandCursorSdkParameterVariants(
  parameters: Array<{
    id: string;
    displayName?: string;
    values: Array<{ value: string; displayName?: string }>;
  }>
): CursorSdkModelParam[][] {
  const variantParameters = parameters.filter((parameter) =>
    /speed|fast|context|length|thinking|reason|effort/i.test(parameter.id)
  );
  if (variantParameters.length === 0) {
    return [];
  }

  let rows: CursorSdkModelParam[][] = [[]];
  for (const parameter of variantParameters) {
    const values = parameter.values.filter((value) => value.value.trim());
    if (values.length === 0) {
      continue;
    }
    rows = rows.flatMap((row) =>
      values.map((value) => [...row, { id: parameter.id, value: value.value }])
    );
    if (rows.length > 80) {
      return [];
    }
  }
  return rows.map((row) => normalizeCursorSdkParams(row));
}

const CURSOR_SDK_MODEL_LIST_TIMEOUT_MS = Number.parseInt(
  process.env.OPENCURSOR_CURSOR_SDK_MODEL_LIST_TIMEOUT_MS ?? "15000",
  10
);

async function createCursorSdkConfigOptions(): Promise<AgentConfigOption[]> {
  const apiKey = await getCursorSdkApiKey();
  if (!apiKey) {
    return createCursorSdkFallbackConfigOptions();
  }
  try {
    const { Cursor } = await import("@cursor/sdk");
    const timeoutMs =
      Number.isFinite(CURSOR_SDK_MODEL_LIST_TIMEOUT_MS) && CURSOR_SDK_MODEL_LIST_TIMEOUT_MS > 0
        ? CURSOR_SDK_MODEL_LIST_TIMEOUT_MS
        : 15000;
    const models = await Promise.race([
      Cursor.models.list({ apiKey }),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`Cursor.models.list exceeded ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
    return cursorSdkConfigOptionsFromModels(models);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn("[agents] Cursor SDK model list failed (fallback catalog):", detail);
    return createCursorSdkFallbackConfigOptions();
  }
}

const CLAUDE_CODE_SDK_FALLBACK_MODELS: AgentConfigOption["options"] = [
  {
    value: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    description: "Balanced Claude Code SDK default.",
    metadata: { reasoningLevels: ["low", "medium", "high"] },
  },
  {
    value: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    description: "Highest capability model with xhigh/max effort support.",
    metadata: { reasoningLevels: ["low", "medium", "high", "xhigh", "max"] },
  },
  {
    value: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    description: "High capability model with max effort support.",
    metadata: { reasoningLevels: ["low", "medium", "high", "max"] },
  },
  {
    value: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    description: "Fast Claude model for lighter tasks.",
    metadata: { reasoningLevels: ["low", "medium"] },
  },
];

function claudeCodeSdkModelOptions(): AgentConfigOption["options"] {
  if (!hasClaudeCodeSdkProxyConfig()) {
    return CLAUDE_CODE_SDK_FALLBACK_MODELS;
  }
  const proxyModel = getClaudeCodeSdkProxyModel();
  return [
    {
      value: proxyModel,
      name: getClaudeCodeSdkProxyModelName(),
      description: "Claude Code SDK routed through the configured model proxy.",
      metadata: { reasoningLevels: ["low", "medium", "high", "xhigh", "max"] },
    },
    ...CLAUDE_CODE_SDK_FALLBACK_MODELS.filter((model) => model.value !== proxyModel),
  ];
}

function createClaudeCodeSdkFallbackConfigOptions(
  modelOptions: AgentConfigOption["options"] = claudeCodeSdkModelOptions()
): AgentConfigOption[] {
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "agent",
      options: [
        { value: "agent", name: "Agent", description: "Run Claude Code SDK with normal tool permissions." },
        { value: "plan", name: "Plan", description: "Use native Claude plan mode without executing tools." },
        { value: "ask", name: "Ask", description: "Answer and inspect with restrictive permissions." },
        { value: "debug", name: "Debug", description: "Debug with the standard Claude Code tool profile." },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: modelOptions[0]?.value ?? "claude-sonnet-4-5",
      options: modelOptions,
    },
    {
      id: "permission_mode",
      name: "Permission Mode",
      category: "permission",
      currentValue: "default",
      options: [
        { value: "default", name: "Default" },
        { value: "acceptEdits", name: "Accept Edits" },
        { value: "plan", name: "Plan" },
        { value: "dontAsk", name: "Don't Ask" },
        { value: "auto", name: "Auto" },
        {
          value: "bypassPermissions",
          name: "Bypass Permissions",
          description: "Requires OPENCURSOR_CLAUDE_CODE_SDK_ALLOW_BYPASS=1.",
        },
      ],
    },
    {
      id: "effort",
      name: "Reasoning Effort",
      category: "thought_level",
      currentValue: "medium",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "xhigh", name: "Extra High" },
        { value: "max", name: "Max" },
      ],
    },
    {
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      currentValue: "adaptive",
      options: [
        { value: "adaptive", name: "Adaptive" },
        { value: "disabled", name: "Disabled" },
      ],
    },
    {
      id: "tool_profile",
      name: "Tool Profile",
      category: "other",
      currentValue: "standard",
      options: [
        { value: "standard", name: "Standard", description: "Read, edit, search, bash, todos, and Agent." },
        { value: "safe-readonly", name: "Safe Readonly", description: "Read/search/web tools only." },
        { value: "full", name: "Full Claude Code", description: "All stock Claude Code tools, permission gated." },
        { value: "plan", name: "Plan Only", description: "No built-in tool execution." },
      ],
    },
    {
      id: "max_turns",
      name: "Max Turns",
      category: "other",
      currentValue: "20",
      options: [
        { value: "10", name: "10" },
        { value: "20", name: "20" },
        { value: "40", name: "40" },
        { value: "80", name: "80" },
      ],
    },
    {
      id: "session_persistence",
      name: "Session Persistence",
      category: "other",
      currentValue: "enabled",
      options: [
        { value: "enabled", name: "Enabled" },
        { value: "disabled", name: "Ephemeral" },
      ],
    },
  ];
}

function claudeSdkOptionsFromModels(
  models: Array<{
    value: string;
    displayName?: string;
    description?: string;
    supportedEffortLevels?: string[];
  }>
): AgentConfigOption[] {
  const options = models
    .filter((model) => model.value?.trim())
    .map((model) => ({
      value: model.value,
      name: model.displayName?.trim() || model.value,
      description: model.description,
      metadata:
        Array.isArray(model.supportedEffortLevels) && model.supportedEffortLevels.length > 0
          ? { reasoningLevels: model.supportedEffortLevels }
          : undefined,
    }));
  return createClaudeCodeSdkFallbackConfigOptions(
    options.length > 0 ? options : claudeCodeSdkModelOptions()
  );
}

export async function createClaudeCodeSdkConfigOptions(): Promise<AgentConfigOption[]> {
  if (!hasClaudeCodeSdkAuthConfig()) {
    return createClaudeCodeSdkFallbackConfigOptions();
  }
  try {
    await import("@anthropic-ai/claude-agent-sdk");
    return claudeSdkOptionsFromModels([]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn("[agents] Claude Code SDK model list failed (fallback catalog):", detail);
    return createClaudeCodeSdkFallbackConfigOptions();
  }
}

async function createSeedConfigOptions(backendId: AgentBackendId): Promise<AgentConfigOption[]> {
  switch (backendId) {
    case "cursor-acp":
      return createCursorCliConfigOptions();
    case "cursor-sdk":
      return createCursorSdkConfigOptions();
    case "claude-code-sdk":
      return createClaudeCodeSdkConfigOptions();
    case "opencode-acp":
      return createOpenCodeCliConfigOptions();
    case "opencode-server":
      return createOpenCodeServerConfigOptions();
    case "gemini-acp":
      return createGeminiCliConfigOptions();
    case "codex-adapter":
      return createCodexSeedConfigOptions();
    case "codex-app-server":
      return createCodexAppServerConfigOptions();
    case "claude-adapter":
      return [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          currentValue: "agent",
          options: [{ value: "agent", name: "Agent" }],
        },
        {
          id: "model",
          name: "Model",
          category: "model",
          currentValue: "glm-5.1",
          options: [
            {
              value: "glm-5.1",
              name: "GLM 5.1",
              description: "Claude Code routed through the local model proxy.",
              metadata: {
                reasoningLevels: ["low", "medium", "high", "max"],
              },
            },
            {
              value: "turbo",
              name: "Turbo",
              description: "Claude Code routed through the local model proxy.",
              metadata: {
                reasoningLevels: ["low", "medium", "high", "max"],
              },
            },
            {
              value: "precision",
              name: "Precision",
              description: "Claude Code routed through the local model proxy.",
              metadata: {
                reasoningLevels: ["low", "medium", "high", "max"],
              },
            },
            {
              value: "complete",
              name: "Complete",
              description: "Claude Code routed through the local model proxy.",
              metadata: {
                reasoningLevels: ["low", "medium", "high", "max"],
              },
            },
            {
              value: "glm-5",
              name: "GLM 5",
              description: "Claude Code routed through the local model proxy.",
              metadata: {
                reasoningLevels: ["low", "medium", "high", "max"],
              },
            },
            {
              value: "glm-5-lightning",
              name: "GLM 5 Lightning",
              description: "Claude Code routed through the local model proxy.",
              metadata: {
                reasoningLevels: ["low", "medium", "high", "max"],
              },
            },
          ],
        },
        {
          id: "permission",
          name: "Permission Mode",
          category: "permission",
          currentValue: "plan",
          options: [
            { value: "plan", name: "Plan" },
            { value: "acceptEdits", name: "Accept Edits" },
            { value: "dontAsk", name: "Don't Ask" },
            { value: "bypassPermissions", name: "Bypass Permissions" },
          ],
        },
        {
          id: "effort",
          name: "Reasoning Effort",
          category: "thought_level",
          currentValue: "medium",
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
            { value: "max", name: "Max" },
          ],
        },
      ];
    default:
      return [];
  }
}

/**
 * Earlier versions of the Cursor CLI emitted bracketed knob defaults like
 * `gpt-5.4[reasoning=medium,context=272k,fast=false]` and we used to inflate
 * those into a synthetic `cursor_thought_level` config option. The modern CLI
 * already enumerates each effort/context/fast combination as its own model id,
 * so any cache that still contains brackets or a cursor thought-level option is
 * stale and must be rebuilt from the live CLI.
 */
function isStaleCursorAcpCache(configOptions: AgentConfigOption[]): boolean {
  const modelOption = configOptions.find((option) => option.category === "model");
  if (!modelOption || modelOption.options.length === 0) {
    return true;
  }
  if (
    configOptions.some(
      (option) =>
        option.id === "cursor_thought_level" ||
        (option.category === "thought_level" && option.id !== "model_reasoning_effort")
    )
  ) {
    return true;
  }
  if (modelOption.currentValue.includes("[")) {
    return true;
  }
  return modelOption.options.some((option) => option.value.includes("["));
}

function isStaleCursorSdkCache(configOptions: AgentConfigOption[]): boolean {
  const modelOption = configOptions.find((option) => option.category === "model");
  if (!modelOption || modelOption.options.length === 0) {
    return true;
  }
  return modelOption.options.some(
    (option) =>
      option.metadata?.cursorSdkModelId == null ||
      /\([^)]*(?:\d+\s*k|none|fast|low|medium|high|xhigh)[^)]*\)/i.test(option.name)
  );
}

/**
 * In-flight seed refreshes keyed by backendId. We dedupe concurrent callers so
 * only one CLI subprocess runs at a time per backend, and multiple HTTP
 * requests can await the same Promise.
 */
const inFlightRefreshes = new Map<
  AgentBackendId,
  Promise<AgentConfigOption[]>
>();

function startSeedRefresh(
  backendId: AgentBackendId
): Promise<AgentConfigOption[]> {
  const existing = inFlightRefreshes.get(backendId);
  if (existing) {
    return existing;
  }
  const promise = (async () => {
    try {
      const seeded = await createSeedConfigOptions(backendId);
      if (seeded.length > 0) {
        await writeAgentBackendConfigCache(backendId, seeded);
      }
      return seeded;
    } finally {
      inFlightRefreshes.delete(backendId);
    }
  })();
  inFlightRefreshes.set(backendId, promise);
  return promise;
}

/** Backend ids we avoid probing during boot (optional; see `shouldWarmupBackendAtBoot`). */
const SKIP_WARMUP_BACKENDS = new Set<AgentBackendId>([
  "cursor-sdk",
  "claude-code-sdk",
  "codex-app-server",
  "opencode-server",
]);

function shouldWarmupBackendAtBoot(backendId: AgentBackendId): boolean {
  if (SKIP_WARMUP_BACKENDS.has(backendId)) {
    if (backendId === "claude-code-sdk") {
      return process.env.OPENCURSOR_WARMUP_CLAUDE_CODE_SDK === "1";
    }
    if (backendId === "codex-app-server") {
      return process.env.OPENCURSOR_WARMUP_CODEX_APP_SERVER === "1";
    }
    if (backendId === "opencode-server") {
      return process.env.OPENCURSOR_WARMUP_OPENCODE_SERVER === "1";
    }
    return process.env.OPENCURSOR_WARMUP_CURSOR_SDK === "1";
  }
  return true;
}

/** 
 * Eagerly refresh every backend's config cache in the background. Intended for
 * server boot: kicks off CLI probes without blocking startup, so the first
 * request finds a warm cache rather than paying the CLI latency tax itself.
 * 
 * **Cursor SDK** is skipped by default: `Cursor.models.list` hits Cursor cloud
 * and can drop the Bun process on TLS blips. Enable with
 * `OPENCURSOR_WARMUP_CURSOR_SDK=1` if you want boot-time catalog fetch anyway.
 */
export function warmupAgentBackendCaches(
  backendIds: AgentBackendId[]
): Promise<void> {
  const toWarm = backendIds.filter(shouldWarmupBackendAtBoot);
  return Promise.allSettled(
    toWarm.map((backendId) => startSeedRefresh(backendId))
  ).then(() => undefined);
}

const FORCE_REFRESH_TIMEOUT_MS = 15_000;

export type ForceRefreshResult = {
  byBackend: Record<string, AgentConfigOption[]>;
  timedOut: AgentBackendId[];
  failed: AgentBackendId[];
};

export async function forceRefreshAllBackendCaches(
  backendIds: AgentBackendId[]
): Promise<ForceRefreshResult> {
  const byBackend: Record<string, AgentConfigOption[]> = {};
  const timedOut: AgentBackendId[] = [];
  const failed: AgentBackendId[] = [];

  const results = await Promise.allSettled(
    backendIds.map(async (backendId) => {
      const refreshPromise = startSeedRefresh(backendId);
      const result = await Promise.race([
        refreshPromise,
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), FORCE_REFRESH_TIMEOUT_MS)
        ),
      ]);
      return { backendId, result };
    })
  );

  for (const settled of results) {
    if (settled.status === "rejected") {
      const backendId = backendIds[results.indexOf(settled)];
      failed.push(backendId);
      continue;
    }
    const { backendId, result } = settled.value;
    if (result === "timeout") {
      timedOut.push(backendId);
      const cached = await readAgentBackendConfigCache(backendId).catch(
        () => []
      );
      if (cached.length > 0) {
        byBackend[backendId] = cached;
      }
    } else {
      byBackend[backendId] = result;
    }
  }

  return { byBackend, timedOut, failed };
}

/**
 * Returns the upgraded `configOptions` if the cached record is structurally
 * stale (schema drift), or `null` when the record is fine as-is. Pure on the
 * cached values - no CLI invocations. Actual re-seed happens via
 * `startSeedRefresh` once we know a refresh is warranted.
 */
function maybeInPlaceMigrate(
  backendId: AgentBackendId,
  cachedOptions: AgentConfigOption[]
): { upgraded: AgentConfigOption[]; needsReseed: boolean } | null {
  if (backendId === "cursor-acp" && isStaleCursorAcpCache(cachedOptions)) {
    return { upgraded: cachedOptions, needsReseed: true };
  }

  if (backendId === "cursor-sdk" && isStaleCursorSdkCache(cachedOptions)) {
    return { upgraded: cachedOptions, needsReseed: true };
  }

  if (backendId === "codex-adapter") {
    const hasReasoningLevels = cachedOptions.some(
      (option) =>
        option.category === "model" &&
        option.options.some(
          (value) =>
            Array.isArray(value.metadata?.reasoningLevels) &&
            value.metadata.reasoningLevels.length > 0
        )
    );
    if (!hasReasoningLevels) {
      return { upgraded: cachedOptions, needsReseed: true };
    }
    const mapped = cachedOptions.map((option) => {
      if (
        option.id === "model" &&
        option.options.some((value) => value.value === "gpt-5.4-mini") &&
        option.currentValue !== "gpt-5.4-mini"
      ) {
        return { ...option, currentValue: "gpt-5.4-mini" };
      }
      if (
        option.id === "model_reasoning_effort" &&
        option.options.some((value) => value.value === "low") &&
        option.currentValue !== "low"
      ) {
        return { ...option, currentValue: "low" };
      }
      if (
        option.id === "permission" &&
        option.options.some((value) => value.value === "workspace-write") &&
        option.currentValue !== "workspace-write"
      ) {
        return { ...option, currentValue: "workspace-write" };
      }
      return option;
    });
    const hasPermissionOption = mapped.some((option) => option.id === "permission");
    const hasWebSearchOption = mapped.some((option) => option.id === "web_search");
    if (!hasPermissionOption || !hasWebSearchOption) {
      return { upgraded: cachedOptions, needsReseed: true };
    }
    if (JSON.stringify(mapped) !== JSON.stringify(cachedOptions)) {
      return { upgraded: mapped, needsReseed: false };
    }
    return null;
  }

  if (backendId === "codex-app-server") {
    const modelOption = cachedOptions.find((option) => option.id === "model");
    const hasModel = Boolean(modelOption);
    const hasPermission = cachedOptions.some((option) => option.id === "permission");
    const hasServerReportedModelSource =
      modelOption?.description === "Models reported by the Codex App Server model/list endpoint.";
    const hasGeneratedFallbackModels = cachedOptions.some(
      (option) =>
        option.id === "model" &&
        option.options.some(
          (value) =>
            value.description === "Codex App Server fallback model." ||
            value.value === "gpt-5.5-mini"
        )
    );
    if (
      !hasModel ||
      !hasPermission ||
      (modelOption && modelOption.options.length > 0 && !hasServerReportedModelSource) ||
      hasGeneratedFallbackModels
    ) {
      return { upgraded: cachedOptions, needsReseed: true };
    }
  }

  if (backendId === "opencode-server") {
    const hasModel = cachedOptions.some((option) => option.id === "model");
    const hasAgent = cachedOptions.some((option) => option.id === "agent" || option.id === "mode");
    if (!hasModel || !hasAgent) {
      return { upgraded: cachedOptions, needsReseed: true };
    }
  }

  if (backendId === "claude-adapter") {
    const hasGlm51 = cachedOptions.some(
      (option) =>
        option.category === "model" &&
        option.options.some((value) => value.value === "glm-5.1")
    );
    const hasBypassPerms = cachedOptions.some(
      (option) =>
        option.category === "permission" &&
        option.options.some((value) => value.value === "bypassPermissions")
    );
    if (!hasGlm51 || !hasBypassPerms) {
      return { upgraded: cachedOptions, needsReseed: true };
    }
  }

  if (backendId === "claude-code-sdk") {
    const hasModel = cachedOptions.some((option) => option.id === "model");
    const hasPermission = cachedOptions.some((option) => option.id === "permission_mode");
    const hasTools = cachedOptions.some((option) => option.id === "tool_profile");
    const proxyModel = getClaudeCodeSdkProxyModel();
    const hasConfiguredProxyModel =
      !hasClaudeCodeSdkProxyConfig() ||
      cachedOptions.some(
        (option) =>
          option.id === "model" &&
          option.options.some((value) => value.value === proxyModel) &&
          option.currentValue === proxyModel
      );
    if (!hasModel || !hasPermission || !hasTools || !hasConfiguredProxyModel) {
      return { upgraded: cachedOptions, needsReseed: true };
    }
  }

  return null;
}

export async function readAgentBackendConfigCache(
  backendId: AgentBackendId
): Promise<AgentConfigOption[]> {
  const driverRecord = await (await getStorage()).readProviderCache(backendId);
  const record: AgentBackendCacheRecord | null = driverRecord
    ? {
        schemaVersion: 1,
        backendId: driverRecord.backendId,
        updatedAt: driverRecord.updatedAt,
        configOptions: driverRecord.configOptions,
      }
    : null;
  const cachedOptions =
    record &&
    record.schemaVersion === 1 &&
    record.backendId === backendId &&
    Array.isArray(record.configOptions) &&
    record.configOptions.length > 0
      ? record.configOptions
      : null;

  if (record && cachedOptions) {
    const migration = maybeInPlaceMigrate(backendId, cachedOptions);
    // Apply purely-local schema migrations without shelling out; this is
    // cheap and keeps the returned shape stable for the caller.
    if (migration) {
      if (migration.upgraded !== cachedOptions) {
        await writeAgentBackendConfigCache(backendId, migration.upgraded);
      }
      if (migration.needsReseed) {
        if (
          backendId === "cursor-sdk" ||
          backendId === "claude-code-sdk"
        ) {
          return startSeedRefresh(backendId).catch(() => migration.upgraded);
        }
        if (backendId === "codex-app-server") {
          return startSeedRefresh(backendId).catch(() => createCodexAppServerFallbackConfigOptions());
        }
        // Schema-drift migration requires a fresh CLI probe. Schedule it in
        // the background; serve the (possibly upgraded) cache immediately.
        void startSeedRefresh(backendId).catch(() => undefined);
      }
      return migration.upgraded;
    }

    const cacheIsFresh = Date.now() - record.updatedAt <= CACHE_TTL_MS;
    if (cacheIsFresh) {
      return cachedOptions;
    }

    // Stale-but-valid: serve it immediately and revalidate in the background
    // so subsequent callers see fresh data without us paying the CLI cost on
    // the hot path.
    void startSeedRefresh(backendId).catch(() => undefined);
    return cachedOptions;
  }

  // No usable cache: we must wait. Shared via `startSeedRefresh` so concurrent
  // callers converge on a single CLI invocation.
  return startSeedRefresh(backendId).catch(() => createSeedConfigOptions(backendId));
}

export async function writeAgentBackendConfigCache(
  backendId: AgentBackendId,
  configOptions: AgentConfigOption[]
): Promise<void> {
  if (configOptions.length === 0) {
    return;
  }
  await (await getStorage()).writeProviderCache(backendId, {
    schemaVersion: 1,
    backendId,
    updatedAt: Date.now(),
    configOptions,
  });
}
