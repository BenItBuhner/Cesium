import { DEFAULT_BUILTIN_THEME_ID } from "./theme-presets";
import {
  sanitizeThemeTokensPartial,
  type ThemeTokensPartial,
} from "./theme-tokens";
import {
  parseThemePreference,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "./theme";
import { clientKeyValueStore } from "./platform";

export const THEME_CONFIG_STORAGE_KEY = "opencursor-theme-config" as const;

/** Legacy single-string appearance (still read once for migration). */
export { THEME_STORAGE_KEY };

export type CustomThemeEntry = {
  id: string;
  label: string;
  light: ThemeTokensPartial;
  dark: ThemeTokensPartial;
};

export type UiDesignMode = "classic" | "new";

/** How file-edit tool results render in the agent transcript. */
export type EditDiffRenderingMode = "full" | "counts";

/** Min/max for expanded worked-session tool-call list height in chat (px). */
export const TOOL_CALL_DROPDOWN_MAX_HEIGHT_MIN_PX = 120;
export const TOOL_CALL_DROPDOWN_MAX_HEIGHT_MAX_PX = 800;
export const TOOL_CALL_DROPDOWN_MAX_HEIGHT_DEFAULT_PX = 240;

export function normalizeToolCallDropdownMaxHeightPx(raw: unknown): number {
  const n =
    typeof raw === "number" && Number.isFinite(raw)
      ? Math.round(raw)
      : TOOL_CALL_DROPDOWN_MAX_HEIGHT_DEFAULT_PX;
  return Math.min(
    TOOL_CALL_DROPDOWN_MAX_HEIGHT_MAX_PX,
    Math.max(TOOL_CALL_DROPDOWN_MAX_HEIGHT_MIN_PX, n)
  );
}

export type ThemeConfig = {
  schemaVersion: 1;
  /** system | light | dark */
  appearance: ThemePreference;
  /** Theme id (builtin or custom) when resolved appearance is light. */
  lightThemeId: string;
  /** Theme id (builtin or custom) when resolved appearance is dark. */
  darkThemeId: string;
  customThemes: CustomThemeEntry[];
  /**
   * Tablet/desktop: when the primary sidebar is collapsed, show the floating
   * top-left control to reopen it. Hidden by default on wide layouts.
   */
  showFloatingSidebarReveal: boolean;
  /** Visual system variant. `new` enables the next-generation UI design hooks. */
  uiDesignMode: UiDesignMode;
  /**
   * `full` — unified diff lines in worked-session cards.
   * `counts` — single-line added/removed counts only (Cursor-style).
   */
  editDiffRenderingMode: EditDiffRenderingMode;
  /** Collapse very large pasted text into compact composer reference pills. */
  longPasteReferencesEnabled: boolean;
  /** Max height of expanded worked-session tool-call dropdown bodies in chat (px). */
  toolCallDropdownMaxHeightPx: number;
};

export function createDefaultThemeConfig(): ThemeConfig {
  return {
    schemaVersion: 1,
    appearance: "system",
    lightThemeId: DEFAULT_BUILTIN_THEME_ID,
    darkThemeId: DEFAULT_BUILTIN_THEME_ID,
    customThemes: [],
    showFloatingSidebarReveal: false,
    uiDesignMode: "classic",
    editDiffRenderingMode: "full",
    longPasteReferencesEnabled: true,
    toolCallDropdownMaxHeightPx: TOOL_CALL_DROPDOWN_MAX_HEIGHT_DEFAULT_PX,
  };
}

function isThemePreference(v: unknown): v is ThemePreference {
  return v === "light" || v === "dark" || v === "system";
}

function isUiDesignMode(v: unknown): v is UiDesignMode {
  return v === "classic" || v === "new";
}

function isEditDiffRenderingMode(v: unknown): v is EditDiffRenderingMode {
  return v === "full" || v === "counts";
}

function sanitizeCustomThemes(raw: unknown): CustomThemeEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: CustomThemeEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : "";
    const label = typeof r.label === "string" && r.label.trim() ? r.label.trim() : id;
    if (!id) continue;
    if (id === DEFAULT_BUILTIN_THEME_ID) continue;
    out.push({
      id,
      label,
      light: sanitizeThemeTokensPartial(r.light),
      dark: sanitizeThemeTokensPartial(r.dark),
    });
  }
  return out;
}

export function normalizeThemeConfig(raw: unknown): ThemeConfig {
  const base = createDefaultThemeConfig();
  if (!raw || typeof raw !== "object") {
    return base;
  }
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 1) {
    return base;
  }
  const appearance = isThemePreference(r.appearance) ? r.appearance : base.appearance;
  const lightThemeId =
    typeof r.lightThemeId === "string" && r.lightThemeId.trim()
      ? r.lightThemeId.trim()
      : base.lightThemeId;
  const darkThemeId =
    typeof r.darkThemeId === "string" && r.darkThemeId.trim()
      ? r.darkThemeId.trim()
      : base.darkThemeId;
  const showFloatingSidebarReveal = r.showFloatingSidebarReveal === true;
  const uiDesignMode = isUiDesignMode(r.uiDesignMode)
    ? r.uiDesignMode
    : base.uiDesignMode;
  const editDiffRenderingMode = isEditDiffRenderingMode(r.editDiffRenderingMode)
    ? r.editDiffRenderingMode
    : base.editDiffRenderingMode;
  return {
    schemaVersion: 1,
    appearance,
    lightThemeId,
    darkThemeId,
    customThemes: sanitizeCustomThemes(r.customThemes),
    showFloatingSidebarReveal,
    uiDesignMode,
    editDiffRenderingMode,
    longPasteReferencesEnabled:
      typeof r.longPasteReferencesEnabled === "boolean"
        ? r.longPasteReferencesEnabled
        : base.longPasteReferencesEnabled,
    toolCallDropdownMaxHeightPx: normalizeToolCallDropdownMaxHeightPx(
      r.toolCallDropdownMaxHeightPx
    ),
  };
}

export function serializeThemeConfig(config: ThemeConfig): string {
  return JSON.stringify(config);
}

/** Load from `opencursor-theme-config` JSON, else migrate legacy `opencursor-theme` string. */
export function loadThemeConfigFromStorage(): ThemeConfig {
  const store = clientKeyValueStore();
  try {
    const raw = store.getItem(THEME_CONFIG_STORAGE_KEY);
    if (raw) {
      return normalizeThemeConfig(JSON.parse(raw) as unknown);
    }
  } catch {
    /* ignore */
  }
  const legacy = store.getItem(THEME_STORAGE_KEY);
  if (legacy) {
    return {
      ...createDefaultThemeConfig(),
      appearance: parseThemePreference(legacy),
    };
  }
  return createDefaultThemeConfig();
}

export function persistThemeConfigToStorage(config: ThemeConfig): void {
  try {
    clientKeyValueStore().setItem(
      THEME_CONFIG_STORAGE_KEY,
      serializeThemeConfig(config)
    );
  } catch {
    /* quota / private mode */
  }
}
