/**
 * Loads color themes contributed by installed VS Code extensions and maps them
 * onto the three styling layers Cesium exposes:
 *
 *  1. webview CSS variables (`--vscode-*`) — the full workbench color table is
 *     forwarded so extension webviews render exactly like they would in VS Code,
 *  2. Cesium UI tokens (`--bg-main`, `--text-primary`, ...) so the workbench
 *     itself re-skins, and
 *  3. a Monaco theme definition (base + token rules + editor colors).
 *
 * Theme files are JSONC and may chain through `include`; both are handled.
 * TextMate `.tmTheme` XML payloads are not supported (JSON themes only).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionInstallRecord } from "./types.js";

export type ExtensionThemeDescriptor = {
  extensionId: string;
  id?: string;
  label: string;
  uiTheme: string;
  path: string;
};

export type ExtensionTokenRule = {
  token: string;
  foreground?: string;
  background?: string;
  fontStyle?: string;
};

export type LoadedExtensionTheme = {
  extensionId: string;
  label: string;
  type: "dark" | "light" | "hcDark" | "hcLight";
  colors: Record<string, string>;
  tokenRules: ExtensionTokenRule[];
  webviewVariables: Record<string, string>;
  cesiumTokens: Record<string, string>;
  monacoBase: "vs" | "vs-dark" | "hc-black" | "hc-light";
};

const MAX_INCLUDE_DEPTH = 5;
const MAX_THEME_FILE_BYTES = 4 * 1024 * 1024;

/** Strips // and both block comments plus trailing commas from JSONC. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];
    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        out += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        if (typeof next === "string") {
          out += next;
          index += 1;
        }
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    out += char;
  }
  // Remove trailing commas before } or ].
  const withoutTrailingCommas = out.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(withoutTrailingCommas);
}

export function listExtensionThemes(records: ExtensionInstallRecord[]): ExtensionThemeDescriptor[] {
  const descriptors: ExtensionThemeDescriptor[] = [];
  for (const record of records) {
    if (!record.enabled) continue;
    const contributes = record.manifest.raw.contributes;
    const themes =
      contributes && typeof contributes === "object" && "themes" in contributes
        ? (contributes as { themes?: unknown }).themes
        : undefined;
    if (!Array.isArray(themes)) continue;
    for (const theme of themes) {
      if (!theme || typeof theme !== "object") continue;
      const raw = theme as { id?: unknown; label?: unknown; uiTheme?: unknown; path?: unknown };
      if (typeof raw.path !== "string" || !raw.path.trim()) continue;
      if (!raw.path.toLowerCase().endsWith(".json")) continue;
      descriptors.push({
        extensionId: record.extensionId,
        id: typeof raw.id === "string" ? raw.id : undefined,
        label:
          typeof raw.label === "string" && raw.label.trim()
            ? raw.label
            : typeof raw.id === "string"
              ? raw.id
              : path.basename(raw.path, ".json"),
        uiTheme: typeof raw.uiTheme === "string" ? raw.uiTheme : "vs-dark",
        path: raw.path,
      });
    }
  }
  return descriptors;
}

async function readThemeFile(
  extensionRoot: string,
  themePath: string,
  depth: number
): Promise<{ colors: Record<string, string>; tokenColors: unknown[]; type?: string }> {
  if (depth > MAX_INCLUDE_DEPTH) {
    return { colors: {}, tokenColors: [] };
  }
  const absolute = path.resolve(extensionRoot, themePath.replace(/^\.\//, ""));
  if (
    absolute !== extensionRoot &&
    !absolute.startsWith(`${path.resolve(extensionRoot)}${path.sep}`)
  ) {
    throw new Error("Theme path escapes extension root.");
  }
  const stat = await fs.stat(absolute);
  if (stat.size > MAX_THEME_FILE_BYTES) {
    throw new Error("Theme file is too large.");
  }
  const raw = parseJsonc(await fs.readFile(absolute, "utf8")) as {
    include?: unknown;
    colors?: unknown;
    tokenColors?: unknown;
    type?: unknown;
  };
  let colors: Record<string, string> = {};
  let tokenColors: unknown[] = [];
  let type: string | undefined;
  if (typeof raw.include === "string" && raw.include.trim()) {
    const includeDir = path.dirname(path.relative(extensionRoot, absolute));
    const included = await readThemeFile(
      extensionRoot,
      path.join(includeDir, raw.include),
      depth + 1
    ).catch(() => ({ colors: {}, tokenColors: [] as unknown[], type: undefined as string | undefined }));
    colors = { ...included.colors };
    tokenColors = [...included.tokenColors];
    type = included.type;
  }
  if (raw.colors && typeof raw.colors === "object") {
    for (const [key, value] of Object.entries(raw.colors as Record<string, unknown>)) {
      if (typeof value === "string") colors[key] = value;
    }
  }
  if (Array.isArray(raw.tokenColors)) {
    tokenColors.push(...raw.tokenColors);
  }
  if (typeof raw.type === "string") {
    type = raw.type;
  }
  return { colors, tokenColors, type };
}

function themeTypeOf(uiTheme: string, declaredType?: string): LoadedExtensionTheme["type"] {
  if (declaredType === "light") return "light";
  if (declaredType === "dark") return "dark";
  if (uiTheme === "vs") return "light";
  if (uiTheme === "hc-black") return "hcDark";
  if (uiTheme === "hc-light") return "hcLight";
  return "dark";
}

function monacoBaseOf(type: LoadedExtensionTheme["type"]): LoadedExtensionTheme["monacoBase"] {
  if (type === "light") return "vs";
  if (type === "hcDark") return "hc-black";
  if (type === "hcLight") return "hc-light";
  return "vs-dark";
}

function serializeTokenRules(tokenColors: unknown[]): ExtensionTokenRule[] {
  const rules: ExtensionTokenRule[] = [];
  for (const entry of tokenColors.slice(0, 800)) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as { scope?: unknown; settings?: unknown };
    const settings =
      raw.settings && typeof raw.settings === "object"
        ? (raw.settings as { foreground?: unknown; background?: unknown; fontStyle?: unknown })
        : undefined;
    if (!settings) continue;
    const foreground =
      typeof settings.foreground === "string" ? settings.foreground.replace(/^#/, "") : undefined;
    const background =
      typeof settings.background === "string" ? settings.background.replace(/^#/, "") : undefined;
    const fontStyle = typeof settings.fontStyle === "string" ? settings.fontStyle : undefined;
    if (!foreground && !background && !fontStyle) continue;
    const scopes =
      typeof raw.scope === "string"
        ? raw.scope.split(",").map((scope) => scope.trim())
        : Array.isArray(raw.scope)
          ? raw.scope.filter((scope): scope is string => typeof scope === "string")
          : [""];
    for (const scope of scopes) {
      rules.push({ token: scope, foreground, background, fontStyle });
    }
  }
  return rules;
}

function toWebviewVariables(colors: Record<string, string>): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(colors)) {
    variables[`--vscode-${key.replace(/\./g, "-")}`] = value;
  }
  return variables;
}

function pick(colors: Record<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = colors[key];
    if (value) return value;
  }
  return undefined;
}

function toCesiumTokens(
  colors: Record<string, string>,
  type: LoadedExtensionTheme["type"]
): Record<string, string> {
  const dark = type === "dark" || type === "hcDark";
  const fallback = (darkValue: string, lightValue: string) => (dark ? darkValue : lightValue);
  const bgMain = pick(colors, "editor.background") ?? fallback("#0f0f10", "#ffffff");
  const bgPanel = pick(colors, "sideBar.background", "panel.background") ?? bgMain;
  const textPrimary = pick(colors, "editor.foreground", "foreground") ?? fallback("#f4f4f5", "#18181b");
  const textSecondary =
    pick(colors, "descriptionForeground", "sideBar.foreground", "tab.inactiveForeground") ??
    fallback("#a1a1aa", "#52525b");
  const border =
    pick(colors, "panel.border", "sideBar.border", "editorGroup.border", "contrastBorder") ??
    fallback("#27272a", "#d4d4d8");
  const accent =
    pick(colors, "focusBorder", "button.background", "activityBarBadge.background", "progressBar.background") ??
    fallback("#8b5cf6", "#4f46e5");
  const accentBg =
    pick(colors, "list.activeSelectionBackground", "editor.selectionBackground") ??
    fallback("rgba(139, 92, 246, 0.16)", "rgba(79, 70, 229, 0.1)");
  const danger =
    pick(colors, "errorForeground", "editorError.foreground") ?? fallback("#f87171", "#dc2626");
  const warning =
    pick(colors, "editorWarning.foreground", "list.warningForeground") ??
    fallback("#fbbf24", "#d97706");
  return {
    "--bg-main": bgMain,
    "--bg-panel": bgPanel,
    "--bg-header": pick(colors, "titleBar.activeBackground", "activityBar.background") ?? bgPanel,
    "--text-primary": textPrimary,
    "--text-secondary": textSecondary,
    "--border-subtle": border,
    "--border-card": border,
    "--accent": accent,
    "--accent-dark": accent,
    "--accent-bg": accentBg,
    "--danger": danger,
    "--warning": warning,
  };
}

export async function loadExtensionTheme(input: {
  record: ExtensionInstallRecord;
  label: string;
}): Promise<LoadedExtensionTheme | null> {
  const descriptors = listExtensionThemes([input.record]).filter(
    (descriptor) =>
      descriptor.label === input.label || descriptor.id === input.label
  );
  const descriptor = descriptors[0];
  if (!descriptor) return null;
  const extensionRoot = path.resolve(input.record.installPath, "extension");
  const { colors, tokenColors, type } = await readThemeFile(extensionRoot, descriptor.path, 0);
  const themeType = themeTypeOf(descriptor.uiTheme, type);
  return {
    extensionId: input.record.extensionId,
    label: descriptor.label,
    type: themeType,
    colors,
    tokenRules: serializeTokenRules(tokenColors),
    webviewVariables: toWebviewVariables(colors),
    cesiumTokens: toCesiumTokens(colors, themeType),
    monacoBase: monacoBaseOf(themeType),
  };
}
