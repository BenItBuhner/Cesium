export type PlatformKind = "web" | "desktop" | "ios" | "android" | "ipad";

export type SurfaceCapability =
  | "terminal"
  | "code-editor"
  | "browser-preview"
  | "resizable-layout"
  | "native-notifications"
  | "background-execution"
  | "file-system"
  | "agent-runtime";

export type PlatformCapabilities = {
  platform: PlatformKind;
  capabilities: Partial<Record<SurfaceCapability, boolean>>;
};

export type SurfaceState<TPayload = unknown> = {
  id: string;
  payload: TPayload;
};

export type TerminalSurfacePayload = {
  terminalId: string;
  title?: string;
};

export type CodeEditorSurfacePayload = {
  path?: string;
  language: string;
  content: string;
  readOnly?: boolean;
};

export type BrowserSurfacePayload = {
  targetUrl: string;
  designMode?: boolean;
  devtoolsOpen?: boolean;
};

export type ComposerInputPayload = {
  value: string;
  placeholder?: string;
  multiline?: boolean;
};
