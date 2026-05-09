function readEnvValue(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export function getClaudeCodeSdkProxyBaseUrl(): string {
  return readEnvValue("OPENCURSOR_CLAUDE_CODE_SDK_BASE_URL") || readEnvValue("ANTHROPIC_BASE_URL");
}

export function getClaudeCodeSdkProxyApiKey(): string {
  return readEnvValue("OPENCURSOR_CLAUDE_CODE_SDK_API_KEY") || readEnvValue("ANTHROPIC_API_KEY");
}

export function getClaudeCodeSdkProxyModel(): string {
  return readEnvValue("OPENCURSOR_CLAUDE_CODE_SDK_MODEL") || "glm-5.1-precision";
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

export function hasClaudeCodeSdkAuthConfig(): boolean {
  return Boolean(
    hasClaudeCodeSdkProxyConfig() ||
      readEnvValue("ANTHROPIC_API_KEY") ||
      readEnvValue("ANTHROPIC_AUTH_TOKEN") ||
      readEnvValue("CLAUDE_CODE_USE_BEDROCK") === "1" ||
      readEnvValue("CLAUDE_CODE_USE_VERTEX") === "1" ||
      readEnvValue("CLAUDE_CODE_USE_FOUNDRY") === "1"
  );
}

export function describeClaudeCodeSdkAuthStatus(): string {
  if (hasClaudeCodeSdkProxyConfig()) {
    return `proxy configured (${getClaudeCodeSdkProxyBaseUrl()})`;
  }
  if (readEnvValue("ANTHROPIC_API_KEY")) {
    return "ANTHROPIC_API_KEY configured";
  }
  if (readEnvValue("ANTHROPIC_AUTH_TOKEN")) {
    return "ANTHROPIC_AUTH_TOKEN configured";
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
  return "Set OPENCURSOR_CLAUDE_CODE_SDK_API_KEY + OPENCURSOR_CLAUDE_CODE_SDK_BASE_URL, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or a supported Claude provider env var";
}
