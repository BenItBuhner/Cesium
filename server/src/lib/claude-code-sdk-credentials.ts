import path from "node:path";
import { getStoredClaudeCodeSdkSettingsSync } from "./claude-code-sdk-settings.js";
import {
  detectHarnessCli,
  harnessHomeDirCandidates,
  isExecutableFile,
} from "./agents/harness-runtime.js";
import { existsSync } from "node:fs";

function readEnvValue(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function resolveStoredOrEnv(
  storedValue: string | undefined,
  envNames: string[]
): string {
  if (storedValue?.trim()) {
    return storedValue.trim();
  }
  for (const name of envNames) {
    const value = readEnvValue(name);
    if (value) {
      return value;
    }
  }
  return "";
}

/**
 * Claude Code appends `/v1/messages` to `ANTHROPIC_BASE_URL` itself, so a
 * base URL copied from an OpenAI-compatible proxy (`https://host/v1`) would
 * hit `/v1/v1/messages` and 404. Strip trailing slashes and a trailing `/v1`
 * segment so both spellings work.
 */
export function normalizeClaudeCodeSdkBaseUrl(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\/+$/, "").replace(/\/v1$/i, "").replace(/\/+$/, "");
}

export function getClaudeCodeSdkProxyBaseUrl(): string {
  const stored = getStoredClaudeCodeSdkSettingsSync();
  return normalizeClaudeCodeSdkBaseUrl(
    resolveStoredOrEnv(stored?.baseUrl, [
      "OPENCURSOR_CLAUDE_CODE_SDK_BASE_URL",
      "ANTHROPIC_BASE_URL",
    ])
  );
}

export function getClaudeCodeSdkProxyApiKey(): string {
  const stored = getStoredClaudeCodeSdkSettingsSync();
  return resolveStoredOrEnv(stored?.apiKey, [
    "OPENCURSOR_CLAUDE_CODE_SDK_API_KEY",
    "ANTHROPIC_API_KEY",
  ]);
}

export const CLAUDE_CODE_SDK_DEFAULT_PROXY_MODEL = "glm-5.1-precision";

export function getClaudeCodeSdkProxyModel(): string {
  const stored = getStoredClaudeCodeSdkSettingsSync();
  return (
    resolveStoredOrEnv(stored?.model, ["OPENCURSOR_CLAUDE_CODE_SDK_MODEL"]) ||
    CLAUDE_CODE_SDK_DEFAULT_PROXY_MODEL
  );
}

export function getClaudeCodeSdkPathToExecutable(): string | undefined {
  const stored = getStoredClaudeCodeSdkSettingsSync();
  const resolved = resolveStoredOrEnv(stored?.pathToExecutable, [
    "OPENCURSOR_CLAUDE_CODE_SDK_PATH",
    "OPENCURSOR_CLAUDE_BIN",
  ]);
  return resolved || undefined;
}

export function getClaudeCodeSdkProxyModelName(): string {
  const model = getClaudeCodeSdkProxyModel();
  if (model === "glm-5.1-precision") {
    return "GLM 5.1 Precision";
  }
  return model
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function hasClaudeCodeSdkProxyConfig(): boolean {
  return Boolean(getClaudeCodeSdkProxyBaseUrl() && getClaudeCodeSdkProxyApiKey());
}

/**
 * True when the proxy base URL points somewhere other than Anthropic's own
 * API. Third-party hosts do not know Claude's model aliases (`sonnet`,
 * `haiku`, ...), which matters for subagents that default to those aliases.
 */
export function isThirdPartyClaudeCodeSdkProxy(): boolean {
  const baseUrl = getClaudeCodeSdkProxyBaseUrl();
  if (!baseUrl) {
    return false;
  }
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return !(host === "api.anthropic.com" || host.endsWith(".anthropic.com"));
  } catch {
    return true;
  }
}

const CLAUDE_MODEL_ALIAS_ENV_VARS = [
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
] as const;

