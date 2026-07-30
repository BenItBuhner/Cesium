/**
 * Real-harness session drivers for the cross-harness compaction benchmark.
 *
 * Every driver exposes the same tiny surface — send a user message, get the
 * assistant's reply — while the underlying REAL harness (Codex CLI, Claude
 * Code, OpenCode, or Cesium) manages its own history, its own compaction, and
 * its own model calls against the same Model-Proxy endpoint and model.
 *
 * Isolation: each session gets its own home/config/data directory and working
 * directory under /tmp so parallel runs never share state.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export type HarnessSessionOptions = {
  /** OpenAI-compatible base URL (chat + responses). */
  baseUrl: string;
  /** API key for the proxy. */
  apiKey: string;
  /** Model id on the proxy (e.g. kimi-k3). */
  model: string;
  /** Context-window constraint, applied where the harness supports it. */
  contextWindowTokens: number;
  /** Working directory for the session (created if missing). */
  workDir: string;
  /** Per-send timeout. */
  sendTimeoutMs?: number;
  /** Extra environment variables (e.g. for tool-enabled e2e runs). */
  env?: Record<string, string>;
  /** Allow the harness to edit files / run commands inside workDir. */
  allowTools?: boolean;
};

export type HarnessSession = {
  send(text: string): Promise<string>;
  dispose(): Promise<void>;
};

export type HarnessDriver = {
  id: string;
  label: string;
  /** True when the harness supports an explicit context-window override. */
  supportsWindowOverride: boolean;
  createSession(options: HarnessSessionOptions): Promise<HarnessSession>;
};

const DEFAULT_SEND_TIMEOUT_MS = 420_000;

function npmGlobalBin(): string {
  return path.join(os.homedir(), ".npm-global", "bin");
}

async function run(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    timeoutMs: number;
    stdin?: string;
  }
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        PATH: `${npmGlobalBin()}:${process.env.PATH ?? ""}`,
        // spawn's cwd does NOT update the inherited PWD env var, and some CLIs
        // (OpenCode) resolve their project root from PWD rather than cwd.
        PWD: options.cwd,
        ...options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    if (options.stdin != null) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Codex CLI
// ---------------------------------------------------------------------------

export const codexDriver: HarnessDriver = {
  id: "codex",
  label: "OpenAI Codex CLI",
  supportsWindowOverride: true,
  async createSession(options) {
    const home = path.join(options.workDir, ".codex-home");
    mkdirSync(home, { recursive: true });
    mkdirSync(options.workDir, { recursive: true });
    writeFileSync(
      path.join(home, "config.toml"),
      [
        `model = "${options.model}"`,
        `model_provider = "techlit"`,
        `model_context_window = ${options.contextWindowTokens}`,
        `approval_policy = "never"`,
        `sandbox_mode = "${options.allowTools ? "workspace-write" : "read-only"}"`,
        ``,
        `[model_providers.techlit]`,
        `name = "Techlit proxy"`,
        `base_url = "${options.baseUrl}"`,
        `env_key = "TECHLIT_API_KEY"`,
        `wire_api = "responses"`,
        ``,
      ].join("\n")
    );
    const env = {
      CODEX_HOME: home,
      TECHLIT_API_KEY: options.apiKey,
      ...options.env,
    };
    let started = false;
    const lastMessagePath = path.join(options.workDir, ".codex-last-message.txt");
    const send = async (text: string): Promise<string> => {
      // `codex exec resume` accepts a narrower flag set than `codex exec`;
      // sandbox/approval policy live in config.toml so both paths behave alike.
      const baseArgs = [
        "exec",
        ...(started ? ["resume", "--last"] : []),
        "--skip-git-repo-check",
        "--output-last-message",
        lastMessagePath,
        text,
      ];
      const result = await run("codex", baseArgs, {
        cwd: options.workDir,
        env,
        timeoutMs: options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
      });
      started = true;
      if (result.code !== 0) {
        throw new Error(
          `codex exec exited ${result.code}: ${(result.stderr || result.stdout).slice(-600)}`
        );
      }
      try {
        const { readFileSync } = await import("node:fs");
        const last = readFileSync(lastMessagePath, "utf8").trim();
        if (last) {
          return last;
        }
      } catch {
        // fall through to stdout parsing
      }
      return result.stdout.trim().split("\n").slice(-8).join("\n");
    };
    return {
      send,
      async dispose() {
        rmSync(home, { recursive: true, force: true });
      },
    };
  },
};

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

