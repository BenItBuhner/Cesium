/**
 * Live smoke: Claude Agent SDK `query()` against Anthropic auth + ANTHROPIC_BASE_URL
 * (e.g. OpenAI-compatible / Anthropic-shim proxy). Does not start the OpenCursor HTTP server.
 *
 * Loads repo/server `.env` only where variables are unset (no override), so a key passed
 * from the shell / CI is not clobbered by `.env.local` (unlike `env-bootstrap.js`).
 *
 * Scenarios:
 *   basic   — ping prompt, no tools (default)
 *   tools   — safe-readonly profile; forces read + grep in temp workspace
 *   harness — multi-tool matrix; writes normalized JSONL and fails if tool kinds missing
 */
import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import {
  claudeToolUseToAgentEvent,
  toolUsesFromClaudeAssistantMessage,
} from "../src/lib/agents/claude-code-sdk-normalize.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, "..");
const repoRoot = path.resolve(serverDir, "..");

config({ path: path.join(repoRoot, ".env") });
config({ path: path.join(repoRoot, ".env.local") });
config({ path: path.join(serverDir, ".env") });
config({ path: path.join(serverDir, ".env.local") });

type Scenario = "basic" | "tools" | "harness";

type ProbeArgs = {
  cwd: string;
  model: string;
  scenario: Scenario;
  out: string;
};

const SCENARIO_PROMPTS: Record<Scenario, string> = {
  basic: "Reply with exactly one word: pong.",
  tools:
    "Read README.md in the current directory, then grep for the word Probe. Reply with the first matching line only.",
  harness:
    "In order: (1) Glob for *.md files, (2) Read README.md, (3) Grep for Probe, (4) run `echo harness-ok` in Bash. Summarize each step briefly.",
};

const HARNESS_EXPECTED_TOOL_KINDS = new Set(["read", "grep", "glob", "terminal"]);

function parseArgs(argv: string[]): ProbeArgs {
  const out: Partial<ProbeArgs> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--cwd" && next) {
      out.cwd = path.resolve(next);
      index += 1;
    } else if (arg === "--model" && next) {
      out.model = next;
      index += 1;
    } else if (arg === "--scenario" && next) {
      out.scenario = next as Scenario;
      index += 1;
    } else if (arg === "--out" && next) {
      out.out = path.resolve(next);
      index += 1;
    }
  }
  const cwd = out.cwd ?? path.join(os.tmpdir(), "cesium-claude-sdk-probe");
  return {
    cwd,
    model:
      out.model ??
      process.env.CLAUDE_PROXY_TEST_MODEL?.trim() ??
      process.env.OPENCURSOR_CLAUDE_CODE_SDK_MODEL?.trim() ??
      "glm-5.1-precision",
    scenario: out.scenario ?? (process.env.CLAUDE_PROXY_TEST_SCENARIO?.trim() as Scenario) ?? "basic",
    out: out.out ?? path.join(cwd, "claude-harness-events.jsonl"),
  };
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function ensureProbeWorkspace(cwd: string): Promise<void> {
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(
    path.join(cwd, "README.md"),
    "# Claude Harness Probe\n\nProbe workspace for Claude Code SDK tool smoke tests.\n",
    "utf8"
  );
}

