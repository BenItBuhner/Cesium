/**
 * Shared protocol between the server-side host runtime and the extension host
 * child process. Transport is newline-delimited JSON over stdio:
 *
 * - Parent -> child request:  { id, method, params }
 * - Parent -> child notify:   { notify, params }            (no response)
 * - Child -> parent response: { id, ok, result? , error? }
 * - Child -> parent event:    { event, extensionId?, payload }  (unsolicited push)
 *
 * The event channel replaces the old poll/drain model: webview messages,
 * notifications, diagnostics, status bar updates, etc. are pushed the moment
 * they happen instead of being buffered until the next request.
 */

export type ExtensionContextShape = {
  extensionId: string;
  extensionPath: string;
  storagePath: string;
  globalStoragePath: string;
  logPath: string;
  resourceBaseUrl: string;
};

export type EditorSelectionShape = {
  startLineNumber?: number;
  startColumn?: number;
  endLineNumber?: number;
  endColumn?: number;
};

export type EditorCommandContext = {
  uri?: string;
  path?: string;
  language?: string;
  content?: string;
  selectedText?: string;
  selection?: EditorSelectionShape;
  version?: number;
  dirty?: boolean;
};

export type EditorContextSyncReason =
  | "open"
  | "focus"
  | "selection"
  | "edit"
  | "save"
  | "close";

export type SerializedTreeItem = {
  handle: string;
  label: string;
  description?: string;
  tooltip?: string;
  collapsibleState: 0 | 1 | 2;
  iconId?: string;
  resourcePath?: string;
  contextValue?: string;
  hasCommand: boolean;
  checkboxState?: 0 | 1;
};

export type SerializedStatusBarItem = {
  itemId: string;
  extensionId: string;
  alignment: 1 | 2;
  priority: number;
  text: string;
  tooltip?: string;
  command?: string;
  color?: string;
  backgroundColor?: string;
  visible: boolean;
};

export type SerializedDiagnostic = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  message: string;
  severity: 0 | 1 | 2 | 3;
  source?: string;
  code?: string;
};

export type SerializedQuickPickItem = {
  index: number;
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
  kind?: number;
};

export type UiRequestKind =
  | "quickPick"
  | "inputBox"
  | "notification"
  | "openDialog"
  | "saveDialog"
  | "progress";

export type UiRequestPayload = {
  requestId: string;
  extensionId: string;
  kind: UiRequestKind;
  createdAt: number;
  /** notification */
  level?: "info" | "warning" | "error";
  message?: string;
  items?: SerializedQuickPickItem[];
  modal?: boolean;
  detail?: string;
  /** quickPick */
  canSelectMany?: boolean;
  placeholder?: string;
  title?: string;
  matchOnDescription?: boolean;
  matchOnDetail?: boolean;
  /** inputBox */
  value?: string;
  prompt?: string;
  password?: boolean;
  /** progress */
  progressLocation?: number;
  cancellable?: boolean;
  /** interactive quick input (createQuickPick / createInputBox) */
  interactive?: boolean;
  busy?: boolean;
};

export type UiResponsePayload = {
  requestId: string;
  /** quickPick: selected item indices; empty = dismissed */
  selectedIndices?: number[];
  /** inputBox */
  value?: string;
  /** notification: selected action index */
  actionIndex?: number;
  /** open/save dialogs */
  paths?: string[];
  dismissed?: boolean;
};

export type SerializedTextEdit = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  newText: string;
};

export type UiClientEvent = {
  requestId: string;
  type: "valueChanged" | "accepted" | "hidden" | "buttonTriggered" | "cancelled";
  value?: string;
  selectedIndices?: number[];
  buttonIndex?: number;
};

export type SerializedLanguageRegistration = {
  extensionId: string;
  kind:
    | "hover"
    | "completion"
    | "definition"
    | "formatting"
    | "codeAction"
    | "codeLens"
    | "documentSymbol"
    | "inlineCompletion";
  languages: string[];
  triggerCharacters?: string[];
};

