export type ColorToken =
  | "background"
  | "foreground"
  | "bgMain"
  | "bgPanel"
  | "bgCard"
  | "bgCardHover"
  | "borderCard"
  | "borderSubtle"
  | "textPrimary"
  | "textSecondary"
  | "textDisabled"
  | "accent"
  | "accentDark"
  | "accentBg"
  | "planAccent"
  | "debugAccent"
  | "askAccent";

export type RadiusToken = "card" | "tab" | "pill" | "checkbox";
export type FontSizeToken = "body" | "small" | "meta";

export type CesiumDesignTokens = {
  color: Record<ColorToken, string>;
  radius: Record<RadiusToken, string>;
  fontSize: Record<FontSizeToken, string>;
  layout: {
    sidebarWidth: string;
    chatWidth: string;
    tabHeight: string;
  };
};

export const lightTokens: CesiumDesignTokens = {
  color: {
    background: "#fafafa",
    foreground: "#0a0a0a",
    bgMain: "#fafafa",
    bgPanel: "#f0f0f0",
    bgCard: "#e6e6e6",
    bgCardHover: "#dcdcdc",
    borderCard: "#c4c4c4",
    borderSubtle: "#e2e2e2",
    textPrimary: "#1a1a1a",
    textSecondary: "#5c5c5c",
    textDisabled: "#9a9a9a",
    accent: "#1a1a1a",
    accentDark: "#333333",
    accentBg: "rgba(0, 0, 0, 0.08)",
    planAccent: "#9a7f1a",
    debugAccent: "#b84d55",
    askAccent: "#3d6b4d",
  },
  radius: {
    card: "10px",
    tab: "5px",
    pill: "50px",
    checkbox: "2px",
  },
  fontSize: {
    body: "14px",
    small: "10.5px",
    meta: "11.9px",
  },
  layout: {
    sidebarWidth: "290px",
    chatWidth: "550px",
    tabHeight: "40px",
  },
};

export const darkTokens: CesiumDesignTokens = {
  color: {
    background: "#191919",
    foreground: "#ffffff",
    bgMain: "#191919",
    bgPanel: "#1e1e1e",
    bgCard: "#393939",
    bgCardHover: "#404040",
    borderCard: "#505050",
    borderSubtle: "#2a2a2a",
    textPrimary: "#ffffff",
    textSecondary: "#6f6f6f",
    textDisabled: "#5b5b5b",
    accent: "#ffffff",
    accentDark: "#e8e8e8",
    accentBg: "rgba(255, 255, 255, 0.1)",
    planAccent: "#c2a738",
    debugAccent: "#e59a9a",
    askAccent: "#5e8d6b",
  },
  radius: lightTokens.radius,
  fontSize: lightTokens.fontSize,
  layout: lightTokens.layout,
};

export type ColorScheme = "light" | "dark";

export function getTokens(scheme: ColorScheme): CesiumDesignTokens {
  return scheme === "dark" ? darkTokens : lightTokens;
}
