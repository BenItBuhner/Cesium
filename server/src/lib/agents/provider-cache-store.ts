import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { readJsonFile } from "../persistence.js";
import { getStorage } from "../../storage/runtime.js";
import { spawnSafeEnv } from "./spawn-env.js";
import type { AgentBackendId, AgentConfigOption } from "./types.js";

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

async function createSeedConfigOptions(backendId: AgentBackendId): Promise<AgentConfigOption[]> {
  switch (backendId) {
    case "cursor-acp":
      return createCursorCliConfigOptions();
    case "opencode-acp":
      return createOpenCodeCliConfigOptions();
    case "gemini-acp":
      return createGeminiCliConfigOptions();
    case "codex-adapter":
      return createCodexSeedConfigOptions();
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

/** 
 * Eagerly refresh every backend's config cache in the background. Intended for
 * server boot: kicks off CLI probes without blocking startup, so the first
 * request finds a warm cache rather than paying the CLI latency tax itself.
 */
export function warmupAgentBackendCaches(
  backendIds: AgentBackendId[]
): Promise<void> {
  return Promise.allSettled(
    backendIds.map((backendId) => startSeedRefresh(backendId))
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