/**
 * Env overrides that pin every Claude model alias (used by built-in subagents
 * such as `Explore`, which defaults to `haiku`, and by `general-purpose`, which
 * inherits the CLI default `opus`) to the proxied model. Without this, every
 * subagent spawned through a third-party proxy fails with "model not found in
 * routing configuration". Explicit user-set aliases are left alone.
 */
export function claudeCodeSdkModelAliasEnv(model: string | undefined): Record<string, string> {
  const target = model?.trim();
  if (!target || !isThirdPartyClaudeCodeSdkProxy()) {
    return {};
  }
  const env: Record<string, string> = {};
  for (const name of CLAUDE_MODEL_ALIAS_ENV_VARS) {
    if (!readEnvValue(name)) {
      env[name] = target;
    }
  }
  return env;
}

export function hasClaudeCodeSdkAuthConfig(): boolean {
  return Boolean(
    hasClaudeCodeSdkProxyConfig() ||
      readEnvValue("ANTHROPIC_API_KEY") ||
      readEnvValue("ANTHROPIC_AUTH_TOKEN") ||
      readEnvValue("CLAUDE_CODE_OAUTH_TOKEN") ||
      readEnvValue("CLAUDE_CODE_USE_BEDROCK") === "1" ||
      readEnvValue("CLAUDE_CODE_USE_VERTEX") === "1" ||
      readEnvValue("CLAUDE_CODE_USE_FOUNDRY") === "1"
  );
}

/**
 * Detects ambient Claude Code CLI credentials on the host: a native `claude
 * login` credentials file, or an installed `claude` binary (whose login the
 * bundled Agent SDK runtime reuses). Explicit auth config always wins over
 * this - see `hasClaudeCodeSdkAuthConfig`.
 */
export function hasClaudeCodeAmbientCliAuth(): boolean {
  for (const home of harnessHomeDirCandidates()) {
    const credentialsFile = path.join(home, ".claude", ".credentials.json");
    try {
      if (existsSync(credentialsFile)) {
        return true;
      }
    } catch {
      // Unreadable home candidates are skipped.
    }
    const localLauncher = path.join(home, ".claude", "local", "claude");
    if (isExecutableFile(localLauncher)) {
      return true;
    }
  }
  return detectHarnessCli("claude") !== null;
}

/**
 * Single availability gate shared by backend listing and session creation so
 * a backend that lists as available can never fail `startSession` on auth.
 */
export function hasClaudeCodeSdkUsableAuth(): boolean {
  return hasClaudeCodeSdkAuthConfig() || hasClaudeCodeAmbientCliAuth();
}

export function describeClaudeCodeSdkAuthStatus(): string {
  const stored = getStoredClaudeCodeSdkSettingsSync();
  if (hasClaudeCodeSdkProxyConfig()) {
    const source = stored?.baseUrl || stored?.apiKey ? "stored settings" : "env";
    return `proxy configured (${getClaudeCodeSdkProxyBaseUrl()}, ${source})`;
  }
  if (readEnvValue("ANTHROPIC_API_KEY")) {
    return "ANTHROPIC_API_KEY configured";
  }
  if (readEnvValue("ANTHROPIC_AUTH_TOKEN")) {
    return "ANTHROPIC_AUTH_TOKEN configured";
  }
  if (readEnvValue("CLAUDE_CODE_OAUTH_TOKEN")) {
    return "CLAUDE_CODE_OAUTH_TOKEN configured";
  }
  if (readEnvValue("CLAUDE_CODE_USE_BEDROCK") === "1") {
    return "Bedrock provider configured";
  }
  if (readEnvValue("CLAUDE_CODE_USE_VERTEX") === "1") {
    return "Vertex provider configured";
  }
  if (readEnvValue("CLAUDE_CODE_USE_FOUNDRY") === "1") {
    return "Foundry provider configured";
  }
  if (hasClaudeCodeAmbientCliAuth()) {
    return "ambient Claude Code CLI credentials";
  }
  return "Set Claude Code SDK settings, OPENCURSOR_CLAUDE_CODE_SDK_API_KEY + OPENCURSOR_CLAUDE_CODE_SDK_BASE_URL, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, or a supported Claude provider env var";
}
