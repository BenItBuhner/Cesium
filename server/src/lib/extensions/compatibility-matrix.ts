import type { ExtensionCompatibilityLevel } from "./types.js";

export type ExtensionCompatibilityMatrixEntry = {
  namespace: string;
  name: string;
  expectedCompatibility: ExtensionCompatibilityLevel;
  primarySurface: "commands" | "language" | "theme" | "webview" | "debugger" | "scm";
  requiredApis: string[];
  notes: string;
};

export const EXTENSION_COMPATIBILITY_MATRIX: ExtensionCompatibilityMatrixEntry[] = [
  {
    namespace: "esbenp",
    name: "prettier-vscode",
    expectedCompatibility: "partial",
    primarySurface: "language",
    requiredApis: ["workspace", "languages", "commands", "configuration"],
    notes: "Formatter registration and configuration are the key compatibility probes.",
  },
  {
    namespace: "dbaeumer",
    name: "vscode-eslint",
    expectedCompatibility: "partial",
    primarySurface: "language",
    requiredApis: ["workspace", "languages", "diagnostics", "commands"],
    notes: "Language server process management remains gated behind explicit permissions.",
  },
  {
    namespace: "PKief",
    name: "material-icon-theme",
    expectedCompatibility: "high",
    primarySurface: "theme",
    requiredApis: ["contributes.iconThemes"],
    notes: "Static contribution with no Node activation required.",
  },
  {
    namespace: "redhat",
    name: "vscode-yaml",
    expectedCompatibility: "partial",
    primarySurface: "language",
    requiredApis: ["languages", "workspace", "configuration"],
    notes: "Schema associations and diagnostics are the primary probes.",
  },
  {
    namespace: "eamodio",
    name: "gitlens",
    expectedCompatibility: "partial",
    primarySurface: "scm",
    requiredApis: ["commands", "workspace.fs", "scm", "webview"],
    notes: "SCM APIs are not complete, so most UI should remain disabled or degraded.",
  },
  {
    namespace: "ms-python",
    name: "debugpy",
    expectedCompatibility: "unsupported",
    primarySurface: "debugger",
    requiredApis: ["debug", "terminal", "process.spawn"],
    notes: "Debugger contribution support is intentionally outside the first Beta host.",
  },
];
