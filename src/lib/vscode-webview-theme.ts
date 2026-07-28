import type { ExtensionWebviewThemeSnapshot } from "@/lib/server-api";
import type { ThemeConfig } from "@/lib/theme-config";
import { getActiveExtensionTheme } from "@/lib/extensions/extension-theme-store";
import {
  resolveColorSchemeDark,
  resolveMergedTokens,
} from "@/lib/theme-resolve";

function token(tokens: Record<string, string>, name: string, fallback: string): string {
  return tokens[name] ?? fallback;
}

export function buildVscodeWebviewTheme(
  themeConfig: ThemeConfig
): ExtensionWebviewThemeSnapshot {
  const dark = resolveColorSchemeDark(themeConfig.appearance);
  const tokens = resolveMergedTokens(themeConfig, dark) as Record<string, string>;
  // When an extension-contributed color theme is active, forward its complete
  // workbench color table so webviews render exactly as they would in VS Code.
  const extensionTheme = getActiveExtensionTheme();
  if (extensionTheme) {
    const extensionDark = extensionTheme.type === "dark" || extensionTheme.type === "hcDark";
    if (extensionDark === dark) {
      return {
        colorScheme: extensionDark ? "dark" : "light",
        variables: {
          ...buildBaseVariables(tokens, dark),
          ...extensionTheme.webviewVariables,
        },
      };
    }
  }
  return {
    colorScheme: dark ? "dark" : "light",
    variables: buildBaseVariables(tokens, dark),
  };
}

function buildBaseVariables(tokens: Record<string, string>, dark: boolean): Record<string, string> {
  const bgMain = token(tokens, "--bg-main", dark ? "#0f0f10" : "#ffffff");
  const bgPanel = token(tokens, "--bg-panel", bgMain);
  const textPrimary = token(tokens, "--text-primary", dark ? "#f4f4f5" : "#18181b");
  const textSecondary = token(tokens, "--text-secondary", dark ? "#a1a1aa" : "#52525b");
  const border = token(tokens, "--border-subtle", dark ? "#27272a" : "#d4d4d8");
  const accent = token(tokens, "--accent", dark ? "#8b5cf6" : "#4f46e5");
  const accentDark = token(tokens, "--accent-dark", accent);
  const accentBg = token(tokens, "--accent-bg", dark ? "rgba(139, 92, 246, 0.16)" : "rgba(79, 70, 229, 0.1)");
  const danger = token(tokens, "--danger", dark ? "#f87171" : "#dc2626");
  const warning = token(tokens, "--warning", dark ? "#fbbf24" : "#d97706");

  return {
    "--vscode-editor-background": bgMain,
    "--vscode-editor-foreground": textPrimary,
    "--vscode-foreground": textPrimary,
    "--vscode-descriptionForeground": textSecondary,
    "--vscode-sideBar-background": bgPanel,
    "--vscode-sideBar-foreground": textPrimary,
    "--vscode-input-background": bgPanel,
    "--vscode-input-foreground": textPrimary,
    "--vscode-input-border": border,
    "--vscode-input-placeholderForeground": textSecondary,
    "--vscode-dropdown-background": bgPanel,
    "--vscode-dropdown-foreground": textPrimary,
    "--vscode-dropdown-border": border,
    "--vscode-button-background": accent,
    "--vscode-button-foreground": dark ? "#ffffff" : bgMain,
    "--vscode-button-hoverBackground": accentDark,
    "--vscode-button-secondaryBackground": bgPanel,
    "--vscode-button-secondaryForeground": textPrimary,
    "--vscode-badge-background": accent,
    "--vscode-badge-foreground": dark ? "#ffffff" : bgMain,
    "--vscode-focusBorder": accent,
    "--vscode-panel-border": border,
    "--vscode-widget-border": border,
    "--vscode-list-hoverBackground": accentBg,
    "--vscode-list-activeSelectionBackground": accentBg,
    "--vscode-list-activeSelectionForeground": textPrimary,
    "--vscode-textLink-foreground": accent,
    "--vscode-textLink-activeForeground": accentDark,
    "--vscode-scrollbarSlider-background": border,
    "--vscode-progressBar-background": accent,
    "--vscode-errorForeground": danger,
    "--vscode-editorError-foreground": danger,
    "--vscode-editorWarning-foreground": warning,
  };
}
