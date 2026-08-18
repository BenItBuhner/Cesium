import { detectHarnessCli } from "./harness-runtime.js";
import type { AgentConfigOption } from "./types.js";

/** Dialects packaged inside the single OpenCode harness. */
export type OpenCodeGeneration = "current" | "v2-beta";

export const OPENCODE_GENERATION_OPTION_ID = "generation";

export function parseOpenCodeGeneration(value: unknown): OpenCodeGeneration | undefined {
  if (value === "current" || value === "v1" || value === "opencode") {
    return "current";
  }
  if (value === "v2-beta" || value === "v2" || value === "opencode2") {
    return "v2-beta";
  }
  return undefined;
}

export function openCodeGenerationOption(
  current: OpenCodeGeneration = "current"
): AgentConfigOption {
  return {
    id: OPENCODE_GENERATION_OPTION_ID,
    name: "OpenCode generation",
    category: "other",
    currentValue: current,
    description:
      "Current talks to OpenCode 1 (`opencode serve`). v2 Beta talks to OpenCode 2 (`opencode2`) with durable logs, background subagents, PTY/shell, forms, and v2 permissions. Keep v2 packaged here until OpenCode standardizes 2.0.",
    options: [
      {
        value: "current",
        name: "Current",
        description: "OpenCode 1 HTTP/SSE API (`/session`, `/global/event`, experimental backgrounding).",
      },
      {
        value: "v2-beta",
        name: "v2 Beta",
        description:
          "OpenCode 2 beta API (`/api/session`, durable session logs, background subagents, PTY, shell, plugins).",
      },
    ],
  };
}

export function withOpenCodeGenerationOption(
  options: AgentConfigOption[],
  current?: OpenCodeGeneration
): AgentConfigOption[] {
  const existing = parseOpenCodeGeneration(
    options.find((option) => option.id === OPENCODE_GENERATION_OPTION_ID)?.currentValue
  );
  const generation = current ?? existing ?? "current";
  return [
    openCodeGenerationOption(generation),
    ...options.filter((option) => option.id !== OPENCODE_GENERATION_OPTION_ID),
  ];
}

export function readOpenCodeGeneration(
  options: AgentConfigOption[] | undefined
): OpenCodeGeneration | undefined {
  if (!options) {
    return undefined;
  }
  return parseOpenCodeGeneration(
    options.find((option) => option.id === OPENCODE_GENERATION_OPTION_ID)?.currentValue
  );
}

/**
 * Picks the OpenCode HTTP dialect for a chat.
 *
 * Order: conversation option → legacy v2 backend id → explicit env protocol →
 * configured v2 URL → auto (only-v2-binary) → current.
 */
export function resolveOpenCodeGeneration(input?: {
  options?: AgentConfigOption[];
  backendId?: string | null;
}): OpenCodeGeneration {
  const fromOptions = readOpenCodeGeneration(input?.options);
  if (fromOptions) {
    return fromOptions;
  }
  if (input?.backendId === "opencode-v2-beta") {
    return "v2-beta";
  }

  const env = process.env.OPENCURSOR_OPENCODE_PROTOCOL?.trim().toLowerCase();
  const parsedEnv = parseOpenCodeGeneration(env);
  if (parsedEnv && env !== "auto") {
    return parsedEnv;
  }

  if (process.env.OPENCURSOR_OPENCODE_V2_SERVER_URL?.trim()) {
    return "v2-beta";
  }

  const hasCurrent =
    Boolean(process.env.OPENCURSOR_OPENCODE_SERVER_URL?.trim()) ||
    detectHarnessCli("opencode") !== null;
  const hasV2 = detectHarnessCli("opencode-v2") !== null;
  if (!hasCurrent && hasV2) {
    return "v2-beta";
  }
  return "current";
}

export function openCodeHarnessAvailable(): boolean {
  return Boolean(
    process.env.OPENCURSOR_OPENCODE_SERVER_URL?.trim() ||
      process.env.OPENCURSOR_OPENCODE_V2_SERVER_URL?.trim() ||
      detectHarnessCli("opencode") ||
      detectHarnessCli("opencode-v2")
  );
}

export function openCodeHarnessCommandPreview(): string {
  const currentUrl = process.env.OPENCURSOR_OPENCODE_SERVER_URL?.trim();
  const v2Url = process.env.OPENCURSOR_OPENCODE_V2_SERVER_URL?.trim();
  if (currentUrl && v2Url) {
    return `OpenCode at ${currentUrl} · v2 at ${v2Url}`;
  }
  if (currentUrl) {
    return `OpenCode server at ${currentUrl}`;
  }
  if (v2Url) {
    return `OpenCode v2 server at ${v2Url}`;
  }
  const current = detectHarnessCli("opencode");
  const v2 = detectHarnessCli("opencode-v2");
  if (current && v2) {
    return `${current.executablePath} serve · ${v2.executablePath} serve`;
  }
  if (current) {
    return `${current.executablePath} serve`;
  }
  if (v2) {
    return `${v2.executablePath} serve`;
  }
  return "OpenCode server not configured";
}

export function ensureOpenCodeGenerationOption(
  options: AgentConfigOption[],
  conversation?: { config?: { backendId?: string }; configOptions?: AgentConfigOption[] }
): AgentConfigOption[] {
  return withOpenCodeGenerationOption(
    options,
    resolveOpenCodeGeneration({
      options: conversation?.configOptions?.length ? conversation.configOptions : options,
      backendId: conversation?.config?.backendId,
    })
  );
}