function toolsForScenario(scenario: Scenario): Options["tools"] {
  if (scenario === "basic") {
    return [];
  }
  if (scenario === "harness") {
    return { type: "preset", preset: "claude_code" };
  }
  return ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.scenario !== "basic") {
    await ensureProbeWorkspace(args.cwd);
  }

  process.env.ANTHROPIC_BASE_URL ||= process.env.OPENCURSOR_CLAUDE_CODE_SDK_BASE_URL?.trim();
  process.env.ANTHROPIC_API_KEY ||= process.env.OPENCURSOR_CLAUDE_CODE_SDK_API_KEY?.trim();
  if (
    process.env.OPENCURSOR_CLAUDE_CODE_SDK_BASE_URL?.trim() &&
    process.env.OPENCURSOR_CLAUDE_CODE_SDK_API_KEY?.trim()
  ) {
    process.env.CLAUDE_CODE_API_BASE_URL ||= process.env.OPENCURSOR_CLAUDE_CODE_SDK_BASE_URL.trim();
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }

  if (!process.env.ANTHROPIC_API_KEY?.trim() && !process.env.ANTHROPIC_AUTH_TOKEN?.trim()) {
    console.error("claude-code-sdk-proxy-probe: set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN");
    process.exit(2);
  }

  const cwd = args.scenario === "basic" ? process.env.CLAUDE_PROXY_TEST_CWD?.trim() || repoRoot : args.cwd;
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
  const pathToClaudeCodeExecutable =
    process.env.OPENCURSOR_CLAUDE_CODE_SDK_PATH?.trim() ||
    process.env.OPENCURSOR_CLAUDE_BIN?.trim() ||
    undefined;

  console.log("claude-code-sdk-proxy-probe:", {
    model: args.model,
    cwd,
    scenario: args.scenario,
    out: args.out,
    baseUrl: baseUrl || "(default api.anthropic.com)",
    pathToClaudeCodeExecutable: pathToClaudeCodeExecutable ? "[configured]" : "[default]",
    anthropicApiKeyLen: process.env.ANTHROPIC_API_KEY?.length ?? 0,
    anthropicAuthTokenLen: process.env.ANTHROPIC_AUTH_TOKEN?.length ?? 0,
  });

  if (args.scenario !== "basic") {
    await fs.rm(args.out, { force: true }).catch(() => undefined);
    await appendJsonLine(args.out, { type: "probe_start", scenario: args.scenario, cwd, model: args.model });
  }

  const prompt =
    process.env.CLAUDE_PROXY_TEST_PROMPT?.trim() || SCENARIO_PROMPTS[args.scenario] || SCENARIO_PROMPTS.basic;
  const abortController = new AbortController();
  const conversationId = randomUUID();
  const observedToolKinds = new Set<string>();

  const stream = query({
    prompt,
    options: {
      cwd,
      abortController,
      pathToClaudeCodeExecutable,
      model: args.model,
      tools: toolsForScenario(args.scenario),
      permissionMode: "dontAsk",
      includePartialMessages: false,
      maxTurns: args.scenario === "basic" ? 4 : 12,
      extraArgs: {
        bare: null,
        "setting-sources": "local",
      },
    },
  });

  let n = 0;
  let authRetryCount = 0;
  try {
    for await (const message of stream) {
      n += 1;
      const kind =
        message && typeof message === "object" && "type" in message
          ? String((message as { type: unknown }).type)
          : typeof message;
      const preview = JSON.stringify(message);
      console.log(`#${n} [${kind}]`, preview.length > 500 ? `${preview.slice(0, 500)}…` : preview);

      if (args.scenario !== "basic") {
        await appendJsonLine(args.out, { type: "raw", index: n, message });
        for (const tool of toolUsesFromClaudeAssistantMessage(message)) {
          const normalized = claudeToolUseToAgentEvent({
            conversationId,
            eventId: randomUUID(),
            status: "in_progress",
            tool,
          });
          observedToolKinds.add(normalized.toolKind);
          await appendJsonLine(args.out, { type: "normalized", toolKind: normalized.toolKind, event: normalized });
        }
      }

      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        (message as { type: string }).type === "system" &&
        "subtype" in message &&
        (message as { subtype: string }).subtype === "api_retry"
      ) {
        const err = (message as { error?: string; error_status?: number }).error;
        const status = (message as { error_status?: number }).error_status;
        if (status === 401 || err === "authentication_failed") {
          authRetryCount += 1;
          if (authRetryCount >= 2) {
            console.error(
              "claude-code-sdk-proxy-probe: proxy auth failed repeatedly (401). Aborting early — fix ANTHROPIC_BASE_URL / key on the Model-Proxy side."
            );
            abortController.abort();
            process.exit(3);
          }
        }
      }
    }

    if (args.scenario === "harness") {
      const missing = [...HARNESS_EXPECTED_TOOL_KINDS].filter((kind) => !observedToolKinds.has(kind));
      await appendJsonLine(args.out, {
        type: "probe_end",
        observedToolKinds: [...observedToolKinds],
        missingToolKinds: missing,
      });
      if (missing.length > 0) {
        console.error(
          `claude-code-sdk-proxy-probe: harness scenario missing normalized tool kinds: ${missing.join(", ")}`
        );
        console.error(`observed: ${[...observedToolKinds].join(", ") || "(none)"}`);
        process.exit(4);
      }
    } else if (args.scenario !== "basic") {
      await appendJsonLine(args.out, {
        type: "probe_end",
        observedToolKinds: [...observedToolKinds],
      });
    }

    console.log(`claude-code-sdk-proxy-probe: ok, ${n} message(s)`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("claude-code-sdk-proxy-probe: FAILED:", msg);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