export type HostChildEvent =
  | { event: "ready"; payload: { pid: number } }
  | {
      event: "webview-message";
      payload: { surfaceKey: string; extensionId: string; message: unknown };
    }
  | {
      event: "webview-html";
      payload: { surfaceKey: string; extensionId: string; html: string; title?: string };
    }
  | {
      event: "webview-panel";
      payload: {
        surfaceKey: string;
        extensionId: string;
        viewType: string;
        title: string;
        html: string;
        active: boolean;
      };
    }
  | {
      event: "webview-panel-disposed";
      payload: { surfaceKey: string; extensionId: string };
    }
  | { event: "external-url"; payload: { extensionId: string; url: string } }
  | {
      event: "open-document";
      payload: {
        extensionId: string;
        path: string;
        preview?: boolean;
        selection?: EditorSelectionShape;
      };
    }
  | { event: "ui-request"; payload: UiRequestPayload }
  | {
      event: "ui-update";
      payload: { requestId: string; patch: Partial<UiRequestPayload> };
    }
  | { event: "ui-close"; payload: { requestId: string } }
  | {
      event: "progress";
      payload: {
        requestId: string;
        extensionId: string;
        title?: string;
        message?: string;
        increment?: number;
        done?: boolean;
      };
    }
  | { event: "status-bar"; payload: SerializedStatusBarItem }
  | { event: "status-bar-dispose"; payload: { itemId: string } }
  | {
      event: "output";
      payload: { extensionId: string; channel: string; data: string };
    }
  | { event: "output-show"; payload: { extensionId: string; channel: string } }
  | {
      event: "diagnostics";
      payload: {
        extensionId: string;
        collection: string;
        uri: string;
        entries: SerializedDiagnostic[];
      };
    }
  | {
      event: "diagnostics-clear";
      payload: { extensionId: string; collection: string };
    }
  | { event: "context"; payload: { key: string; value: unknown } }
  | {
      event: "editor-edit";
      payload: { extensionId: string; path: string; edits: SerializedTextEdit[] };
    }
  | { event: "clipboard-write"; payload: { extensionId: string; text: string } }
  | { event: "tree-changed"; payload: { extensionId: string; viewId: string } }
  | {
      event: "config-update";
      payload: { extensionId: string; key: string; value: unknown };
    }
  | {
      event: "language-registrations";
      payload: { registrations: SerializedLanguageRegistration[] };
    }
  | {
      event: "activation-started";
      payload: { extensionId: string };
    }
  | {
      event: "activation-finished";
      payload: { extensionId: string; ok: boolean; durationMs: number; error?: string };
    }
  | {
      event: "metrics";
      payload: {
        rss: number;
        heapUsed: number;
        heapTotal: number;
        cpuUserMicros: number;
        cpuSystemMicros: number;
        uptimeMs: number;
      };
    }
  | {
      event: "log";
      payload: { extensionId: string; level: "info" | "warn" | "error"; message: string };
    };

export type HostChildEventName = HostChildEvent["event"];

export type ActivateParams = {
  extensionId: string;
  installPath: string;
  main?: string;
  context: ExtensionContextShape;
  settings?: Record<string, unknown>;
  workspaceRoot?: string;
};

export type HostRequest =
  | { id: string; method: "activate"; params: ActivateParams }
  | {
      id: string;
      method: "executeCommand";
      params: {
        command: string;
        args?: unknown[];
        editorContext?: EditorCommandContext;
        treeItem?: { viewId: string; handle: string };
      };
    }
  | {
      id: string;
      method: "resolveWebviewView";
      params: {
        extensionId: string;
        surfaceId: string;
        surfaceSessionId?: string;
        title?: string;
        state?: unknown;
        theme?: unknown;
        kind?: string;
      };
    }
  | {
      id: string;
      method: "deliverWebviewMessage";
      params: {
        extensionId: string;
        surfaceId: string;
        surfaceSessionId?: string;
        message: unknown;
      };
    }
  | {
      id: string;
      method: "updateWebviewTheme";
      params: {
        extensionId: string;
        surfaceId: string;
        surfaceSessionId?: string;
        theme: unknown;
      };
    }
  | {
      id: string;
      method: "getTreeChildren";
      params: { extensionId: string; viewId: string; parentHandle?: string };
    }
  | { id: string; method: "uiResponse"; params: UiResponsePayload }
  | { id: string; method: "uiEvent"; params: UiClientEvent }
  | {
      id: string;
      method: "provideLanguageFeature";
      params: {
        kind: "hover" | "completion" | "definition" | "formatting";
        uri: string;
        languageId: string;
        content?: string;
        position?: { line: number; character: number };
        formattingOptions?: { tabSize?: number; insertSpaces?: boolean };
        triggerCharacter?: string;
      };
    }
  | { id: string; method: "dispose"; params?: Record<string, never> };

export type HostNotify =
  | {
      notify: "editorContext";
      params: { context: EditorCommandContext | null; reason: EditorContextSyncReason };
    }
  | {
      notify: "configChanged";
      params: { extensionId: string; settings: Record<string, unknown> };
    }
  | { notify: "themeChanged"; params: { theme: unknown } };

export type HostResponse = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type HostChildLine = HostResponse | HostChildEvent;

export function isHostChildEvent(value: unknown): value is HostChildEvent {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { event?: unknown }).event === "string" &&
      !("id" in (value as Record<string, unknown>))
  );
}
