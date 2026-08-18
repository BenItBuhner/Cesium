import { execFile } from "node:child_process";
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
import { createCesiumAgentConfigOptions } from "../cesium-agent-settings.js";
import {
  buildPiAgentSeedConfigOptions,
  hasPiAgentRichModelCatalog,
  isPiAgentPlaceholderModelCatalog,
} from "../pi-agent-model-catalog.js";
import { spawnSafeEnv } from "./spawn-env.js";
import { harnessLog } from "./harness-diagnostics.js";
import {
  buildHarnessInvocation,
  detectHarnessCli,
  harnessHomeDirCandidates,
  refreshHarnessCliDetection,
} from "./harness-runtime.js";
import { CodexAppServerTransport } from "./codex-app-server-transport.js";
import { OpenCodeServerClient, openCodeServerAuthFromEnv } from "./opencode-server-client.js";
import { OpenCodeV2Client, openCodeV2AuthFromEnv } from "./opencode-v2-client.js";
import { buildOpenCodeV2ConfigOptions } from "./opencode-v2-config.js";
import {
  resolveOpenCodeGeneration,
  withOpenCodeGenerationOption,
} from "./opencode-generation.js";
import { encodeCursorSdkModelValue, type CursorSdkModelParam } from "./cursor-sdk-model-selection.js";
import { LEGACY_MODE_CONFIG_ID } from "./config-option-parse.js";
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
const SERVER_STARTED_AT = Date.now();

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

/** Logs a model-discovery probe failure so empty catalogs are explainable. */
function logSeedProbeFailure(
  backendId: AgentBackendId,
  detail: string,
  error: unknown
): void {
  harnessLog({
    level: "warning",
    backendId,
    event: "models.seed_probe_failed",
    detail: `${detail}: ${error instanceof Error ? error.message : String(error)}`,
  });
}

async function createOpenCodeCliConfigOptions(input?: {
  command?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<AgentConfigOption[]> {
  const invocation = input?.command
    ? { command: input.command, args: ["models", "--verbose"] }
    : (() => {
        const resolved = buildHarnessInvocation("opencode", ["models", "--verbose"]);
        return resolved
          ? { command: resolved.command, args: resolved.args }
          : { command: "opencode", args: ["models", "--verbose"] };
      })();
  const raw = await execFileText(invocation.command, invocation.args, {
    cwd: input?.cwd,
    env: input?.env,
  }).catch((error) => {
    logSeedProbeFailure("opencode-server", "opencode models --verbose failed", error);
    return "";
  });
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
    return withOpenCodeGenerationOption([], "current");
  }

  return withOpenCodeGenerationOption([
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
  ], "current");
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
    return withOpenCodeGenerationOption([
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
        description: uniqueModels.length > 0
          ? "Models reported by the OpenCode server."
          : "No OpenCode server models were reported. Configure/authenticate OpenCode and refresh models.",
        options: uniqueModels,
      },
    ], "current");
  } catch {
    return createOpenCodeCliConfigOptions();
  }
}

async function createOpenCodeV2ConfigOptions(): Promise<AgentConfigOption[]> {
  const baseUrl = process.env.OPENCURSOR_OPENCODE_V2_SERVER_URL?.trim();
  const directory = process.env.WORKSPACE_ROOT?.trim() || process.cwd();
  if (baseUrl) {
    try {
      const client = new OpenCodeV2Client({
        baseUrl,
        ...openCodeV2AuthFromEnv(),
        timeoutMs: 10_000,
      });
      const [agents, models] = await Promise.all([
        client.listAgents(directory),
        client.listModels(directory),
      ]);
      return buildOpenCodeV2ConfigOptions({ agents, models });
    } catch (error) {
      logSeedProbeFailure(
        "opencode-v2-beta",
        `OpenCode v2 model discovery failed against ${baseUrl}`,
        error
      );
      return [];
    }
  }

  // No external server configured: when the opencode2 binary is installed,
  // discover through a short-lived managed serve so the catalog is real
  // instead of empty until the first chat.
  if (!detectHarnessCli("opencode-v2")) {
    return [];
  }
  try {
    const { connectOpenCodeV2 } = await import("./opencode-v2-process.js");
    const connection = await connectOpenCodeV2({ workspaceRoot: directory });
    try {
      const [agents, models] = await Promise.all([
        connection.client.listAgents(directory),
        connection.client.listModels(directory),
      ]);
      return buildOpenCodeV2ConfigOptions({ agents, models });
    } finally {
      await connection.dispose();
    }
  } catch (error) {
    logSeedProbeFailure(
      "opencode-v2-beta",
      "OpenCode v2 managed-server model discovery failed",
      error
    );
    return [];
  }
}

