export type SurfaceCapability =
  | "terminal"
  | "code-editor"
  | "browser-preview"
  | "resizable-layout"
  | "native-notifications"
  | "background-execution"
  | "file-system"
  | "agent-runtime";

export const webSurfaceCapabilities = {
  terminal: true,
  "code-editor": true,
  "browser-preview": true,
  "resizable-layout": true,
  "native-notifications": false,
  "background-execution": false,
  "file-system": false,
  "agent-runtime": false,
} satisfies Record<SurfaceCapability, boolean>;
