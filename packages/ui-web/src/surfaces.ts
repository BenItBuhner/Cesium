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

export type WebSurfaceProps =
  | { kind: "terminal"; payload: TerminalSurfacePayload }
  | { kind: "code-editor"; payload: CodeEditorSurfacePayload }
  | { kind: "browser-preview"; payload: BrowserSurfacePayload }
  | { kind: "composer-input"; payload: ComposerInputPayload };

export const webSurfaceImplementations = {
  terminal: "src/components/editor/Terminal.tsx",
  "code-editor": "src/components/editor/CodeEditor.tsx",
  "browser-preview": "src/components/editor/BrowserTab.tsx",
  "composer-input": "src/components/chat/ChatComposer.tsx",
  "resizable-shell": "src/components/layout/AgentLayout.tsx",
} as const;
