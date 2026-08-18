import type { LocalAgentOptions, SettingSource } from "@cursor/sdk";
import type { AgentConfigOption } from "./types.js";

export type CursorSdkSandboxMode = "enabled" | "disabled";

export type CursorSdkLocalOptions = LocalAgentOptions & {
  cwd: string;
  settingSources: SettingSource[];
  sandboxOptions: { enabled: boolean };
  autoReview: false;
  enableAgentRetries: true;
};

/**
 * Maps the Cesium sandbox mode onto the SDK's `local.sandboxOptions`.
 *
 * Headless Cesium sessions must not inherit `~/.cursor/sandbox.json`.
 * Explicitly disabling the sandbox is the SDK-documented headless default and
 * prevents ambient IDE policy from silently blocking coding tools.
 */
export function cursorSdkSandboxOptions(
  mode: CursorSdkSandboxMode
): { enabled: boolean } {
  return { enabled: mode === "enabled" };
}

export function buildCursorSdkLocalOptions(input: {
  cwd: string;
  settingSources: CursorSdkLocalOptions["settingSources"];
  sandboxMode: CursorSdkSandboxMode;
}): CursorSdkLocalOptions {
  return {
    cwd: input.cwd,
    settingSources: input.settingSources,
    sandboxOptions: cursorSdkSandboxOptions(input.sandboxMode),
    autoReview: false,
    enableAgentRetries: true,
  };
}

export function resolveCursorSdkSandboxMode(
  configOptions: AgentConfigOption[]
): CursorSdkSandboxMode {
  const value = configOptions.find(
    (option) => option.id === "sdk_sandbox"
  )?.currentValue;
  // "auto" was the short-lived default from PR #173. Treat it, missing values,
  // and unknown legacy values as disabled so existing installs are hardened.
  return value === "enabled" ? "enabled" : "disabled";
}
