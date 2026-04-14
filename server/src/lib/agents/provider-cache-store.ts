import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, readJsonFile, writeJsonFile } from "../persistence.js";
import { spawnSafeEnv } from "./spawn-env.js";
import type { AgentBackendId, AgentConfigOption } from "./types.js";

type AgentBackendCacheRecord = {
  schemaVersion: 1;
  backendId: AgentBackendId;
  updatedAt: number;
  configOptions: AgentConfigOption[];
};

const CACHE_TTL_MS = 5 * 60 * 1000;

function getBackendCacheFile(backendId: AgentBackendId): string {
  return path.join(DATA_DIR, "profile", "agent-backends", `${backendId}.json`);
}

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

export async function createCursorCliConfigOptions(input?: {
  command?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<AgentConfigOption[]> {
  const command = input?.command ?? process.env.OPENCURSOR_CURSOR_CLI_BIN ?? "agent";
  const raw = await execFileText(command, ["--list-models"], {
    cwd: input?.cwd,
    env: input?.env,
  }).catch(() => "");
  const cleaned = stripAnsi(raw);
  const options: AgentConfigOption["options"] = [];
  let currentValue = "auto";

  for (const line of cleaned.split("\n")) {
    const trimmed = line.trim();
    const match = /^([a-z0-9._-]+)\s+-\s+(.+?)(?:\s+\(([^)]+)\))?$/.exec(trimmed);
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
    }
    options.push({ value, name });
  }

  if (options.length === 0) {
    return [];
  }

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
      currentValue,
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

function isCursorCliSeedConfigOptions(configOptions: AgentConfigOption[]): boolean {
  const modelOption = configOptions.find((option) => option.category === "model");
  if (!modelOption || modelOption.options.length === 0) {
    return false;
  }
  if (
    configOptions.some(
      (option) =>
        option.category === "thought_level" || option.id === "model_reasoning_effort"
    )
  ) {
    return false;
  }
  return !modelOption.currentValue.includes("[") &&
    modelOption.options.every((option) => !option.value.includes("["));
}

export async function readAgentBackendConfigCache(
  backendId: AgentBackendId
): Promise<AgentConfigOption[]> {
  const fresh = await createSeedConfigOptions(backendId).catch(() => []);
  if (fresh.length > 0) {
    await writeAgentBackendConfigCache(backendId, fresh);
    return fresh;
  }

  const record = await readJsonFile<AgentBackendCacheRecord | null>(
    getBackendCacheFile(backendId),
    null
  );
  if (
    record &&
    record.schemaVersion === 1 &&
    record.backendId === backendId &&
    Array.isArray(record.configOptions) &&
    record.configOptions.length > 0
  ) {
    if (Date.now() - record.updatedAt > CACHE_TTL_MS) {
      const seeded = await createSeedConfigOptions(backendId);
      await writeAgentBackendConfigCache(backendId, seeded);
      return seeded;
    }
    if (backendId === "cursor-acp" && !isCursorCliSeedConfigOptions(record.configOptions)) {
      const seeded = await createSeedConfigOptions(backendId);
      await writeAgentBackendConfigCache(backendId, seeded);
      return seeded;
    }
    if (
      backendId === "codex-adapter" &&
      !record.configOptions.some(
        (option) =>
          option.category === "model" &&
          option.options.some(
            (value) =>
              Array.isArray(value.metadata?.reasoningLevels) &&
              value.metadata.reasoningLevels.length > 0
          )
      )
    ) {
      const seeded = await createSeedConfigOptions(backendId);
      await writeAgentBackendConfigCache(backendId, seeded);
      return seeded;
    }
    if (backendId === "codex-adapter") {
      const next = record.configOptions.map((option) => {
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
      const hasPermissionOption = next.some((option) => option.id === "permission");
      const hasWebSearchOption = next.some((option) => option.id === "web_search");
      if (!hasPermissionOption || !hasWebSearchOption) {
        const seeded = await createCodexSeedConfigOptions();
        await writeAgentBackendConfigCache(backendId, seeded);
        return seeded;
      }
      if (JSON.stringify(next) !== JSON.stringify(record.configOptions)) {
        await writeAgentBackendConfigCache(backendId, next);
        return next;
      }
    }
    if (
      backendId === "claude-adapter" &&
      (!record.configOptions.some(
        (option) =>
          option.category === "model" &&
          option.options.some((value) => value.value === "glm-5.1")
      ) ||
        !record.configOptions.some(
          (option) =>
            option.category === "permission" &&
            option.options.some((value) => value.value === "bypassPermissions")
        ))
    ) {
      const seeded = await createSeedConfigOptions(backendId);
      await writeAgentBackendConfigCache(backendId, seeded);
      return seeded;
    }
    return record.configOptions;
  }
  return createSeedConfigOptions(backendId);
}

export async function writeAgentBackendConfigCache(
  backendId: AgentBackendId,
  configOptions: AgentConfigOption[]
): Promise<void> {
  if (configOptions.length === 0) {
    return;
  }
  await writeJsonFile(getBackendCacheFile(backendId), {
    schemaVersion: 1,
    backendId,
    updatedAt: Date.now(),
    configOptions,
  } satisfies AgentBackendCacheRecord);
}
