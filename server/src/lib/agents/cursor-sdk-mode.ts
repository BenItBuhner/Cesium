/** Native Cursor SDK conversation modes (when supported at runtime). */
export type CursorSdkNativeMode = "agent" | "plan";

export function cursorSdkNativeMode(mode: string): CursorSdkNativeMode | undefined {
  if (mode === "agent" || mode === "plan") {
    return mode;
  }
  return undefined;
}

export function needsSyntheticModePrefix(mode: string): boolean {
  return mode === "ask" || mode === "debug";
}

export function modePromptPrefix(mode: string): string {
  switch (mode) {
    case "ask":
      return "Operate in ask mode. Answer and inspect as needed, but do not edit files.";
    case "debug":
      return "Operate in debug mode. Gather runtime evidence, reason systematically, and keep fixes focused.";
    default:
      return "";
  }
}

export function buildPromptWithSyntheticMode(mode: string, text: string): string {
  const prefix = modePromptPrefix(mode);
  if (!prefix) {
    return text;
  }
  return `${prefix}\n\nUser request:\n${text}`;
}

/** Pass mode through SDK options when the runtime supports it (types may lag docs). */
export function withCursorSdkMode<T extends Record<string, unknown>>(
  options: T,
  mode: string | undefined
): T {
  const native = mode ? cursorSdkNativeMode(mode) : undefined;
  if (!native) {
    return options;
  }
  return { ...options, mode: native };
}