export const openCodeDriver: HarnessDriver = {
  id: "opencode",
  label: "OpenCode CLI",
  supportsWindowOverride: true,
  async createSession(options) {
    mkdirSync(options.workDir, { recursive: true });
    const dataHome = path.join(options.workDir, ".opencode-data");
    mkdirSync(dataHome, { recursive: true });
    writeFileSync(
      path.join(options.workDir, "opencode.json"),
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          provider: {
            techlit: {
              npm: "@ai-sdk/openai-compatible",
              name: "Techlit",
              options: { baseURL: options.baseUrl, apiKey: "{env:TECHLIT_API_KEY}" },
              models: {
                [options.model]: {
                  name: options.model,
                  limit: { context: options.contextWindowTokens, output: 8192 },
                },
              },
            },
          },
          model: `techlit/${options.model}`,
          ...(options.allowTools
            ? {}
            : { permission: { edit: "deny", bash: "deny", webfetch: "deny" } }),
        },
        null,
        2
      )
    );
    const env: Record<string, string> = {
      XDG_DATA_HOME: dataHome,
      TECHLIT_API_KEY: options.apiKey,
      ...(options.allowTools
        ? { OPENCODE_PERMISSION: JSON.stringify({ edit: "allow", bash: "allow" }) }
        : {}),
      ...options.env,
    };
    let started = false;
    const send = async (text: string): Promise<string> => {
      const args = [
        "run",
        "--pure",
        "-m",
        `techlit/${options.model}`,
        ...(started ? ["-c"] : []),
        ...(options.allowTools ? ["--auto"] : []),
        text,
      ];
      const result = await run("opencode", args, {
        cwd: options.workDir,
        env,
        timeoutMs: options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
      });
      started = true;
      if (result.code !== 0) {
        throw new Error(
          `opencode run exited ${result.code}: ${(result.stderr || result.stdout).slice(-600)}`
        );
      }
      // Strip ANSI escapes and the "> build · model" banner lines.
      const cleaned = result.stdout
        .replace(/\u001b\[[0-9;]*m/g, "")
        .split("\n")
        .filter((line) => !/^\s*>\s+\w+ · /.test(line))
        .join("\n")
        .trim();
      return cleaned;
    };
    return {
      send,
      async dispose() {
        rmSync(dataHome, { recursive: true, force: true });
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

export const claudeDriver: HarnessDriver = {
  id: "claude",
  label: "Claude Code CLI",
  // No documented context-window override for third-party models; Claude Code
  // manages its own auto-compact threshold. We can force /compact explicitly.
  supportsWindowOverride: false,
  async createSession(options) {
    mkdirSync(options.workDir, { recursive: true });
    const configDir = path.join(options.workDir, ".claude-config");
    mkdirSync(configDir, { recursive: true });
    // The base URL for Anthropic-format requests is the host root (Claude Code
    // appends /v1/messages itself).
    const anthropicBase = options.baseUrl.replace(/\/v1\/?$/, "");
    const env = {
      CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_BASE_URL: anthropicBase,
      ANTHROPIC_AUTH_TOKEN: options.apiKey,
      ANTHROPIC_MODEL: options.model,
      // Leave ANTHROPIC_SMALL_FAST_MODEL unset: routing background calls to a
      // second proxy model caused hard failures in testing.
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      ...options.env,
    };
    let started = false;
    const send = async (text: string): Promise<string> => {
      // NOTE: variadic flags (--allowedTools) would swallow the prompt
      // positional; in no-tools mode we rely on -p's default behavior of
      // failing permission prompts instead.
      const args = [
        "--bare",
        "-p",
        ...(started ? ["-c"] : []),
        "--output-format",
        "text",
        "--model",
        options.model,
        ...(options.allowTools ? ["--dangerously-skip-permissions"] : []),
        text,
      ];
      const result = await run("claude", args, {
        cwd: options.workDir,
        env,
        timeoutMs: options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
      });
      started = true;
      if (result.code !== 0) {
        throw new Error(
          `claude exited ${result.code}: ${(result.stderr || result.stdout).slice(-600)}`
        );
      }
      return result.stdout.trim();
    };
    return {
      send,
      async dispose() {
        rmSync(configDir, { recursive: true, force: true });
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Cesium (first-party) — drives the local dev server over HTTP.
// ---------------------------------------------------------------------------

export type CesiumDriverConfig = {
  serverUrl: string;
  workspaceId: string;
  /** cesium model id, e.g. techlit/kimi-k3 */
  modelId: string;
};

export function cesiumDriver(config: CesiumDriverConfig): HarnessDriver {
  return {
    id: "cesium",
    label: "Cesium agent (ledger compaction)",
    supportsWindowOverride: true, // via CESIUM_MODELS on the server process
    async createSession(options) {
      let workspaceId = config.workspaceId;
      const api = async (route: string, body?: unknown, method?: string): Promise<any> => {
        const response = await fetch(`${config.serverUrl}${route}`, {
          method: method ?? (body != null ? "POST" : "GET"),
          headers: {
            "x-opencursor-workspace-id": workspaceId,
            ...(body != null ? { "content-type": "application/json" } : {}),
          },
          ...(body != null ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) {
          throw new Error(`cesium ${route} -> HTTP ${response.status}: ${await response.text()}`);
        }
        return response.json();
      };
      if (options.allowTools) {
        // Tool-enabled e2e runs operate on the session's fabricated repo:
        // register it as a workspace and auto-allow edit/terminal permissions
        // (bench server instance only).
        mkdirSync(options.workDir, { recursive: true });
        const opened = await api("/api/workspaces/open", { root: options.workDir });
        workspaceId = opened.workspace.id;
        await api(
          "/api/settings/cesium-agent",
          { toolPermissions: { editFile: "allow", terminal: "allow" } },
          "PATCH"
        );
      }
      const created = await api("/api/agents/conversations", {
        backendId: "cesium-agent",
        modelId: config.modelId,
        mode: "agent",
        title: `bench-${path.basename(options.workDir)}`,
      });
      const conversationId: string = created.conversation.id;
      let baselineSeq = 0;
      const send = async (text: string): Promise<string> => {
        await api(`/api/agents/conversations/${conversationId}/prompt`, { text });
        const deadline = Date.now() + (options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS);
        for (;;) {
          if (Date.now() > deadline) {
            throw new Error("cesium send timed out waiting for idle");
          }
          await new Promise((resolve) => setTimeout(resolve, 2_500));
          const snapshot = (await api(`/api/agents/conversations/${conversationId}`)).snapshot;
          const status = snapshot.conversation.status;
          if (status === "failed") {
            throw new Error(`cesium turn failed: ${snapshot.conversation.lastError ?? "?"}`);
          }
          const events: any[] = snapshot.events;
          // Guard against a stale idle read: our new user message must be
          // present (seq above the previous turn's baseline) before an idle
          // status counts as turn completion.
          let lastUserSeq = 0;
          for (const event of events) {
            if (event.kind === "user_message" && !event.hidden) {
              lastUserSeq = Math.max(lastUserSeq, event.seq);
            }
          }
          if (status !== "idle" || lastUserSeq <= baselineSeq) {
            continue;
          }
          baselineSeq = Math.max(...events.map((event: any) => event.seq as number), baselineSeq);
          const parts: string[] = [];
          for (const event of events) {
            if (event.kind === "assistant_message_chunk" && event.seq > lastUserSeq) {
              parts.push(event.text);
            }
          }
          return parts.join("").trim();
        }
      };
      return {
        send,
        async dispose() {
          // Keep the conversation for post-run inspection.
        },
      };
    },
  };
}

export function resolveDrivers(spec: string, cesiumConfig: CesiumDriverConfig): HarnessDriver[] {
  const known = new Map<string, HarnessDriver>([
    [codexDriver.id, codexDriver],
    [openCodeDriver.id, openCodeDriver],
    [claudeDriver.id, claudeDriver],
    ["cesium", cesiumDriver(cesiumConfig)],
  ]);
  return spec
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((id) => {
      const driver = known.get(id);
      if (!driver) {
        throw new Error(`Unknown driver "${id}". Known: ${[...known.keys()].join(", ")}`);
      }
      return driver;
    });
}