/**
 * Seed mode/model dropdown for Devin CLI ACP before the first session lists options.
 * Short names resolve to the latest family version (see https://docs.devin.ai/cli/models).
 */
async function createDevinCliConfigOptions(input?: {
  command?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<AgentConfigOption[]> {
  void input;
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "agent",
      options: [
        { value: "agent", name: "Normal" },
        { value: "plan", name: "Plan" },
        { value: "accept-edits", name: "Accept Edits" },
        { value: "bypass", name: "Bypass" },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "auto",
      options: [
        { value: "auto", name: "Auto / Adaptive" },
        { value: "swe", name: "SWE" },
        { value: "opus", name: "Opus" },
        { value: "sonnet", name: "Sonnet" },
        { value: "gpt", name: "GPT" },
        { value: "codex", name: "Codex" },
        { value: "gemini", name: "Gemini" },
      ],
    },
  ];
}

function formatGrokBuildModelName(modelId: string): string {
  if (/^grok[-_.]/i.test(modelId)) {
    return modelId
      .split(/[-_]+/)
      .map((part, index) =>
        index === 0
          ? "Grok"
          : /^\d/.test(part)
            ? part
            : part.charAt(0).toUpperCase() + part.slice(1)
      )
      .join(" ");
  }
  return modelId;
}

/**
 * Grok exposes a credential-independent model catalog through `grok models`.
 * Live ACP session metadata supersedes this seed after authentication.
 */
export async function createGrokBuildConfigOptions(input?: {
  command?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<AgentConfigOption[]> {
  const invocation = input?.command?.trim()
    ? { command: input.command.trim(), args: ["models"] }
    : (() => {
        const resolved = buildHarnessInvocation("grok", ["models"]);
        return resolved
          ? { command: resolved.command, args: resolved.args }
          : { command: "grok", args: ["models"] };
      })();
  const raw = await execFileText(invocation.command, invocation.args, {
    cwd: input?.cwd,
    env: input?.env,
  }).catch((error) => {
    logSeedProbeFailure("grok-build", "grok models probe failed", error);
    return "";
  });
  const cleaned = stripAnsi(raw);
  const defaultModel =
    cleaned.match(/^\s*Default model:\s*(\S+)\s*$/im)?.[1]?.trim() || "grok-4.5";
  const modelRows: AgentConfigOptionValue[] = [];
  let readingModels = false;
  for (const line of cleaned.split("\n")) {
    const trimmed = line.trim();
    if (/^Available models:/i.test(trimmed)) {
      readingModels = true;
      continue;
    }
    if (!readingModels || !trimmed) {
      continue;
    }
    const match = /^(?:\*\s*)?(\S+?)(?:\s+\(default\))?$/.exec(trimmed);
    const value = match?.[1]?.trim();
    if (!value || value.endsWith(":")) {
      continue;
    }
    modelRows.push({ value, name: formatGrokBuildModelName(value) });
  }
  if (!modelRows.some((option) => option.value === defaultModel)) {
    modelRows.unshift({
      value: defaultModel,
      name: formatGrokBuildModelName(defaultModel),
    });
  }
  const models = Array.from(
    new Map(modelRows.map((option) => [option.value, option])).values()
  );

  return [
    createGrokBuildModeConfigOption(),
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: defaultModel,
      description:
        "Models reported by the installed Grok Build CLI. A live ACP session refreshes this catalog.",
      options: models,
    },
  ];
}

export function createGrokBuildModeConfigOption(): AgentConfigOption {
  return {
    id: LEGACY_MODE_CONFIG_ID,
    name: "Mode",
    category: "mode",
    currentValue: "default",
    options: [
      { value: "default", name: "Build" },
      { value: "plan", name: "Plan" },
      { value: "ask", name: "Ask" },
    ],
  };
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

function resolveCodexAppServerInvocation(): CommandInvocation {
  const resolved = buildHarnessInvocation("codex", ["app-server"]);
  return resolved
    ? { command: resolved.command, args: resolved.args }
    : { command: "codex", args: ["app-server"] };
}

async function createCodexAppServerConfigOptions(): Promise<AgentConfigOption[]> {
  let transport: CodexAppServerTransport | null = null;
  try {
    const invocation = resolveCodexAppServerInvocation();
    transport = new CodexAppServerTransport({
      command: invocation.command,
      args: invocation.args,
      cwd: process.cwd(),
      processName: "Cesium Agent - Codex Model Discovery",
    });
    await transport.request("initialize", {
      clientInfo: {
        name: "cesium_codex_app_server_models",
        title: "Cesium Codex App Server Model Discovery",
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
  } catch (error) {
    logSeedProbeFailure(
      "codex-app-server",
      "codex app-server model/list probe failed (fallback catalog)",
      error
    );
    return createCodexAppServerFallbackConfigOptions();
  } finally {
    transport?.dispose();
  }
}

function createCursorSdkFallbackConfigOptions(): AgentConfigOption[] {
  return [
    {
      id: "mode",
      name: "Cesium Mode",
      category: "mode",
      currentValue: "agent",
      options: [
        { value: "agent", name: "Agent" },
        {
          value: "plan",
          name: "Plan",
          description: "Native Cursor SDK plan mode (explore and plan before editing).",
        },
        {
          value: "ask",
          name: "Ask",
          description: "Read-only guidance via a synthetic prompt prefix.",
        },
        {
          value: "debug",
          name: "Debug",
          description: "Debug-focused guidance via a synthetic prompt prefix.",
        },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      description: "Configure a Cursor API key or refresh the Cursor SDK catalog to load real models.",
      currentValue: "composer-2.5",
      options: [],
    },
    {
      id: "sdk_sandbox",
      name: "Local Sandbox",
      category: "permission",
      // "auto" defers to the Cursor SDK's own default (sandbox only when the
      // user's ~/.cursor/sandbox.json requests it) and falls back to running
      // unsandboxed when the environment cannot sandbox at all. Forcing
      // "enabled" on hosts without sandbox support (containers, VMs without
      // user namespaces, Windows) makes every run fail out of the box.
      currentValue: "auto",
      options: [
        {
          value: "auto",
          name: "Auto",
          description:
            "Use the Cursor SDK default; run unsandboxed when sandboxing is unsupported.",
        },
        {
          value: "enabled",
          name: "Enabled",
          description: "Require sandboxing; runs fail where it is unsupported.",
        },
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
    aliases?: string[];
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
          currentValue: pickDefaultCursorSdkModelValue(modelRows),
          options: modelRows,
        }
      : option
  );
}

function pickDefaultCursorSdkModelValue(
  rows: AgentConfigOption["options"]
): string {
  const values = rows.map((row) => row.value);
  const preferredIds = ["composer-2.5", "composer-latest", "composer-2"];
  for (const preferred of preferredIds) {
    const exact = values.find((value) => value === preferred);
    if (exact) {
      return exact;
    }
    const prefixed = values.find((value) => value.startsWith(`${preferred}[`));
    if (prefixed) {
      return prefixed;
    }
  }
  return values[0] ?? "composer-2.5";
}

function cursorSdkModelRows(model: {
  id: string;
  displayName: string;
  description?: string;
  aliases?: string[];
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
    ...(model.aliases ?? [])
      .map((alias) => alias.trim())
      .filter((alias) => alias.length > 0 && alias !== modelId)
      .map((alias) => ({
        value: alias,
        name: `${model.displayName || modelId} (${alias})`,
        ...(model.description ? { description: model.description } : {}),
        metadata: {
          ...cursorSdkModelMetadata(modelId, [], false),
          cursorSdkAlias: alias,
        },
      })),
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { Cursor } = await import("@cursor/sdk");
    const timeoutMs =
      Number.isFinite(CURSOR_SDK_MODEL_LIST_TIMEOUT_MS) && CURSOR_SDK_MODEL_LIST_TIMEOUT_MS > 0
        ? CURSOR_SDK_MODEL_LIST_TIMEOUT_MS
        : 15000;
    const models = await Promise.race([
      Cursor.models.list({ apiKey }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Cursor.models.list exceeded ${timeoutMs}ms`)),
          timeoutMs
        );
        timer.unref?.();
      }),
    ]);
    return cursorSdkConfigOptionsFromModels(models);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn("[agents] Cursor SDK model list failed (fallback catalog):", detail);
    return createCursorSdkFallbackConfigOptions();
  } finally {
    clearTimeout(timer);
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
      currentValue: "unlimited",
      options: [
        { value: "unlimited", name: "Unlimited", description: "No turn cap." },
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

async function createPiAgentConfigOptions(): Promise<AgentConfigOption[]> {
  return buildPiAgentSeedConfigOptions();
}

async function createGoogleAntigravityCliConfigOptions(): Promise<AgentConfigOption[]> {
  // Settings can live under an overridden or conventional home (packaged
  // launches rewrite HOME), so every home candidate is checked.
  let settings: Record<string, unknown> | null = null;
  for (const home of harnessHomeDirCandidates()) {
    const settingsPath = path.join(home, ".gemini", "antigravity-cli", "settings.json");
    settings = await readJsonFile<Record<string, unknown> | null>(settingsPath, null).catch(
      () => null
    );
    if (settings) {
      break;
    }
  }
  const configuredModel = typeof settings?.model === "string" && settings.model.trim()
    ? settings.model.trim()
    : "auto";
  const configuredPermission =
    typeof settings?.toolPermission === "string" && settings.toolPermission.trim()
      ? settings.toolPermission.trim()
      : "request-review";

  const modelOptions: AgentConfigOptionValue[] = [
    { value: "auto", name: "Auto" },
    configuredModel !== "auto"
      ? { value: configuredModel, name: configuredModel }
      : null,
    { value: "gemini-3-pro", name: "Gemini 3 Pro" },
    { value: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { value: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  ].filter((option): option is AgentConfigOptionValue => option !== null);
  const uniqueModelOptions = Array.from(
    new Map(modelOptions.map((option) => [option.value, option])).values()
  );

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
      currentValue: configuredModel,
      description:
        "Seeded from Antigravity CLI settings when available. The agy CLI owns the final model selection.",
      options: uniqueModelOptions,
    },
    {
      id: "permission",
      name: "Tool permission",
      category: "permission",
      currentValue: ["request-review", "proceed-in-sandbox", "always-proceed", "strict"].includes(
        configuredPermission
      )
        ? configuredPermission
        : "request-review",
      description:
        "Mapped to Antigravity CLI permission settings; OpenCursor does not manage Google OAuth tokens.",
      options: [
        { value: "request-review", name: "Request review" },
        { value: "proceed-in-sandbox", name: "Proceed in sandbox" },
        { value: "always-proceed", name: "Always proceed" },
        { value: "strict", name: "Strict" },
      ],
    },
  ];
}

async function createSeedConfigOptions(backendId: AgentBackendId): Promise<AgentConfigOption[]> {
  switch (backendId) {
    case "cesium-agent":
      return createCesiumAgentConfigOptions();
    case "cursor-sdk":
      return createCursorSdkConfigOptions();
    case "opencode-server":
    case "opencode-v2-beta": {
      const generation = resolveOpenCodeGeneration({ backendId });
      if (generation === "v2-beta") {
        return createOpenCodeV2ConfigOptions();
      }
      return createOpenCodeServerConfigOptions();
    }
    case "devin-acp":
      return createDevinCliConfigOptions();
    case "grok-build":
      return createGrokBuildConfigOptions();
    case "codex-app-server":
      return createCodexAppServerConfigOptions();
    case "claude-code-sdk":
      return createClaudeCodeSdkConfigOptions();
    case "pi-agent":
      return createPiAgentConfigOptions();
    case "google-antigravity-cli":
      return createGoogleAntigravityCliConfigOptions();
    default:
      return [];
  }
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

export function isStaleCodexAppServerCache(configOptions: AgentConfigOption[]): boolean {
  const modelOption = configOptions.find((option) => option.id === "model");
  if (!modelOption || modelOption.options.length === 0) {
    return true;
  }

  const modelIds = modelOption.options.map((option) => option.value);
  const hasLegacyCodex51Catalog = modelIds.some((value) => /^gpt-5\.1(?:-|$)/.test(value));
  const hasModernCodexCatalog = modelIds.some((value) => /^gpt-5\.[2-9](?:-|$)/.test(value));
  return hasLegacyCodex51Catalog && !hasModernCodexCatalog;
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

function hasUsableModelOptions(configOptions: AgentConfigOption[]): boolean {
  const modelOption = configOptions.find((option) => option.category === "model");
  return Boolean(modelOption && modelOption.options.length > 0);
}

function hasRichModelCatalog(configOptions: AgentConfigOption[], backendId: AgentBackendId): boolean {
  if (backendId === "pi-agent") {
    return hasPiAgentRichModelCatalog(configOptions);
  }
  return hasUsableModelOptions(configOptions);
}

async function readStoredConfigOptions(
  backendId: AgentBackendId
): Promise<AgentConfigOption[]> {
  const record = await (await getStorage()).readProviderCache(backendId);
  return record && Array.isArray(record.configOptions) ? record.configOptions : [];
}

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
        const existing = await readStoredConfigOptions(backendId).catch(() => []);
        if (hasRichModelCatalog(seeded, backendId) || !hasRichModelCatalog(existing, backendId)) {
          await writeAgentBackendConfigCache(backendId, seeded);
        }
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
const SKIP_WARMUP_BACKENDS = new Set<AgentBackendId>();

function shouldWarmupBackendAtBoot(backendId: AgentBackendId): boolean {
  if (SKIP_WARMUP_BACKENDS.has(backendId)) {
    if (backendId === "codex-app-server") {
      return process.env.OPENCURSOR_WARMUP_CODEX_APP_SERVER === "1";
    }
    if (backendId === "opencode-server") {
      return process.env.OPENCURSOR_WARMUP_OPENCODE_SERVER === "1";
    }
    if (backendId === "opencode-v2-beta") {
      return process.env.OPENCURSOR_WARMUP_OPENCODE_V2_SERVER === "1";
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
 * Existing persisted cache entries are also treated as stale after a fresh
 * server start, so the first UI request converges on the live provider catalog
 * instead of re-serving a previous Electron install's partial data.
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
  // A user-triggered refresh should also notice CLIs installed since the last
  // detection pass, so the discovery cache is dropped up front.
  refreshHarnessCliDetection();
  const byBackend: Record<string, AgentConfigOption[]> = {};
  const timedOut: AgentBackendId[] = [];
  const failed: AgentBackendId[] = [];

  const results = await Promise.allSettled(
    backendIds.map(async (backendId) => {
      const refreshPromise = startSeedRefresh(backendId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          refreshPromise,
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), FORCE_REFRESH_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
        return { backendId, result };
      } finally {
        // A won race must not leave the loser's timer pinning the event loop.
        clearTimeout(timer);
      }
    })
  );

  for (let index = 0; index < results.length; index += 1) {
    const settled = results[index]!;
    if (settled.status === "rejected") {
      failed.push(backendIds[index]!);
      continue;
    }
    const { backendId, result } = settled.value;
    if (result === "timeout") {
      timedOut.push(backendId);
      const cached = await readStoredConfigOptions(backendId).catch(() => []);
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
  if (backendId === "cursor-sdk" && isStaleCursorSdkCache(cachedOptions)) {
    return { upgraded: cachedOptions, needsReseed: true };
  }

  if (backendId === "pi-agent" && isPiAgentPlaceholderModelCatalog(cachedOptions)) {
    return { upgraded: cachedOptions, needsReseed: true };
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
      hasGeneratedFallbackModels ||
      isStaleCodexAppServerCache(cachedOptions)
    ) {
      return { upgraded: cachedOptions, needsReseed: true };
    }
  }

  if (backendId === "opencode-server" || backendId === "opencode-v2-beta") {
    const hasModel = cachedOptions.some((option) => option.id === "model");
    const hasAgent = cachedOptions.some((option) => option.id === "agent" || option.id === "mode");
    const hasGeneration = cachedOptions.some((option) => option.id === "generation");
    if (!hasModel || !hasAgent || !hasGeneration) {
      return {
        upgraded: withOpenCodeGenerationOption(cachedOptions),
        needsReseed: !hasModel || !hasAgent,
      };
    }
  }

  if (backendId === "grok-build") {
    const hasModel = cachedOptions.some((option) => option.category === "model");
    const hasMode = cachedOptions.some((option) => option.category === "mode");
    if (!hasModel || !hasMode) {
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
        return startSeedRefresh(backendId)
          .then((refreshed) => {
            if (
              refreshed.length === 0 ||
              (!hasRichModelCatalog(refreshed, backendId) &&
                hasRichModelCatalog(migration.upgraded, backendId))
            ) {
              return migration.upgraded;
            }
            return refreshed;
          })
          .catch(() => migration.upgraded);
      }
      return migration.upgraded;
    }

    const cacheIsFresh =
      Date.now() - record.updatedAt <= CACHE_TTL_MS &&
      record.updatedAt >= SERVER_STARTED_AT;
    if (cacheIsFresh && hasRichModelCatalog(cachedOptions, backendId)) {
      return cachedOptions;
    }

    return startSeedRefresh(backendId)
      .then((refreshed) => {
        if (
          refreshed.length === 0 ||
          (!hasRichModelCatalog(refreshed, backendId) &&
            hasRichModelCatalog(cachedOptions, backendId))
        ) {
          return cachedOptions;
        }
        return refreshed;
      })
      .catch(() => cachedOptions);
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
