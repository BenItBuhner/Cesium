export type FileNode = {
  name: string;
  type: "file" | "folder";
  children?: FileNode[];
  language?: string;
  dimmed?: boolean;
  hasChildren?: boolean;
  childrenLoaded?: boolean;
};

export type TerminalInfo = {
  id: string;
  shell: string;
  cwd?: string;
  command?: string;
  running?: boolean;
};

export type WorkspaceRecord = {
  id: string;
  name: string;
  root: string;
  lastOpenedAt?: number;
};

export type WorkspaceWindowRecord = {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastFocusedAt?: number;
};

export type WorkspaceInfo = {
  id: string;
  name: string;
  root: string;
  home?: string;
};

export type GitWorkspaceStatus = {
  branch: string | null;
  clean: boolean;
  ahead?: number;
  behind?: number;
  changedFiles?: string[];
};

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
