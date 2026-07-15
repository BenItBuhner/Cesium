/**
 * Workbench shell/layout types. Workspace record/file-tree/git types now live
 * in ./types (moved from src/lib/types.ts) — the richer client shapes are the
 * single source of truth.
 */
export type MobilePanel = "sidebar" | "editor" | "chat";
export type WorkbenchShellView = "agent" | "editor" | "settings";
export type WorkbenchShellNonSettingsView = "agent" | "editor";

export type LayoutSessionState = {
  sidebarOpen: boolean;
  chatOpen: boolean;
  mobilePanel: MobilePanel;
  desktopLayout: Record<string, number> | null;
  shellView: WorkbenchShellView;
  priorShellView: WorkbenchShellNonSettingsView;
};
