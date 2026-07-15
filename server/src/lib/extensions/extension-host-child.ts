import { createRequire } from "node:module";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type HostRequest =
  | {
      id: string;
      method: "activate";
      params: {
        extensionId: string;
        installPath: string;
        main?: string;
        context: ExtensionContextShape;
      };
    }
  | {
      id: string;
      method: "executeCommand";
      params: {
        command: string;
        args?: unknown[];
        editorContext?: EditorCommandContext;
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
  | { id: string; method: "dispose"; params?: Record<string, never> };

type HostResponse = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

type ExtensionContextShape = {
  extensionId: string;
  extensionPath: string;
  storagePath: string;
  globalStoragePath: string;
  logPath: string;
  resourceBaseUrl: string;
};

type EditorCommandContext = {
  uri?: string;
  path?: string;
  language?: string;
  content?: string;
  selectedText?: string;
  selection?: {
    startLineNumber?: number;
    startColumn?: number;
    endLineNumber?: number;
    endColumn?: number;
  };
};

type Disposable = { dispose: () => void };

const commands = new Map<string, (...args: unknown[]) => unknown>();
const activated = new Set<string>();
const activating = new Map<string, Promise<{ activated: boolean; commands: string[]; staticOnly?: boolean }>>();
const extensionSubscriptions = new Map<string, Disposable[]>();
const extensionRuntimeContexts = new Map<string, ExtensionContextShape>();
const externalUrlQueue: string[] = [];
let activeEditorContext: EditorCommandContext | null = null;
const webviewViewProviders = new Map<
  string,
  {
    extensionId: string;
    provider: {
      resolveWebviewView?: (
        view: unknown,
        context: { state?: unknown },
        token: { isCancellationRequested: boolean; onCancellationRequested: unknown }
      ) => unknown;
    };
  }
>();
const treeDataProviders = new Map<
  string,
  {
    extensionId: string;
    provider: {
      getChildren?: (element?: unknown) => unknown[] | Promise<unknown[]>;
      getTreeItem?: (element: unknown) => unknown | Promise<unknown>;
    };
  }
>();
const resolvedWebviews = new Map<
  string,
  {
    extensionId: string;
    acceptMessage: (message: unknown) => void;
    getHtml: () => string;
    drainMessages: () => unknown[];
    queueTheme: (theme: unknown) => void;
  }
>();
let activeColorThemeKind = 2;

function writeResponse(response: HostResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

class EventEmitter<T> {
  private listeners = new Set<(event: T) => void>();

  event = (listener: (event: T) => void): Disposable => {
    this.listeners.add(listener);
    return {
      dispose: () => this.listeners.delete(listener),
    };
  };

  fire(event?: T): void {
    for (const listener of this.listeners) {
      listener(event as T);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

const activeColorThemeEmitter = new EventEmitter<{ kind: number }>();

class VscodeDisposable {
  private readonly disposeFn: () => void;

  constructor(dispose: () => void = () => undefined) {
    this.disposeFn = dispose;
  }

  dispose(): void {
    this.disposeFn();
  }

  static from(...items: Disposable[]): VscodeDisposable {
    return new VscodeDisposable(() => items.forEach((item) => item.dispose()));
  }
}

function createDisposable(dispose: () => void): Disposable {
  return new VscodeDisposable(dispose);
}

class CancellationTokenSource {
  private readonly emitter = new EventEmitter<void>();
  token = {
    isCancellationRequested: false,
    onCancellationRequested: this.emitter.event,
  };

  cancel(): void {
    this.token.isCancellationRequested = true;
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

class FileSystemError extends Error {
  code: string;

  constructor(message: string, code = "Unknown") {
    super(message);
    this.name = "FileSystemError";
    this.code = code;
  }

  static FileNotFound(message = "File not found"): FileSystemError {
    return new FileSystemError(message, "FileNotFound");
  }

  static FileExists(message = "File exists"): FileSystemError {
    return new FileSystemError(message, "FileExists");
  }

  static FileNotADirectory(message = "File is not a directory"): FileSystemError {
    return new FileSystemError(message, "FileNotADirectory");
  }

  static NoPermissions(message = "No permissions"): FileSystemError {
    return new FileSystemError(message, "NoPermissions");
  }
}

class Position {
  constructor(
    public readonly line: number,
    public readonly character: number
  ) {}
}

class Range {
  constructor(
    public readonly start: Position | number,
    public readonly end: Position | number,
    public readonly endLine?: number,
    public readonly endCharacter?: number
  ) {}
}

class Selection extends Range {}

class Location {
  constructor(
    public readonly uri: unknown,
    public readonly range: unknown
  ) {}
}

class Diagnostic {
  constructor(
    public readonly range: unknown,
    public readonly message: string,
    public readonly severity?: number
  ) {}
}

class CompletionItem {
  constructor(
    public label: string,
    public kind?: number
  ) {}
}

class CompletionList {
  constructor(
    public items: unknown[] = [],
    public isIncomplete = false
  ) {}
}

class CodeAction {
  constructor(
    public title: string,
    public kind?: unknown
  ) {}
}

class CodeLens {
  constructor(
    public range: unknown,
    public command?: unknown
  ) {}
}

class DocumentLink {
  constructor(
    public range: unknown,
    public target?: unknown
  ) {}
}

class MarkdownString {
  value = "";
  isTrusted?: boolean;

  constructor(value = "") {
    this.value = value;
  }

  appendText(value: string): MarkdownString {
    this.value += value;
    return this;
  }

  appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }

  appendCodeblock(value: string): MarkdownString {
    this.value += value;
    return this;
  }
}

class WorkspaceEdit {
  replace(): void {}
  insert(): void {}
  delete(): void {}
  set(): void {}
  entries(): unknown[] {
    return [];
  }
}

class TextEdit {
  constructor(
    public readonly range: unknown,
    public readonly newText: string
  ) {}

  static replace(range: unknown, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }

  static insert(position: unknown, newText: string): TextEdit {
    return new TextEdit(position, newText);
  }

  static delete(range: unknown): TextEdit {
    return new TextEdit(range, "");
  }
}

class SymbolInformation {
  constructor(
    public name: string,
    public kind: number,
    public containerName?: string,
    public location?: unknown
  ) {}
}

class DocumentSymbol {
  constructor(
    public name: string,
    public detail: string,
    public kind: number,
    public range: unknown,
    public selectionRange: unknown
  ) {}
}

class Color {
  constructor(
    public red: number,
    public green: number,
    public blue: number,
    public alpha: number
  ) {}
}

class ColorInformation {
  constructor(
    public range: unknown,
    public color: unknown
  ) {}
}

class ColorPresentation {
  constructor(public label: string) {}
}

class FoldingRange {
  constructor(
    public start: number,
    public end: number,
    public kind?: number
  ) {}
}

class InlayHint {
  constructor(
    public position: unknown,
    public label: unknown,
    public kind?: number
  ) {}
}

class InlayHintLabelPart {
  constructor(public value: string) {}
}

class CallHierarchyItem {
  constructor(
    public kind: number,
    public name: string,
    public detail: string,
    public uri: unknown,
    public range: unknown,
    public selectionRange: unknown
  ) {}
}

class TypeHierarchyItem extends CallHierarchyItem {}

class SemanticTokensLegend {
  constructor(
    public tokenTypes: string[],
    public tokenModifiers: string[] = []
  ) {}
}

class SemanticTokens {
  constructor(public data: Uint32Array) {}
}

class SemanticTokensBuilder {
  private readonly data: number[] = [];
  push(...values: number[]): void {
    this.data.push(...values);
  }
  build(): SemanticTokens {
    return new SemanticTokens(Uint32Array.from(this.data));
  }
}

class ThemeIcon {
  constructor(
    public readonly id: string,
    public readonly color?: unknown
  ) {}

  static File = new ThemeIcon("file");
  static Folder = new ThemeIcon("folder");
}

class ThemeColor {
  constructor(public readonly id: string) {}
}

class RelativePattern {
  base: string;
  pattern: string;

  constructor(base: unknown, pattern: string) {
    this.base =
      base && typeof base === "object" && "fsPath" in base
        ? String((base as { fsPath?: unknown }).fsPath ?? "")
        : String(base ?? "");
    this.pattern = pattern;
  }
}

class TreeItem {
  constructor(
    public label: string,
    public collapsibleState?: number
  ) {}
}

class DocumentHighlight {
  constructor(
    public range: unknown,
    public kind?: number
  ) {}
}

function createMemento() {
  const values = new Map<string, unknown>();
  return {
    get: (key: string, fallback?: unknown) => values.get(key) ?? fallback,
    update: async (key: string, value: unknown) => {
      if (typeof value === "undefined") {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    },
    keys: () => [...values.keys()],
    setKeysForSync: () => undefined,
  };
}

function createCodeActionKind(value: string) {
  return {
    value,
    append(part: string) {
      return createCodeActionKind(value ? `${value}.${part}` : part);
    },
    contains(other: { value?: string }) {
      return Boolean(other.value === value || other.value?.startsWith(`${value}.`));
    },
    intersects(other: { value?: string }) {
      return Boolean(
        other.value === value ||
          other.value?.startsWith(`${value}.`) ||
          value.startsWith(`${other.value ?? ""}.`)
      );
    },
  };
}

function uriToFsPath(uri: unknown): string {
  if (uri && typeof uri === "object" && "fsPath" in uri) {
    return String((uri as { fsPath?: unknown }).fsPath ?? "");
  }
  if (typeof uri === "string") {
    return uri;
  }
  return "";
}

function uriToExternalString(uri: unknown): string {
  if (typeof uri === "string") {
    return uri;
  }
  if (uri && typeof uri === "object") {
    const toString = (uri as { toString?: unknown }).toString;
    if (typeof toString === "function") {
      const value = toString.call(uri);
      if (typeof value === "string") {
        return value;
      }
    }
    const scheme = (uri as { scheme?: unknown }).scheme;
    const pathValue = (uri as { path?: unknown; fsPath?: unknown }).path ?? (uri as { fsPath?: unknown }).fsPath;
    if (typeof scheme === "string" && typeof pathValue === "string") {
      return scheme === "file" ? `file://${pathValue}` : `${scheme}:${pathValue}`;
    }
  }
  return "";
}

function drainExternalUrls(): string[] {
  return externalUrlQueue.splice(0, externalUrlQueue.length);
}

function createUri(scheme: string, fsPath: string, uriPath = fsPath.replace(/\\/g, "/")) {
  return {
    scheme,
    fsPath,
    path: uriPath,
    toString: () => (scheme === "file" ? `file://${uriPath}` : uriPath),
    with: (changes: { scheme?: string; path?: string }) =>
      createUri(changes.scheme ?? scheme, changes.path ?? fsPath, changes.path ?? uriPath),
  };
}

function offsetAt(text: string, position: Position): number {
  const lines = text.split(/\r\n|\r|\n/);
  let offset = 0;
  for (let line = 0; line < Math.min(position.line, lines.length); line += 1) {
    offset += (lines[line]?.length ?? 0) + 1;
  }
  return offset + position.character;
}

function positionAt(text: string, offset: number): Position {
  const safeOffset = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, safeOffset);
  const lines = before.split(/\r\n|\r|\n/);
  const line = Math.max(0, lines.length - 1);
  return new Position(line, lines.at(-1)?.length ?? 0);
}

function selectionFromEditorContext(context: EditorCommandContext | null): Selection {
  const raw = context?.selection;
  const start = new Position(
    Math.max(0, (raw?.startLineNumber ?? 1) - 1),
    Math.max(0, (raw?.startColumn ?? 1) - 1)
  );
  const end = new Position(
    Math.max(0, (raw?.endLineNumber ?? raw?.startLineNumber ?? 1) - 1),
    Math.max(0, (raw?.endColumn ?? raw?.startColumn ?? 1) - 1)
  );
  const selection = new Selection(start, end) as Selection & {
    anchor: Position;
    active: Position;
    isEmpty: boolean;
    isSingleLine: boolean;
  };
  selection.anchor = start;
  selection.active = end;
  selection.isEmpty = start.line === end.line && start.character === end.character;
  selection.isSingleLine = start.line === end.line;
  return selection;
}

function createTextDocumentFromEditorContext(context: EditorCommandContext) {
  const content = context.content ?? "";
  const fsPath = context.path ?? context.uri?.replace(/^file:\/\//, "") ?? "";
  const uri = context.uri?.startsWith("file:")
    ? createUri("file", fsPath, context.uri.replace(/^file:\/\//, ""))
    : createUri("file", fsPath || context.uri || "");
  const lines = content.split(/\r\n|\r|\n/);
  return {
    uri,
    fileName: fsPath,
    isUntitled: false,
    languageId: context.language ?? "plaintext",
    version: 1,
    isDirty: false,
    isClosed: false,
    lineCount: lines.length,
    getText: (range?: { start?: Position; end?: Position }) => {
      if (!range?.start || !range?.end) {
        return content;
      }
      return content.slice(offsetAt(content, range.start), offsetAt(content, range.end));
    },
    lineAt: (lineOrPosition: number | Position) => {
      const line =
        typeof lineOrPosition === "number" ? lineOrPosition : lineOrPosition.line;
      const text = lines[Math.max(0, Math.min(line, lines.length - 1))] ?? "";
      return {
        lineNumber: line,
        text,
        range: new Range(new Position(line, 0), new Position(line, text.length)),
        rangeIncludingLineBreak: new Range(new Position(line, 0), new Position(line, text.length + 1)),
        firstNonWhitespaceCharacterIndex: text.search(/\S|$/),
        isEmptyOrWhitespace: text.trim().length === 0,
      };
    },
    offsetAt: (position: Position) => offsetAt(content, position),
    positionAt: (offset: number) => positionAt(content, offset),
    validateRange: (range: unknown) => range,
    validatePosition: (position: unknown) => position,
  };
}

function createActiveTextEditor() {
  if (!activeEditorContext) {
    return undefined;
  }
  const document = createTextDocumentFromEditorContext(activeEditorContext);
  const selection = selectionFromEditorContext(activeEditorContext);
  return {
    document,
    selection,
    selections: [selection],
    visibleRanges: [],
    options: {},
    viewColumn: 1,
    edit: async () => false,
    insertSnippet: async () => false,
    setDecorations: () => undefined,
    revealRange: () => undefined,
    show: () => undefined,
    hide: () => undefined,
  };
}

function createOutputChannel(extensionId: string, name: string) {
  const write = (level: string, value: string) =>
    process.stderr.write(`[${extensionId}:${name}:${level}] ${value}\n`);
  return {
    name,
    logLevel: 2,
    onDidChangeLogLevel: () => createDisposable(() => undefined),
    append: (value: string) => process.stderr.write(`[${extensionId}:${name}] ${value}`),
    appendLine: (value: string) => write("log", value),
    trace: (value: string) => write("trace", value),
    debug: (value: string) => write("debug", value),
    info: (value: string) => write("info", value),
    warn: (value: string) => write("warn", value),
    error: (value: string) => write("error", value),
    clear: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  };
}

function createTrackedWebview(
  extensionId: string,
  resourceBaseUrl: string,
  extensionRoot: string
): {
  getHtml: () => string;
  getMessages: () => unknown[];
  drainMessages: () => unknown[];
  acceptMessage: (message: unknown) => void;
  queueTheme: (theme: unknown) => void;
  webview: {
    html: string;
    options: Record<string, unknown>;
    cspSource: string;
    onDidReceiveMessage: (listener: (event: unknown) => void) => Disposable;
    postMessage: () => Promise<boolean>;
    asWebviewUri: (uri: unknown) => unknown;
  };
} {
  let html = "";
  const messages: unknown[] = [];
  const incoming = new EventEmitter<unknown>();
  const cspSource = (() => {
    try {
      return resourceBaseUrl ? new URL(resourceBaseUrl).origin : `opencursor-webview://${extensionId}`;
    } catch {
      return `opencursor-webview://${extensionId}`;
    }
  })();
  return {
    getHtml: () => html,
    getMessages: () => [...messages],
    drainMessages: () => messages.splice(0, messages.length),
    acceptMessage: (message: unknown) => incoming.fire(message),
    queueTheme: (theme: unknown) => {
      messages.push({ type: "opencursor-extension-theme", theme });
    },
    webview: {
      get html() {
        return html;
      },
      set html(value: string) {
        html = typeof value === "string" ? value : String(value ?? "");
      },
      options: {},
      cspSource,
      onDidReceiveMessage: incoming.event,
      postMessage: async (message?: unknown) => {
        messages.push(message);
        return true;
      },
      asWebviewUri: (uri: unknown) => {
        if (!resourceBaseUrl) return uri;
        const fsPath = uriToFsPath(uri);
        const relative = path.isAbsolute(fsPath)
          ? path.relative(path.resolve(extensionRoot), fsPath)
          : fsPath;
        return `${resourceBaseUrl}${resourceBaseUrl.includes("?") ? "&" : "?"}path=${encodeURIComponent(relative)}`;
      },
    },
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function treeItemLabel(item: unknown, fallback: unknown): string {
  const raw =
    item && typeof item === "object" && "label" in item
      ? (item as { label?: unknown }).label
      : fallback;
  if (raw && typeof raw === "object" && "label" in raw) {
    return String((raw as { label?: unknown }).label ?? "");
  }
  return String(raw ?? "");
}

async function renderTreeViewHtml(input: {
  title: string;
  provider: {
    getChildren?: (element?: unknown) => unknown[] | Promise<unknown[]>;
    getTreeItem?: (element: unknown) => unknown | Promise<unknown>;
  };
}): Promise<string> {
  const children = await input.provider.getChildren?.();
  const items = Array.isArray(children) ? children : [];
  const rows = await Promise.all(
    items.slice(0, 100).map(async (item) => {
      const treeItem = input.provider.getTreeItem ? await input.provider.getTreeItem(item) : item;
      const label = treeItemLabel(treeItem, item);
      const description =
        treeItem && typeof treeItem === "object" && "description" in treeItem
          ? (treeItem as { description?: unknown }).description
          : undefined;
      return `<li><span>${escapeHtml(label || "(empty)")}</span>${description ? `<small>${escapeHtml(description)}</small>` : ""}</li>`;
    })
  );
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{color-scheme:dark;font-family:system-ui,sans-serif;background:#0f0f10;color:#f4f4f5}
    body{margin:0;background:#0f0f10;color:#f4f4f5}
    main{padding:14px}
    h1{font-size:13px;margin:0 0 10px}
    ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
    li{border:1px solid #27272a;border-radius:6px;padding:7px 9px;background:#18181b;font-size:12px}
    small{display:block;margin-top:2px;color:#a1a1aa}
    p{color:#a1a1aa;font-size:12px}
  </style></head><body><main><h1>${escapeHtml(input.title)}</h1>${
    rows.length > 0 ? `<ul>${rows.join("")}</ul>` : "<p>No tree items.</p>"
  }</main></body></html>`;
}

function resolveExtensionEntry(
  require: ReturnType<typeof createRequire>,
  primaryEntry: string,
  fallbackEntry: string
): string {
  for (const candidate of [primaryEntry, fallbackEntry]) {
    try {
      return require.resolve(candidate);
    } catch {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return primaryEntry;
}

function findExtensionIdForFilename(filename: string): string {
  const normalized = path.resolve(filename);
  for (const [extensionId, context] of extensionRuntimeContexts) {
    const root = path.resolve(context.extensionPath);
    if (normalized === root || normalized.startsWith(`${root}${path.sep}`)) {
      return extensionId;
    }
  }
  return "extension";
}

class VscodeFallbackClass {
  constructor(...args: unknown[]) {
    Object.defineProperty(this, "__opencursorArgs", {
      value: args,
      enumerable: false,
      configurable: true,
    });
  }

  dispose(): void {}
}

function createVscodeShim(extensionId: string) {
  const runtimeContext = extensionRuntimeContexts.get(extensionId);
  const resourceBaseUrl = runtimeContext?.resourceBaseUrl ?? "";
  const extensionRoot = runtimeContext?.extensionPath ?? process.cwd();
  const shim = {
    version: "1.100.0",
    Disposable: VscodeDisposable,
    EventEmitter,
    Event: {
      None: () => createDisposable(() => undefined),
    },
    CancellationTokenSource,
    FileSystemError,
    Position,
    Range,
    Selection,
    Location,
    Diagnostic,
    CompletionItem,
    CompletionList,
    CodeAction,
    CodeLens,
    DocumentLink,
    MarkdownString,
    WorkspaceEdit,
    TextEdit,
    SymbolInformation,
    DocumentSymbol,
    Color,
    ColorInformation,
    ColorPresentation,
    FoldingRange,
    InlayHint,
    InlayHintLabelPart,
    CallHierarchyItem,
    TypeHierarchyItem,
    SemanticTokensLegend,
    SemanticTokens,
    SemanticTokensBuilder,
    ThemeIcon,
    ThemeColor,
    RelativePattern,
    TreeItem,
    DocumentHighlight,
    ConfigurationTarget: {
      Global: 1,
      Workspace: 2,
      WorkspaceFolder: 3,
    },
    ExtensionKind: {
      UI: 1,
      Workspace: 2,
    },
    ExtensionMode: {
      Production: 1,
      Development: 2,
      Test: 3,
    },
    UIKind: {
      Desktop: 1,
      Web: 2,
    },
    ProgressLocation: {
      SourceControl: 1,
      Window: 10,
      Notification: 15,
    },
    DiagnosticSeverity: {
      Error: 0,
      Warning: 1,
      Information: 2,
      Hint: 3,
    },
    DiagnosticTag: {
      Unnecessary: 1,
      Deprecated: 2,
    },
    CompletionItemKind: {
      Text: 0,
      Method: 1,
      Function: 2,
      Constructor: 3,
      Field: 4,
      Variable: 5,
      Class: 6,
      Interface: 7,
      Module: 8,
      Property: 9,
      Unit: 10,
      Value: 11,
      Enum: 12,
      Keyword: 13,
      Snippet: 14,
    },
    SymbolKind: {
      File: 0,
      Module: 1,
      Namespace: 2,
      Package: 3,
      Class: 4,
      Method: 5,
      Property: 6,
      Field: 7,
      Constructor: 8,
      Enum: 9,
      Interface: 10,
      Function: 11,
      Variable: 12,
      Constant: 13,
      String: 14,
      Number: 15,
      Boolean: 16,
      Array: 17,
      Object: 18,
      Key: 19,
      Null: 20,
      EnumMember: 21,
      Struct: 22,
      Event: 23,
      Operator: 24,
      TypeParameter: 25,
    },
    FoldingRangeKind: {
      Comment: 1,
      Imports: 2,
      Region: 3,
    },
    InlayHintKind: {
      Type: 1,
      Parameter: 2,
    },
    TreeItemCollapsibleState: {
      None: 0,
      Collapsed: 1,
      Expanded: 2,
    },
    DocumentHighlightKind: {
      Text: 0,
      Read: 1,
      Write: 2,
    },
    FileType: {
      Unknown: 0,
      File: 1,
      Directory: 2,
      SymbolicLink: 64,
    },
    StatusBarAlignment: {
      Left: 1,
      Right: 2,
    },
    LogLevel: {
      Trace: 1,
      Debug: 2,
      Info: 3,
      Warning: 4,
      Error: 5,
      Off: 6,
    },
    ColorThemeKind: {
      Light: 1,
      Dark: 2,
      HighContrast: 3,
      HighContrastLight: 4,
    },
    OverviewRulerLane: {
      Left: 1,
      Center: 2,
      Right: 4,
      Full: 7,
    },
    DecorationRangeBehavior: {
      OpenOpen: 0,
      ClosedClosed: 1,
      OpenClosed: 2,
      ClosedOpen: 3,
    },
    ViewColumn: {
      Active: -1,
      Beside: -2,
      One: 1,
      Two: 2,
      Three: 3,
    },
    CodeActionKind: {
      Empty: createCodeActionKind(""),
      QuickFix: createCodeActionKind("quickfix"),
      Refactor: createCodeActionKind("refactor"),
      RefactorExtract: createCodeActionKind("refactor.extract"),
      RefactorInline: createCodeActionKind("refactor.inline"),
      RefactorRewrite: createCodeActionKind("refactor.rewrite"),
      Source: createCodeActionKind("source"),
      SourceOrganizeImports: createCodeActionKind("source.organizeImports"),
      SourceFixAll: createCodeActionKind("source.fixAll"),
    },
    Uri: {
      file: (fsPath: string) => createUri("file", fsPath),
      parse: (value: string) => createUri(value.split(":")[0] ?? "", value, value),
      joinPath: (base: { fsPath?: string; path?: string }, ...segments: string[]) => {
        const root = base.fsPath ?? base.path ?? "";
        const fsPath = path.join(root, ...segments);
        return createUri("file", fsPath);
      },
    },
    commands: {
      registerCommand: (command: string, callback: (...args: unknown[]) => unknown) => {
        commands.set(command, callback);
        return createDisposable(() => commands.delete(command));
      },
      executeCommand: async (command: string, ...args: unknown[]) => {
        const handler = commands.get(command);
        if (!handler) {
          if (
            command === "setContext" ||
            command.startsWith("workbench.") ||
            command.startsWith("vscode.") ||
            command.startsWith("editor.") ||
            command.startsWith("markdown.") ||
            command.startsWith("_")
          ) {
            return undefined;
          }
          throw new Error(`Command not found: ${command}`);
        }
        return await handler(...args);
      },
      getCommands: async () => [...commands.keys()],
    },
    window: {
      get activeTextEditor() {
        return createActiveTextEditor();
      },
      get visibleTextEditors() {
        const editor = createActiveTextEditor();
        return editor ? [editor] : [];
      },
      get activeColorTheme() {
        return { kind: activeColorThemeKind };
      },
      tabGroups: {
        all: [],
        activeTabGroup: undefined,
        onDidChangeTabs: () => createDisposable(() => undefined),
        onDidChangeTabGroups: () => createDisposable(() => undefined),
      },
      onDidChangeActiveTextEditor: () => createDisposable(() => undefined),
      onDidChangeVisibleTextEditors: () => createDisposable(() => undefined),
      onDidChangeTextEditorSelection: () => createDisposable(() => undefined),
      onDidChangeTextEditorVisibleRanges: () => createDisposable(() => undefined),
      onDidChangeTextEditorOptions: () => createDisposable(() => undefined),
      onDidChangeTextEditorViewColumn: () => createDisposable(() => undefined),
      onDidChangeActiveNotebookEditor: () => createDisposable(() => undefined),
      onDidChangeVisibleNotebookEditors: () => createDisposable(() => undefined),
      onDidChangeActiveColorTheme: activeColorThemeEmitter.event,
      showInformationMessage: async (message: string) => message,
      showWarningMessage: async (message: string) => message,
      showErrorMessage: async (message: string) => message,
      showQuickPick: async (items: unknown[]) => (Array.isArray(items) ? items[0] : undefined),
      showInputBox: async (options?: { value?: string; prompt?: string }) => options?.value ?? "",
      createQuickPick: () => ({
        items: [],
        selectedItems: [],
        activeItems: [],
        value: "",
        placeholder: "",
        title: "",
        buttons: [],
        busy: false,
        enabled: true,
        ignoreFocusOut: false,
        canSelectMany: false,
        show: () => undefined,
        hide: () => undefined,
        dispose: () => undefined,
        onDidAccept: () => createDisposable(() => undefined),
        onDidHide: () => createDisposable(() => undefined),
        onDidChangeValue: () => createDisposable(() => undefined),
        onDidChangeSelection: () => createDisposable(() => undefined),
        onDidChangeActive: () => createDisposable(() => undefined),
        onDidTriggerButton: () => createDisposable(() => undefined),
      }),
      createInputBox: () => ({
        value: "",
        placeholder: "",
        prompt: "",
        title: "",
        buttons: [],
        busy: false,
        enabled: true,
        ignoreFocusOut: false,
        password: false,
        validationMessage: undefined,
        show: () => undefined,
        hide: () => undefined,
        dispose: () => undefined,
        onDidAccept: () => createDisposable(() => undefined),
        onDidHide: () => createDisposable(() => undefined),
        onDidChangeValue: () => createDisposable(() => undefined),
        onDidTriggerButton: () => createDisposable(() => undefined),
      }),
      showOpenDialog: async () => undefined,
      showSaveDialog: async () => undefined,
      createTextEditorDecorationType: () => ({
        key: `opencursor-decoration-${Math.random().toString(36).slice(2)}`,
        dispose: () => undefined,
      }),
      registerUriHandler: () => createDisposable(() => undefined),
      registerTerminalProfileProvider: () => createDisposable(() => undefined),
      createTerminal: (options?: { name?: string } | string) => ({
        name: typeof options === "string" ? options : options?.name ?? "Extension Terminal",
        processId: Promise.resolve(undefined),
        creationOptions: options,
        exitStatus: undefined,
        sendText: () => undefined,
        show: () => undefined,
        hide: () => undefined,
        dispose: () => undefined,
      }),
      onDidOpenTerminal: () => createDisposable(() => undefined),
      onDidCloseTerminal: () => createDisposable(() => undefined),
      onDidChangeActiveTerminal: () => createDisposable(() => undefined),
      onDidChangeTerminalState: () => createDisposable(() => undefined),
      registerWebviewViewProvider: (
        viewId: string,
        provider: {
          resolveWebviewView?: (
            view: unknown,
            context: { state?: unknown },
            token: { isCancellationRequested: boolean; onCancellationRequested: unknown }
          ) => unknown;
        }
      ) => {
        webviewViewProviders.set(viewId, { extensionId, provider });
        return createDisposable(() => webviewViewProviders.delete(viewId));
      },
      registerTreeDataProvider: (
        viewId: string,
        provider: {
          getChildren?: (element?: unknown) => unknown[] | Promise<unknown[]>;
          getTreeItem?: (element: unknown) => unknown | Promise<unknown>;
        }
      ) => {
        treeDataProviders.set(viewId, { extensionId, provider });
        return createDisposable(() => treeDataProviders.delete(viewId));
      },
      createTreeView: (
        viewId: string,
        options?: {
          treeDataProvider?: {
            getChildren?: (element?: unknown) => unknown[] | Promise<unknown[]>;
            getTreeItem?: (element: unknown) => unknown | Promise<unknown>;
          };
        }
      ) => {
        if (options?.treeDataProvider) {
          treeDataProviders.set(viewId, { extensionId, provider: options.treeDataProvider });
        }
        return {
          title: "",
          description: "",
          message: "",
          selection: [],
          visible: true,
          reveal: async () => undefined,
          onDidChangeSelection: () => createDisposable(() => undefined),
          onDidChangeVisibility: () => createDisposable(() => undefined),
          onDidCollapseElement: () => createDisposable(() => undefined),
          onDidExpandElement: () => createDisposable(() => undefined),
          onDidChangeCheckboxState: () => createDisposable(() => undefined),
          dispose: () => treeDataProviders.delete(viewId),
        };
      },
      createWebviewPanel: (_viewType: string, title: string) => {
        const tracked = createTrackedWebview(extensionId, resourceBaseUrl, extensionRoot);
        return {
          title,
          webview: tracked.webview,
          reveal: () => undefined,
          dispose: () => undefined,
          onDidDispose: () => createDisposable(() => undefined),
          onDidChangeViewState: () => createDisposable(() => undefined),
        };
      },
      createOutputChannel: (name: string) => createOutputChannel(extensionId, name),
      createStatusBarItem: () => ({
        text: "",
        tooltip: "",
        command: undefined,
        show: () => undefined,
        hide: () => undefined,
        dispose: () => undefined,
      }),
    },
    workspace: {
      isTrusted: false,
      workspaceFolders: [],
      name: path.basename(process.cwd()),
      getWorkspaceFolder: () => undefined,
      asRelativePath: (value: unknown) => {
        const fsPath = uriToFsPath(value);
        return fsPath ? path.relative(process.cwd(), fsPath) : String(value ?? "");
      },
      findFiles: async () => [],
      fs: {
        stat: async (uri: unknown) => {
          const stats = await fs.stat(uriToFsPath(uri));
          return {
            type: stats.isDirectory() ? 2 : stats.isFile() ? 1 : 0,
            ctime: stats.ctimeMs,
            mtime: stats.mtimeMs,
            size: stats.size,
          };
        },
        readFile: async (uri: unknown) => await fs.readFile(uriToFsPath(uri)),
        writeFile: async (uri: unknown, content: Uint8Array) =>
          await fs.writeFile(uriToFsPath(uri), content),
        delete: async (uri: unknown) => await fs.rm(uriToFsPath(uri), { recursive: true, force: true }),
        createDirectory: async (uri: unknown) => await fs.mkdir(uriToFsPath(uri), { recursive: true }),
        readDirectory: async (uri: unknown) => {
          const entries = await fs.readdir(uriToFsPath(uri), { withFileTypes: true });
          return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : entry.isFile() ? 1 : 0]);
        },
      },
      createFileSystemWatcher: () => ({
        onDidCreate: () => createDisposable(() => undefined),
        onDidChange: () => createDisposable(() => undefined),
        onDidDelete: () => createDisposable(() => undefined),
        dispose: () => undefined,
      }),
      get textDocuments() {
        return activeEditorContext ? [createTextDocumentFromEditorContext(activeEditorContext)] : [];
      },
      onDidOpenTextDocument: () => createDisposable(() => undefined),
      onDidCloseTextDocument: () => createDisposable(() => undefined),
      onDidSaveTextDocument: () => createDisposable(() => undefined),
      onWillSaveTextDocument: () => createDisposable(() => undefined),
      onDidChangeTextDocument: () => createDisposable(() => undefined),
      onDidCreateFiles: () => createDisposable(() => undefined),
      onDidDeleteFiles: () => createDisposable(() => undefined),
      onDidRenameFiles: () => createDisposable(() => undefined),
      onDidOpenNotebookDocument: () => createDisposable(() => undefined),
      onDidCloseNotebookDocument: () => createDisposable(() => undefined),
      onDidSaveNotebookDocument: () => createDisposable(() => undefined),
      onDidChangeNotebookDocument: () => createDisposable(() => undefined),
      registerTextDocumentContentProvider: () => createDisposable(() => undefined),
      openTextDocument: async (uriOrOptions: unknown) => {
        if (activeEditorContext) {
          return createTextDocumentFromEditorContext(activeEditorContext);
        }
        return {
          uri: uriOrOptions,
          fileName:
            uriOrOptions && typeof uriOrOptions === "object" && "fsPath" in uriOrOptions
              ? String((uriOrOptions as { fsPath?: unknown }).fsPath ?? "")
              : "",
          isUntitled: false,
          languageId: "plaintext",
          version: 1,
          isDirty: false,
          isClosed: false,
          getText: () => "",
          lineAt: () => ({ text: "" }),
          lineCount: 0,
        };
      },
      getConfiguration: (section?: string) => ({
        get: (key: string, fallback?: unknown) => {
          const fullKey = [section, key].filter(Boolean).join(".");
          if (/schemas|dictionaries|dictionary|languageIds|filetypes|fileTypes|words|paths|ignorePaths|include|exclude|imports/i.test(fullKey)) {
            return Array.isArray(fallback) ? fallback : [];
          }
          if (/associations|aliases|folders|files|languages|packs|themes|icons/i.test(fullKey)) {
            return fallback && typeof fallback === "object" && !Array.isArray(fallback) ? fallback : {};
          }
          if (/enabled|auto|show|detect|validate|format|trace/i.test(fullKey)) {
            return typeof fallback === "boolean" ? fallback : false;
          }
          return fallback;
        },
        update: async () => undefined,
        has: () => false,
        inspect: (key?: string) => {
          const fullKey = [section, key].filter(Boolean).join(".");
          const defaultValue =
            /schemas|dictionaries|dictionary|languageIds|filetypes|fileTypes|words|paths|ignorePaths|include|exclude|imports/i.test(fullKey)
              ? []
              : /enabled|auto|show|detect|validate|format|trace/i.test(fullKey)
                ? false
                : {};
          return {
            key: fullKey,
            defaultValue,
            globalValue: undefined,
            workspaceValue: undefined,
            workspaceFolderValue: undefined,
            defaultLanguageValue: undefined,
            globalLanguageValue: undefined,
            workspaceLanguageValue: undefined,
            workspaceFolderLanguageValue: undefined,
            languageIds: [],
          };
        },
      }),
      onDidChangeConfiguration: () => createDisposable(() => undefined),
      onDidChangeWorkspaceFolders: () => createDisposable(() => undefined),
      onDidGrantWorkspaceTrust: () => createDisposable(() => undefined),
    },
    env: {
      appName: "OpenCursor",
      appHost: "web",
      uiKind: 2,
      uriScheme: "opencursor",
      asExternalUri: async (uri: unknown) => uri,
      isTelemetryEnabled: false,
      onDidChangeTelemetryEnabled: () => createDisposable(() => undefined),
      createTelemetryLogger: () => ({
        logUsage: () => undefined,
        logError: () => undefined,
        dispose: () => undefined,
      }),
      openExternal: async (uri: unknown) => {
        const url = uriToExternalString(uri);
        if (url) {
          externalUrlQueue.push(url);
        }
        return true;
      },
      clipboard: {
        readText: async () => "",
        writeText: async () => undefined,
      },
    },
    l10n: {
      uri: undefined,
      bundle: undefined,
      t: (message: string | { message: string; args?: unknown[] }, ...args: unknown[]) => {
        const text = typeof message === "string" ? message : message.message;
        const values = typeof message === "string" ? args : message.args ?? args;
        return values.reduce<string>(
          (acc, value, index) => acc.replace(new RegExp(`\\{${index}\\}`, "g"), String(value)),
          text
        );
      },
    },
    languages: {
      getLanguages: async () => [
        "css",
        "html",
        "javascript",
        "javascriptreact",
        "json",
        "markdown",
        "plaintext",
        "typescript",
        "typescriptreact",
        "yaml",
      ],
      match: () => 0,
      createLanguageStatusItem: (id: string, selector: unknown) => ({
        id,
        selector,
        name: "",
        text: "",
        detail: "",
        command: undefined,
        severity: 0,
        accessibilityInformation: undefined,
        busy: false,
        dispose: () => undefined,
      }),
      registerCodeActionsProvider: () => createDisposable(() => undefined),
      registerCompletionItemProvider: () => createDisposable(() => undefined),
      registerHoverProvider: () => createDisposable(() => undefined),
      registerDefinitionProvider: () => createDisposable(() => undefined),
      registerDocumentLinkProvider: () => createDisposable(() => undefined),
      registerDocumentFormattingEditProvider: () => createDisposable(() => undefined),
      registerDocumentRangeFormattingEditProvider: () => createDisposable(() => undefined),
      registerRenameProvider: () => createDisposable(() => undefined),
      registerDocumentSymbolProvider: () => createDisposable(() => undefined),
      registerWorkspaceSymbolProvider: () => createDisposable(() => undefined),
      registerReferenceProvider: () => createDisposable(() => undefined),
      registerImplementationProvider: () => createDisposable(() => undefined),
      registerTypeDefinitionProvider: () => createDisposable(() => undefined),
      registerDeclarationProvider: () => createDisposable(() => undefined),
      registerCodeLensProvider: () => createDisposable(() => undefined),
      createDiagnosticCollection: () => ({
        set: () => undefined,
        delete: () => undefined,
        clear: () => undefined,
        dispose: () => undefined,
      }),
    },
    extensions: {
      getExtension: () => undefined,
      onDidChange: () => createDisposable(() => undefined),
      all: [],
    },
  };
  return new Proxy(shim, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      if (
        typeof property === "string" &&
        /^[A-Z]/.test(property) &&
        property !== "then"
      ) {
        return VscodeFallbackClass;
      }
      return undefined;
    },
  });
}

type ModuleLoader = {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

const requireNodeModule = createRequire(import.meta.url);
const moduleLoader = requireNodeModule("node:module") as ModuleLoader;
const originalLoad = moduleLoader._load;
moduleLoader._load = function patchedLoad(
  this: unknown,
  request: string,
  parent: unknown,
  isMain: boolean
) {
  if (request === "vscode") {
    const filename =
      parent && typeof parent === "object" && "filename" in parent
        ? String((parent as { filename?: unknown }).filename ?? "")
        : "";
    const extensionId = findExtensionIdForFilename(filename);
    return createVscodeShim(extensionId);
  }
  return originalLoad.call(this, request, parent, isMain);
};

function hasStaticContributionOnlyValue(packageJSON: unknown): boolean {
  if (!packageJSON || typeof packageJSON !== "object") {
    return false;
  }
  const contributes = (packageJSON as { contributes?: unknown }).contributes;
  if (!contributes || typeof contributes !== "object") {
    return false;
  }
  return (
    Array.isArray((contributes as { themes?: unknown }).themes) ||
    Array.isArray((contributes as { iconThemes?: unknown }).iconThemes) ||
    Array.isArray((contributes as { fileIconThemes?: unknown }).fileIconThemes) ||
    Array.isArray((contributes as { productIconThemes?: unknown }).productIconThemes)
  );
}

async function activate(params: Extract<HostRequest, { method: "activate" }>["params"]) {
  if (activated.has(params.extensionId)) {
    return { activated: true, commands: [...commands.keys()] };
  }
  const existing = activating.get(params.extensionId);
  if (existing) {
    return await existing;
  }
  const pending = activateInner(params);
  activating.set(params.extensionId, pending);
  try {
    return await pending;
  } finally {
    activating.delete(params.extensionId);
  }
}

async function activateInner(params: Extract<HostRequest, { method: "activate" }>["params"]) {
  extensionRuntimeContexts.set(params.extensionId, params.context);
  if (!params.main) {
    activated.add(params.extensionId);
    return { activated: true, commands: [...commands.keys()], staticOnly: true };
  }
  const entry = path.resolve(params.installPath, "extension", params.main);
  const fallbackEntry = path.resolve(params.installPath, params.main);
  let packageJSON: unknown = {};
  try {
    packageJSON = JSON.parse(
      await fs.readFile(path.join(params.context.extensionPath, "package.json"), "utf8")
    );
  } catch {
    packageJSON = {};
  }
  const require = createRequire(import.meta.url);
  let moduleExports: unknown;
  try {
    moduleExports = require(resolveExtensionEntry(require, entry, fallbackEntry));
  } catch (error) {
    if (!hasStaticContributionOnlyValue(packageJSON)) {
      throw error;
    }
    process.stderr.write(
      `[${params.extensionId}] runtime import failed for static contribution package; treating manifest contributions as active.\n`
    );
    activated.add(params.extensionId);
    return { activated: true, commands: [...commands.keys()], staticOnly: true };
  }
  const vscode = createVscodeShim(params.extensionId);
  const extensionUri = vscode.Uri.file(params.context.extensionPath);
  const context = {
    ...params.context,
    subscriptions: [] as Disposable[],
    extensionMode: vscode.ExtensionMode.Production,
    asAbsolutePath: (relativePath: string) =>
      path.join(params.context.extensionPath, relativePath),
    extension: {
      id: params.extensionId,
      extensionUri,
      extensionPath: params.context.extensionPath,
      packageJSON,
      extensionKind: [vscode.ExtensionKind.Workspace],
      isActive: true,
      exports: moduleExports,
      activate: async () => moduleExports,
    },
    extensionUri,
    storageUri: vscode.Uri.file(params.context.storagePath),
    globalStorageUri: vscode.Uri.file(params.context.globalStoragePath),
    logUri: vscode.Uri.file(params.context.logPath),
    workspaceState: createMemento(),
    globalState: createMemento(),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
  };
  const activateFn =
    moduleExports && typeof moduleExports === "object" && "activate" in moduleExports
      ? (moduleExports as { activate?: unknown }).activate
      : undefined;
  if (typeof activateFn === "function") {
    try {
      await activateFn(context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("Host provider has already been initialized")) {
        throw error;
      }
      process.stderr.write(
        `[${params.extensionId}] activation reported already-initialized host provider; treating as active.\n`
      );
    }
  }
  activated.add(params.extensionId);
  extensionSubscriptions.set(params.extensionId, context.subscriptions);
  return { activated: true, commands: [...commands.keys()] };
}

async function handleRequest(request: HostRequest): Promise<HostResponse> {
  try {
    if (request.method === "activate") {
      return { id: request.id, ok: true, result: await activate(request.params) };
    }
    if (request.method === "executeCommand") {
      const handler = commands.get(request.params.command);
      if (!handler) {
        throw new Error(`Command not found: ${request.params.command}`);
      }
      activeEditorContext = request.params.editorContext ?? activeEditorContext;
      const commandResult = await handler(...(request.params.args ?? []));
      return {
        id: request.id,
        ok: true,
        result: {
          commandResult,
          externalUrls: drainExternalUrls(),
        },
      };
    }
    if (request.method === "resolveWebviewView") {
      const webviewKey = request.params.surfaceSessionId ?? request.params.surfaceId;
      const existingWebview = resolvedWebviews.get(webviewKey);
      if (existingWebview && existingWebview.extensionId === request.params.extensionId) {
        if (request.params.theme) {
          existingWebview.queueTheme(request.params.theme);
        }
        return {
          id: request.id,
          ok: true,
          result: {
            html: existingWebview.getHtml(),
            messages: existingWebview.drainMessages(),
            externalUrls: drainExternalUrls(),
            missingProvider: false,
          },
        };
      }
      const exactEntry = webviewViewProviders.get(request.params.surfaceId);
      const extensionEntries = [...webviewViewProviders.entries()].filter(
        ([, provider]) => provider.extensionId === request.params.extensionId
      );
      const entry = exactEntry ?? (extensionEntries.length === 1 ? extensionEntries[0]?.[1] : undefined);
      if (!entry) {
        const treeEntry = treeDataProviders.get(request.params.surfaceId);
        if (treeEntry && treeEntry.extensionId === request.params.extensionId) {
          return {
            id: request.id,
            ok: true,
            result: {
              html: await renderTreeViewHtml({
                title: request.params.title ?? request.params.surfaceId,
                provider: treeEntry.provider,
              }),
              messages: [],
              externalUrls: drainExternalUrls(),
              missingProvider: false,
              treeView: true,
            },
          };
        }
        return {
          id: request.id,
          ok: true,
          result: {
            html: "",
            missingProvider: true,
            message: `No webview provider is registered for ${request.params.surfaceId}.`,
            registeredProviders: [...webviewViewProviders.keys()],
          },
        };
      }
      if (entry.extensionId !== request.params.extensionId) {
        throw new Error(
          `Webview provider ${request.params.surfaceId} belongs to ${entry.extensionId}, not ${request.params.extensionId}.`
        );
      }
      const runtimeContext = extensionRuntimeContexts.get(request.params.extensionId);
      const tracked = createTrackedWebview(
        request.params.extensionId,
        runtimeContext?.resourceBaseUrl ?? "",
        runtimeContext?.extensionPath ?? process.cwd()
      );
      const view = {
        viewType: request.params.surfaceId,
        title: request.params.title ?? request.params.surfaceId,
        description: "",
        visible: true,
        webview: tracked.webview,
        show: () => undefined,
        onDidDispose: () => createDisposable(() => undefined),
        onDidChangeVisibility: () => createDisposable(() => undefined),
      };
      await entry.provider.resolveWebviewView?.(view, { state: request.params.state }, {
        isCancellationRequested: false,
        onCancellationRequested: () => createDisposable(() => undefined),
      });
      if (request.params.theme) {
        tracked.queueTheme(request.params.theme);
      }
      resolvedWebviews.set(webviewKey, {
        extensionId: request.params.extensionId,
        acceptMessage: tracked.acceptMessage,
        getHtml: tracked.getHtml,
        drainMessages: tracked.drainMessages,
        queueTheme: tracked.queueTheme,
      });
      return {
        id: request.id,
        ok: true,
        result: {
          html: tracked.getHtml(),
          messages: tracked.drainMessages(),
          externalUrls: drainExternalUrls(),
          missingProvider: false,
        },
      };
    }
    if (request.method === "deliverWebviewMessage") {
      const webviewKey = request.params.surfaceSessionId ?? request.params.surfaceId;
      const webview = resolvedWebviews.get(webviewKey);
      if (!webview || webview.extensionId !== request.params.extensionId) {
        return {
          id: request.id,
          ok: true,
          result: { messages: [], externalUrls: drainExternalUrls(), missingWebview: true },
        };
      }
      webview.acceptMessage(request.params.message);
      await new Promise((resolve) => setTimeout(resolve, 500));
      return {
        id: request.id,
        ok: true,
        result: {
          messages: webview.drainMessages(),
          externalUrls: drainExternalUrls(),
          missingWebview: false,
        },
      };
    }
    if (request.method === "updateWebviewTheme") {
      const webviewKey = request.params.surfaceSessionId ?? request.params.surfaceId;
      const webview = resolvedWebviews.get(webviewKey);
      const theme = request.params.theme as { colorScheme?: unknown } | undefined;
      activeColorThemeKind = theme?.colorScheme === "light" ? 1 : 2;
      activeColorThemeEmitter.fire({ kind: activeColorThemeKind });
      if (!webview || webview.extensionId !== request.params.extensionId) {
        return {
          id: request.id,
          ok: true,
          result: { messages: [], externalUrls: drainExternalUrls(), missingWebview: true },
        };
      }
      webview.queueTheme(request.params.theme);
      return {
        id: request.id,
        ok: true,
        result: {
          messages: webview.drainMessages(),
          externalUrls: drainExternalUrls(),
          missingWebview: false,
        },
      };
    }
    if (request.method === "dispose") {
      for (const subscriptions of extensionSubscriptions.values()) {
        subscriptions.forEach((item) => item.dispose());
      }
      process.exit(0);
    }
    return { id: (request as { id: string }).id, ok: false, error: "Unknown host method." };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    };
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) return;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    void handleRequest(JSON.parse(line) as HostRequest).then(writeResponse);
  }
});

process.stderr.write(
  `[extensions] host child ready at ${fileURLToPath(import.meta.url)}\n`
);
