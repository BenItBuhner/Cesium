/**
 * Extension host child process.
 *
 * Runs VS Code extensions inside a plain Node process. Speaks newline-delimited
 * JSON with the parent server over stdio (see host-protocol.ts). All extension
 * output (webview messages, notifications, diagnostics, status bar, output
 * channels, tree refreshes, ...) is pushed to the parent the moment it happens
 * through the unsolicited event channel; nothing is buffered waiting for the
 * next poll.
 *
 * This file must stay runtime-dependency-free: only Node builtins plus
 * type-only imports (erased at compile time). `chokidar` is loaded
 * opportunistically from the server's node_modules when available.
 */
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ActivateParams,
  EditorCommandContext,
  EditorContextSyncReason,
  EditorSelectionShape,
  ExtensionContextShape,
  HostChildEvent,
  HostNotify,
  HostRequest,
  HostResponse,
  SerializedDiagnostic,
  SerializedLanguageRegistration,
  SerializedQuickPickItem,
  SerializedStatusBarItem,
  SerializedTextEdit,
  SerializedTreeItem,
  UiClientEvent,
  UiRequestPayload,
  UiResponsePayload,
} from "./host-protocol.js";

type Disposable = { dispose: () => void };

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

const MAX_EVENT_PAYLOAD_BYTES = 8 * 1024 * 1024;

let stdoutBlocked = false;
const stdoutQueue: string[] = [];

function writeLine(line: string): void {
  if (stdoutBlocked) {
    stdoutQueue.push(line);
    return;
  }
  const ok = process.stdout.write(line);
  if (!ok) {
    stdoutBlocked = true;
    process.stdout.once("drain", () => {
      stdoutBlocked = false;
      const queued = stdoutQueue.splice(0, stdoutQueue.length);
      for (const item of queued) {
        writeLine(item);
      }
    });
  }
}

function writeResponse(response: HostResponse): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(response);
  } catch (error) {
    serialized = JSON.stringify({
      id: response.id,
      ok: false,
      error: `Failed to serialize response: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  writeLine(`${serialized}\n`);
}

function emitEvent(event: HostChildEvent): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(event);
  } catch {
    process.stderr.write(`[extensions] dropped unserializable event '${event.event}'\n`);
    return;
  }
  if (serialized.length > MAX_EVENT_PAYLOAD_BYTES) {
    process.stderr.write(
      `[extensions] dropped oversized event '${event.event}' (${serialized.length} bytes)\n`
    );
    return;
  }
  writeLine(`${serialized}\n`);
}

/* ------------------------------------------------------------------ */
/* Core primitives                                                     */
/* ------------------------------------------------------------------ */

class EventEmitter<T> {
  private listeners = new Set<(event: T) => void>();

  event = (listener: (event: T) => void): Disposable => {
    this.listeners.add(listener);
    return {
      dispose: () => this.listeners.delete(listener),
    };
  };

  fire(event?: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event as T);
      } catch (error) {
        process.stderr.write(
          `[extensions] listener error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
        );
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

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

function createDisposable(dispose: () => void = () => undefined): Disposable {
  return new VscodeDisposable(dispose);
}

const noopEvent = () => createDisposable();

class CancellationTokenSource {
  private readonly emitter = new EventEmitter<void>();
  token = {
    isCancellationRequested: false,
    onCancellationRequested: this.emitter.event,
  };

  cancel(): void {
    if (this.token.isCancellationRequested) return;
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

  static FileIsADirectory(message = "File is a directory"): FileSystemError {
    return new FileSystemError(message, "FileIsADirectory");
  }

  static NoPermissions(message = "No permissions"): FileSystemError {
    return new FileSystemError(message, "NoPermissions");
  }

  static Unavailable(message = "Unavailable"): FileSystemError {
    return new FileSystemError(message, "Unavailable");
  }
}

class Position {
  constructor(
    public readonly line: number,
    public readonly character: number
  ) {}

  isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }

  isBeforeOrEqual(other: Position): boolean {
    return this.isBefore(other) || this.isEqual(other);
  }

  isAfter(other: Position): boolean {
    return !this.isBeforeOrEqual(other);
  }

  isAfterOrEqual(other: Position): boolean {
    return !this.isBefore(other);
  }

  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }

  compareTo(other: Position): number {
    if (this.isEqual(other)) return 0;
    return this.isBefore(other) ? -1 : 1;
  }

  translate(lineDeltaOrChange?: number | { lineDelta?: number; characterDelta?: number }, characterDelta = 0): Position {
    if (typeof lineDeltaOrChange === "object" && lineDeltaOrChange !== null) {
      return new Position(
        this.line + (lineDeltaOrChange.lineDelta ?? 0),
        this.character + (lineDeltaOrChange.characterDelta ?? 0)
      );
    }
    return new Position(this.line + (lineDeltaOrChange ?? 0), this.character + characterDelta);
  }

  with(lineOrChange?: number | { line?: number; character?: number }, character?: number): Position {
    if (typeof lineOrChange === "object" && lineOrChange !== null) {
      return new Position(lineOrChange.line ?? this.line, lineOrChange.character ?? this.character);
    }
    return new Position(lineOrChange ?? this.line, character ?? this.character);
  }
}

function asPosition(value: unknown): Position {
  if (value instanceof Position) return value;
  if (value && typeof value === "object") {
    const raw = value as { line?: unknown; character?: unknown };
    return new Position(
      typeof raw.line === "number" ? raw.line : 0,
      typeof raw.character === "number" ? raw.character : 0
    );
  }
  return new Position(0, 0);
}

class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(a: Position | number, b: Position | number, c?: Position | number, d?: number) {
    if (typeof a === "number" && typeof b === "number") {
      this.start = new Position(a, b);
      this.end =
        typeof c === "number" ? new Position(c, d ?? 0) : c instanceof Position ? c : new Position(a, b);
    } else {
      const start = asPosition(a);
      const end = asPosition(b);
      if (start.isAfter(end)) {
        this.start = end;
        this.end = start;
      } else {
        this.start = start;
        this.end = end;
      }
    }
  }

  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }

  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }

  contains(positionOrRange: Position | Range): boolean {
    if (positionOrRange instanceof Range) {
      return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
    }
    const position = asPosition(positionOrRange);
    return position.isAfterOrEqual(this.start) && position.isBeforeOrEqual(this.end);
  }

  isEqual(other: Range): boolean {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }

  intersection(other: Range): Range | undefined {
    const start = this.start.isAfter(other.start) ? this.start : other.start;
    const end = this.end.isBefore(other.end) ? this.end : other.end;
    return start.isAfter(end) ? undefined : new Range(start, end);
  }

  union(other: Range): Range {
    const start = this.start.isBefore(other.start) ? this.start : other.start;
    const end = this.end.isAfter(other.end) ? this.end : other.end;
    return new Range(start, end);
  }

  with(startOrChange?: Position | { start?: Position; end?: Position }, end?: Position): Range {
    if (startOrChange && !(startOrChange instanceof Position)) {
      return new Range(startOrChange.start ?? this.start, startOrChange.end ?? this.end);
    }
    return new Range(startOrChange ?? this.start, end ?? this.end);
  }
}

class Selection extends Range {
  readonly anchor: Position;
  readonly active: Position;

  constructor(a: Position | number, b: Position | number, c?: Position | number, d?: number) {
    super(a, b, c, d);
    if (typeof a === "number" && typeof b === "number") {
      this.anchor = new Position(a, b);
      this.active = typeof c === "number" ? new Position(c, d ?? 0) : new Position(a, b);
    } else {
      this.anchor = asPosition(a);
      this.active = asPosition(b);
    }
  }

  get isReversed(): boolean {
    return this.anchor.isAfter(this.active);
  }
}

class Location {
  constructor(
    public readonly uri: unknown,
    public readonly range: unknown
  ) {}
}

class Diagnostic {
  source?: string;
  code?: string | number;
  relatedInformation?: unknown[];
  tags?: number[];

  constructor(
    public range: Range,
    public message: string,
    public severity: number = 0
  ) {}
}

class CompletionItem {
  detail?: string;
  documentation?: unknown;
  sortText?: string;
  filterText?: string;
  insertText?: unknown;
  range?: unknown;
  commitCharacters?: string[];
  preselect?: boolean;
  command?: unknown;

  constructor(
    public label: unknown,
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
  edit?: unknown;
  diagnostics?: unknown[];
  command?: unknown;
  isPreferred?: boolean;

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

class Hover {
  constructor(
    public contents: unknown,
    public range?: unknown
  ) {}
}

class MarkdownString {
  value = "";
  isTrusted?: boolean;
  supportHtml?: boolean;
  supportThemeIcons?: boolean;

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

  appendCodeblock(value: string, language = ""): MarkdownString {
    this.value += `\n\`\`\`${language}\n${value}\n\`\`\`\n`;
    return this;
  }
}

class SnippetString {
  value: string;

  constructor(value = "") {
    this.value = value;
  }

  appendText(value: string): SnippetString {
    this.value += value.replace(/\$|}|\\/g, "\\$&");
    return this;
  }

  appendTabstop(num = 0): SnippetString {
    this.value += `$${num}`;
    return this;
  }

  appendPlaceholder(value: string | ((snippet: SnippetString) => void), num = 1): SnippetString {
    if (typeof value === "function") {
      const nested = new SnippetString();
      value(nested);
      this.value += `\${${num}:${nested.value}}`;
    } else {
      this.value += `\${${num}:${value}}`;
    }
    return this;
  }

  appendChoice(values: string[], num = 1): SnippetString {
    this.value += `\${${num}|${values.join(",")}|}`;
    return this;
  }

  appendVariable(name: string, defaultValue: string | ((snippet: SnippetString) => void)): SnippetString {
    if (typeof defaultValue === "function") {
      const nested = new SnippetString();
      defaultValue(nested);
      this.value += `\${${name}:${nested.value}}`;
    } else {
      this.value += `\${${name}:${defaultValue}}`;
    }
    return this;
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
    return new TextEdit(new Range(asPosition(position), asPosition(position)), newText);
  }

  static delete(range: unknown): TextEdit {
    return new TextEdit(range, "");
  }

  static setEndOfLine(): TextEdit {
    return new TextEdit(new Range(0, 0, 0, 0), "");
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
  children: DocumentSymbol[] = [];

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
        : base && typeof base === "object" && "uri" in base
          ? String(((base as { uri?: { fsPath?: unknown } }).uri?.fsPath) ?? "")
          : String(base ?? "");
    this.pattern = pattern;
  }
}

class TreeItem {
  id?: string;
  description?: string | boolean;
  tooltip?: unknown;
  command?: unknown;
  iconPath?: unknown;
  contextValue?: string;
  resourceUri?: unknown;
  checkboxState?: unknown;
  accessibilityInformation?: unknown;

  constructor(
    public label: unknown,
    public collapsibleState: number = 0
  ) {}
}

class DocumentHighlight {
  constructor(
    public range: unknown,
    public kind?: number
  ) {}
}

class FileDecoration {
  constructor(
    public badge?: string,
    public tooltip?: string,
    public color?: unknown
  ) {}
}

class LanguageModelChatMessage {
  constructor(
    public role: number,
    public content: unknown,
    public name?: string
  ) {}

  static User(content: unknown, name?: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage(1, content, name);
  }

  static Assistant(content: unknown, name?: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage(2, content, name);
  }
}

/* ------------------------------------------------------------------ */
/* Uri                                                                 */
/* ------------------------------------------------------------------ */

type UriLike = {
  scheme: string;
  authority: string;
  path: string;
  query: string;
  fragment: string;
  fsPath: string;
  with: (change: Partial<Record<"scheme" | "authority" | "path" | "query" | "fragment", string>>) => UriLike;
  toString: () => string;
  toJSON: () => Record<string, string>;
};

function makeUri(input: {
  scheme?: string;
  authority?: string;
  path?: string;
  query?: string;
  fragment?: string;
}): UriLike {
  const scheme = input.scheme ?? "file";
  const authority = input.authority ?? "";
  const uriPath = (input.path ?? "").replace(/\\/g, "/");
  const query = input.query ?? "";
  const fragment = input.fragment ?? "";
  const uri: UriLike = {
    scheme,
    authority,
    path: uriPath,
    query,
    fragment,
    get fsPath() {
      if (process.platform === "win32" && /^\/[a-zA-Z]:/.test(uriPath)) {
        return uriPath.slice(1).replace(/\//g, "\\");
      }
      return uriPath;
    },
    with(change) {
      return makeUri({
        scheme: change.scheme ?? scheme,
        authority: change.authority ?? authority,
        path: change.path ?? uriPath,
        query: change.query ?? query,
        fragment: change.fragment ?? fragment,
      });
    },
    toString() {
      let value = `${scheme}:`;
      if (authority || scheme === "file") {
        value += `//${authority}`;
      }
      value += uriPath;
      if (query) value += `?${query}`;
      if (fragment) value += `#${fragment}`;
      return value;
    },
    toJSON() {
      return { scheme, authority, path: uriPath, query, fragment, fsPath: uri.fsPath };
    },
  };
  return uri;
}

function parseUri(value: string): UriLike {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(
    value
  );
  if (!match) {
    return makeUri({ scheme: "file", path: value });
  }
  let uriPath = match[3] ?? "";
  try {
    uriPath = decodeURIComponent(uriPath);
  } catch {
    /* keep raw */
  }
  return makeUri({
    scheme: match[1] ?? "file",
    authority: match[2] ?? "",
    path: uriPath,
    query: match[4] ?? "",
    fragment: match[5] ?? "",
  });
}

const Uri = {
  file: (fsPath: string) => makeUri({ scheme: "file", path: path.resolve(String(fsPath ?? "")) }),
  parse: (value: string) => parseUri(String(value ?? "")),
  from: (components: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }) =>
    makeUri(components),
  joinPath: (base: { fsPath?: string; path?: string }, ...segments: string[]) => {
    const root = base?.fsPath ?? base?.path ?? "";
    return makeUri({
      scheme: (base as { scheme?: string })?.scheme ?? "file",
      authority: (base as { authority?: string })?.authority ?? "",
      path: path.join(root, ...segments),
      query: (base as { query?: string })?.query ?? "",
      fragment: (base as { fragment?: string })?.fragment ?? "",
    });
  },
};

function uriToFsPath(uri: unknown): string {
  if (uri && typeof uri === "object" && "fsPath" in uri) {
    return String((uri as { fsPath?: unknown }).fsPath ?? "");
  }
  if (typeof uri === "string") {
    return uri.startsWith("file://") ? uri.slice("file://".length) : uri;
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
      if (typeof value === "string" && value !== "[object Object]") {
        return value;
      }
    }
    const scheme = (uri as { scheme?: unknown }).scheme;
    const pathValue =
      (uri as { path?: unknown; fsPath?: unknown }).path ?? (uri as { fsPath?: unknown }).fsPath;
    if (typeof scheme === "string" && typeof pathValue === "string") {
      return scheme === "file" ? `file://${pathValue}` : `${scheme}:${pathValue}`;
    }
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* Global state                                                        */
/* ------------------------------------------------------------------ */

const workspaceRoot = process.cwd();
const commands = new Map<string, (...args: unknown[]) => unknown>();
const activated = new Set<string>();
const activating = new Map<
  string,
  Promise<{ activated: boolean; commands: string[]; staticOnly?: boolean }>
>();
const extensionSubscriptions = new Map<string, Disposable[]>();
const extensionRuntimeContexts = new Map<string, ExtensionContextShape>();
const extensionRegistry = new Map<string, Record<string, unknown>>();
const machineId = createHash("sha1").update(os.hostname()).digest("hex").slice(0, 32);
const sessionId = randomUUID();
let clipboardCache = "";
let activeColorThemeKind = 2;
const activeColorThemeEmitter = new EventEmitter<{ kind: number }>();
const contextKeys = new Map<string, unknown>();

/* ------------------------------------------------------------------ */
/* Persistent mementos + secrets                                       */
/* ------------------------------------------------------------------ */

type PersistentStore = {
  filePath: string;
  values: Map<string, unknown>;
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

const persistentStores = new Set<PersistentStore>();
const MEMENTO_FLUSH_DELAY_MS = 150;

async function loadStoreValues(filePath: string): Promise<Map<string, unknown>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return new Map(Object.entries(parsed));
    }
  } catch {
    /* first run or corrupted file */
  }
  return new Map();
}

async function flushStore(store: PersistentStore): Promise<void> {
  if (!store.dirty) return;
  store.dirty = false;
  const payload = JSON.stringify(Object.fromEntries(store.values), null, 0);
  const tmpPath = `${store.filePath}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(store.filePath), { recursive: true });
    await fs.writeFile(tmpPath, payload, "utf8");
    await fs.rename(tmpPath, store.filePath);
  } catch (error) {
    store.dirty = true;
    process.stderr.write(
      `[extensions] failed to persist ${store.filePath}: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}

function scheduleStoreFlush(store: PersistentStore): void {
  store.dirty = true;
  if (store.timer) return;
  store.timer = setTimeout(() => {
    store.timer = undefined;
    void flushStore(store);
  }, MEMENTO_FLUSH_DELAY_MS);
}

async function flushAllStores(): Promise<void> {
  await Promise.all(
    [...persistentStores].map((store) => {
      if (store.timer) {
        clearTimeout(store.timer);
        store.timer = undefined;
      }
      return flushStore(store);
    })
  );
}

async function createPersistentMemento(filePath: string): Promise<{
  get: (key: string, fallback?: unknown) => unknown;
  update: (key: string, value: unknown) => Promise<void>;
  keys: () => string[];
  setKeysForSync: () => void;
}> {
  const store: PersistentStore = {
    filePath,
    values: await loadStoreValues(filePath),
    dirty: false,
  };
  persistentStores.add(store);
  return {
    get: (key: string, fallback?: unknown) =>
      store.values.has(key) ? store.values.get(key) : fallback,
    update: async (key: string, value: unknown) => {
      if (typeof value === "undefined") {
        store.values.delete(key);
      } else {
        store.values.set(key, value);
      }
      scheduleStoreFlush(store);
    },
    keys: () => [...store.values.keys()],
    setKeysForSync: () => undefined,
  };
}

async function createSecretStorage(filePath: string): Promise<{
  get: (key: string) => Promise<string | undefined>;
  store: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
  keys: () => Promise<string[]>;
  onDidChange: (listener: (event: { key: string }) => void) => Disposable;
}> {
  const store: PersistentStore = {
    filePath,
    values: await loadStoreValues(filePath),
    dirty: false,
  };
  persistentStores.add(store);
  const emitter = new EventEmitter<{ key: string }>();
  return {
    get: async (key: string) => {
      const value = store.values.get(key);
      return typeof value === "string" ? value : undefined;
    },
    store: async (key: string, value: string) => {
      store.values.set(key, String(value));
      scheduleStoreFlush(store);
      emitter.fire({ key });
    },
    delete: async (key: string) => {
      store.values.delete(key);
      scheduleStoreFlush(store);
      emitter.fire({ key });
    },
    keys: async () => [...store.values.keys()],
    onDidChange: emitter.event,
  };
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

type ConfigStore = {
  values: Map<string, unknown>;
  defaults: Map<string, unknown>;
};

const configStores = new Map<string, ConfigStore>();
const configChangeEmitter = new EventEmitter<{ affectsConfiguration: (section: string) => boolean }>();

const BUILTIN_CONFIG_DEFAULTS: Record<string, unknown> = {
  "editor.tabSize": 4,
  "editor.insertSpaces": true,
  "editor.fontSize": 14,
  "editor.fontFamily": "ui-monospace, monospace",
  "editor.wordWrap": "off",
  "editor.formatOnSave": false,
  "editor.detectIndentation": true,
  "files.eol": "\n",
  "files.autoSave": "off",
  "files.encoding": "utf8",
  "files.exclude": {},
  "files.associations": {},
  "search.exclude": { "**/node_modules": true, "**/.git": true },
  "workbench.colorTheme": "Default Dark Modern",
  "telemetry.telemetryLevel": "off",
  "http.proxySupport": "override",
  "terminal.integrated.shell": undefined,
};

function ensureConfigStore(extensionId: string): ConfigStore {
  let store = configStores.get(extensionId);
  if (!store) {
    store = { values: new Map(), defaults: new Map() };
    configStores.set(extensionId, store);
  }
  return store;
}

function flattenSettingsObject(value: unknown, prefix: string, into: Map<string, unknown>): void {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const entries = Object.entries(value as Record<string, unknown>);
    // Heuristic: dotted keys stored flat stay flat; nested objects flatten one level
    // deep so `{"cline": {"apiProvider": "x"}}` and `{"cline.apiProvider": "x"}` agree.
    for (const [key, nested] of entries) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (
        nested &&
        typeof nested === "object" &&
        !Array.isArray(nested) &&
        Object.getPrototypeOf(nested) === Object.prototype &&
        !key.includes(".")
      ) {
        flattenSettingsObject(nested, fullKey, into);
      } else {
        into.set(fullKey, nested);
      }
    }
    return;
  }
  if (prefix) {
    into.set(prefix, value);
  }
}

function applyExtensionSettings(extensionId: string, settings: Record<string, unknown>): void {
  const store = ensureConfigStore(extensionId);
  store.values.clear();
  flattenSettingsObject(settings, "", store.values);
}

function extractConfigDefaults(packageJSON: unknown): Map<string, unknown> {
  const defaults = new Map<string, unknown>();
  const contributes =
    packageJSON && typeof packageJSON === "object"
      ? (packageJSON as { contributes?: unknown }).contributes
      : undefined;
  const configuration =
    contributes && typeof contributes === "object"
      ? (contributes as { configuration?: unknown }).configuration
      : undefined;
  const sections = Array.isArray(configuration) ? configuration : configuration ? [configuration] : [];
  for (const section of sections) {
    const properties =
      section && typeof section === "object"
        ? (section as { properties?: unknown }).properties
        : undefined;
    if (!properties || typeof properties !== "object") continue;
    for (const [key, descriptor] of Object.entries(properties as Record<string, unknown>)) {
      if (!descriptor || typeof descriptor !== "object") continue;
      const raw = descriptor as { default?: unknown; type?: unknown };
      if ("default" in raw) {
        defaults.set(key, raw.default);
        continue;
      }
      const type = Array.isArray(raw.type) ? raw.type[0] : raw.type;
      if (type === "boolean") defaults.set(key, false);
      else if (type === "string") defaults.set(key, "");
      else if (type === "array") defaults.set(key, []);
      else if (type === "object") defaults.set(key, {});
      else if (type === "number" || type === "integer") defaults.set(key, 0);
    }
  }
  return defaults;
}

function collectPrefixObject(map: Map<string, unknown>, prefix: string, into: Record<string, unknown>): boolean {
  let found = false;
  const search = `${prefix}.`;
  for (const [key, value] of map) {
    if (!key.startsWith(search)) continue;
    found = true;
    const rest = key.slice(search.length);
    const parts = rest.split(".");
    let cursor: Record<string, unknown> = into;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index]!;
      const next = cursor[part];
      if (next && typeof next === "object" && !Array.isArray(next)) {
        cursor = next as Record<string, unknown>;
      } else {
        const created: Record<string, unknown> = {};
        cursor[part] = created;
        cursor = created;
      }
    }
    cursor[parts.at(-1)!] = value;
  }
  return found;
}

function lookupConfigValue(extensionId: string, fullKey: string): { found: boolean; value: unknown } {
  const stores: Array<Map<string, unknown>> = [];
  const own = configStores.get(extensionId);
  if (own) {
    stores.push(own.values);
  }
  // Cross-extension reads: fall back to every other store's user values, then defaults.
  for (const [otherId, store] of configStores) {
    if (otherId !== extensionId) stores.push(store.values);
  }
  if (own) stores.push(own.defaults);
  for (const [otherId, store] of configStores) {
    if (otherId !== extensionId) stores.push(store.defaults);
  }

  for (const map of stores) {
    if (map.has(fullKey)) {
      return { found: true, value: map.get(fullKey) };
    }
  }
  // Nested object build: merge defaults under values.
  const merged: Record<string, unknown> = {};
  let found = false;
  for (let index = stores.length - 1; index >= 0; index -= 1) {
    if (collectPrefixObject(stores[index]!, fullKey, merged)) {
      found = true;
    }
  }
  if (found) {
    return { found: true, value: merged };
  }
  if (fullKey in BUILTIN_CONFIG_DEFAULTS) {
    return { found: true, value: BUILTIN_CONFIG_DEFAULTS[fullKey] };
  }
  return { found: false, value: undefined };
}

function heuristicConfigDefault(fullKey: string, fallback: unknown): unknown {
  if (typeof fallback !== "undefined") return fallback;
  if (
    /schemas|dictionaries|dictionary|languageIds|filetypes|fileTypes|words|paths|ignorePaths|include|exclude|imports|patterns|rules$/i.test(
      fullKey
    )
  ) {
    return [];
  }
  if (/associations|aliases|folders|packs|icons$/i.test(fullKey)) {
    return {};
  }
  return undefined;
}

function createConfigurationObject(extensionId: string, section?: string) {
  const resolveKey = (key: string) => (section ? `${section}.${key}` : key);
  return {
    get: (key: string, fallback?: unknown) => {
      const fullKey = resolveKey(key);
      const result = lookupConfigValue(extensionId, fullKey);
      if (result.found) {
        return result.value ?? fallback;
      }
      return heuristicConfigDefault(fullKey, fallback);
    },
    has: (key: string) => lookupConfigValue(extensionId, resolveKey(key)).found,
    update: async (key: string, value: unknown) => {
      const fullKey = resolveKey(key);
      const store = ensureConfigStore(extensionId);
      if (typeof value === "undefined") {
        store.values.delete(fullKey);
      } else {
        store.values.set(fullKey, value);
      }
      emitEvent({ event: "config-update", payload: { extensionId, key: fullKey, value } });
      configChangeEmitter.fire({
        affectsConfiguration: (candidate: string) =>
          fullKey === candidate || fullKey.startsWith(`${candidate}.`),
      });
    },
    inspect: (key?: string) => {
      const fullKey = [section, key].filter(Boolean).join(".");
      const store = configStores.get(extensionId);
      return {
        key: fullKey,
        defaultValue: store?.defaults.get(fullKey),
        globalValue: store?.values.get(fullKey),
        workspaceValue: undefined,
        workspaceFolderValue: undefined,
        defaultLanguageValue: undefined,
        globalLanguageValue: undefined,
        workspaceLanguageValue: undefined,
        workspaceFolderLanguageValue: undefined,
        languageIds: [],
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Documents & editors                                                 */
/* ------------------------------------------------------------------ */

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".json": "json",
  ".jsonc": "jsonc",
  ".md": "markdown",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".html": "html",
  ".htm": "html",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".sql": "sql",
  ".swift": "swift",
  ".kt": "kotlin",
  ".dart": "dart",
  ".vue": "vue",
  ".svelte": "svelte",
  ".txt": "plaintext",
};

function languageForPath(fsPath: string): string {
  return LANGUAGE_BY_EXTENSION[path.extname(fsPath).toLowerCase()] ?? "plaintext";
}

type DocumentState = {
  fsPath: string;
  languageId: string;
  content: string;
  version: number;
  dirty: boolean;
  untitled: boolean;
};

const documentStates = new Map<string, DocumentState>();
const documentObjects = new Map<string, ReturnType<typeof buildDocumentObject>>();
const editorObjects = new Map<string, ReturnType<typeof buildEditorObject>>();
let activeDocumentPath: string | null = null;
let activeSelectionShape: EditorSelectionShape | null = null;
let untitledCounter = 0;

const onDidOpenTextDocumentEmitter = new EventEmitter<unknown>();
const onDidCloseTextDocumentEmitter = new EventEmitter<unknown>();
const onDidSaveTextDocumentEmitter = new EventEmitter<unknown>();
const onDidChangeTextDocumentEmitter = new EventEmitter<unknown>();
const onDidChangeActiveTextEditorEmitter = new EventEmitter<unknown>();
const onDidChangeVisibleTextEditorsEmitter = new EventEmitter<unknown>();
const onDidChangeTextEditorSelectionEmitter = new EventEmitter<unknown>();

function offsetAt(text: string, position: Position): number {
  const lines = text.split(/\r\n|\r|\n/);
  let offset = 0;
  for (let line = 0; line < Math.min(position.line, lines.length); line += 1) {
    offset += (lines[line]?.length ?? 0) + 1;
  }
  return Math.min(text.length, offset + position.character);
}

function positionAt(text: string, offset: number): Position {
  const safeOffset = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, safeOffset);
  const lines = before.split(/\r\n|\r|\n/);
  const line = Math.max(0, lines.length - 1);
  return new Position(line, lines.at(-1)?.length ?? 0);
}

function selectionFromShape(shape: EditorSelectionShape | null): Selection {
  const start = new Position(
    Math.max(0, (shape?.startLineNumber ?? 1) - 1),
    Math.max(0, (shape?.startColumn ?? 1) - 1)
  );
  const end = new Position(
    Math.max(0, (shape?.endLineNumber ?? shape?.startLineNumber ?? 1) - 1),
    Math.max(0, (shape?.endColumn ?? shape?.startColumn ?? 1) - 1)
  );
  return new Selection(start, end);
}

function buildDocumentObject(state: DocumentState) {
  const uri = state.untitled
    ? makeUri({ scheme: "untitled", path: state.fsPath })
    : Uri.file(state.fsPath);
  return {
    uri,
    get fileName() {
      return state.fsPath;
    },
    get isUntitled() {
      return state.untitled;
    },
    get languageId() {
      return state.languageId;
    },
    get version() {
      return state.version;
    },
    get isDirty() {
      return state.dirty;
    },
    get isClosed() {
      return !documentStates.has(state.fsPath);
    },
    get lineCount() {
      return state.content.split(/\r\n|\r|\n/).length;
    },
    get eol() {
      return state.content.includes("\r\n") ? 2 : 1;
    },
    save: async () => {
      if (state.untitled) return false;
      try {
        await fs.writeFile(state.fsPath, state.content, "utf8");
        state.dirty = false;
        onDidSaveTextDocumentEmitter.fire(documentObjects.get(state.fsPath));
        return true;
      } catch {
        return false;
      }
    },
    getText: (range?: { start?: Position; end?: Position }) => {
      if (!range?.start || !range?.end) {
        return state.content;
      }
      return state.content.slice(
        offsetAt(state.content, asPosition(range.start)),
        offsetAt(state.content, asPosition(range.end))
      );
    },
    getWordRangeAtPosition: (position: Position, regex?: RegExp) => {
      const lines = state.content.split(/\r\n|\r|\n/);
      const line = lines[position.line] ?? "";
      const wordRegex = regex ?? /[A-Za-z0-9_$]+/g;
      wordRegex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = wordRegex.exec(line))) {
        if (match.index <= position.character && wordRegex.lastIndex >= position.character) {
          return new Range(
            new Position(position.line, match.index),
            new Position(position.line, wordRegex.lastIndex)
          );
        }
        if (match.index > position.character) break;
        if (wordRegex.lastIndex === match.index) wordRegex.lastIndex += 1;
      }
      return undefined;
    },
    lineAt: (lineOrPosition: number | Position) => {
      const lines = state.content.split(/\r\n|\r|\n/);
      const line =
        typeof lineOrPosition === "number" ? lineOrPosition : asPosition(lineOrPosition).line;
      const clamped = Math.max(0, Math.min(line, lines.length - 1));
      const text = lines[clamped] ?? "";
      return {
        lineNumber: clamped,
        text,
        range: new Range(new Position(clamped, 0), new Position(clamped, text.length)),
        rangeIncludingLineBreak: new Range(
          new Position(clamped, 0),
          new Position(clamped, text.length + 1)
        ),
        firstNonWhitespaceCharacterIndex: text.search(/\S|$/),
        isEmptyOrWhitespace: text.trim().length === 0,
      };
    },
    offsetAt: (position: Position) => offsetAt(state.content, asPosition(position)),
    positionAt: (offset: number) => positionAt(state.content, offset),
    validateRange: (range: unknown) => range,
    validatePosition: (position: unknown) => position,
  };
}

function getOrCreateDocument(state: DocumentState) {
  let doc = documentObjects.get(state.fsPath);
  if (!doc) {
    doc = buildDocumentObject(state);
    documentObjects.set(state.fsPath, doc);
  }
  return doc;
}

function serializeRange(range: unknown): SerializedTextEdit | null {
  if (!range || typeof range !== "object") return null;
  const start = asPosition((range as { start?: unknown }).start);
  const end = asPosition((range as { end?: unknown }).end);
  return {
    startLine: start.line,
    startColumn: start.character,
    endLine: end.line,
    endColumn: end.character,
    newText: "",
  };
}

function applyTextEditsToContent(content: string, edits: SerializedTextEdit[]): string {
  const sorted = [...edits].sort((a, b) =>
    a.startLine === b.startLine ? b.startColumn - a.startColumn : b.startLine - a.startLine
  );
  let result = content;
  for (const edit of sorted) {
    const start = offsetAt(result, new Position(edit.startLine, edit.startColumn));
    const end = offsetAt(result, new Position(edit.endLine, edit.endColumn));
    result = result.slice(0, start) + edit.newText + result.slice(end);
  }
  return result;
}

function buildEditorObject(state: DocumentState, extensionId: string) {
  const editor = {
    get document() {
      return getOrCreateDocument(state);
    },
    get selection() {
      return activeDocumentPath === state.fsPath
        ? selectionFromShape(activeSelectionShape)
        : selectionFromShape(null);
    },
    set selection(_value: Selection) {
      /* selection pushes back to the client are not supported yet */
    },
    get selections() {
      return [editor.selection];
    },
    visibleRanges: [] as Range[],
    options: { tabSize: 4, insertSpaces: true },
    viewColumn: 1,
    edit: async (
      callback: (builder: {
        replace: (range: unknown, text: string) => void;
        insert: (position: unknown, text: string) => void;
        delete: (range: unknown) => void;
        setEndOfLine: (eol: number) => void;
      }) => void
    ) => {
      const edits: SerializedTextEdit[] = [];
      try {
        callback({
          replace: (range, text) => {
            const serialized = serializeRange(range);
            if (serialized) edits.push({ ...serialized, newText: String(text ?? "") });
          },
          insert: (position, text) => {
            const pos = asPosition(position);
            edits.push({
              startLine: pos.line,
              startColumn: pos.character,
              endLine: pos.line,
              endColumn: pos.character,
              newText: String(text ?? ""),
            });
          },
          delete: (range) => {
            const serialized = serializeRange(range);
            if (serialized) edits.push(serialized);
          },
          setEndOfLine: () => undefined,
        });
      } catch (error) {
        process.stderr.write(
          `[extensions] editor.edit callback failed: ${error instanceof Error ? error.message : String(error)}\n`
        );
        return false;
      }
      if (edits.length === 0) return true;
      state.content = applyTextEditsToContent(state.content, edits);
      state.version += 1;
      state.dirty = true;
      emitEvent({ event: "editor-edit", payload: { extensionId, path: state.fsPath, edits } });
      onDidChangeTextDocumentEmitter.fire({
        document: getOrCreateDocument(state),
        contentChanges: edits.map((edit) => ({
          range: new Range(
            new Position(edit.startLine, edit.startColumn),
            new Position(edit.endLine, edit.endColumn)
          ),
          rangeOffset: 0,
          rangeLength: 0,
          text: edit.newText,
        })),
        reason: undefined,
      });
      return true;
    },
    insertSnippet: async () => false,
    setDecorations: () => undefined,
    revealRange: () => undefined,
    show: () => undefined,
    hide: () => undefined,
  };
  return editor;
}

function getOrCreateEditor(state: DocumentState, extensionId: string) {
  let editor = editorObjects.get(state.fsPath);
  if (!editor) {
    editor = buildEditorObject(state, extensionId);
    editorObjects.set(state.fsPath, editor);
  }
  return editor;
}

function upsertDocumentFromContext(context: EditorCommandContext): DocumentState | null {
  const fsPath = context.path ?? context.uri?.replace(/^file:\/\//, "");
  if (!fsPath) return null;
  let state = documentStates.get(fsPath);
  const isNew = !state;
  if (!state) {
    state = {
      fsPath,
      languageId: context.language ?? languageForPath(fsPath),
      content: context.content ?? "",
      version: context.version ?? 1,
      dirty: context.dirty ?? false,
      untitled: false,
    };
    documentStates.set(fsPath, state);
  } else {
    if (typeof context.content === "string") state.content = context.content;
    if (context.language) state.languageId = context.language;
    if (typeof context.version === "number") state.version = context.version;
    if (typeof context.dirty === "boolean") state.dirty = context.dirty;
  }
  if (isNew) {
    onDidOpenTextDocumentEmitter.fire(getOrCreateDocument(state));
  }
  return state;
}

function applyEditorContextSync(
  context: EditorCommandContext | null,
  reason: EditorContextSyncReason
): void {
  if (reason === "close") {
    const fsPath = context?.path ?? context?.uri?.replace(/^file:\/\//, "");
    if (fsPath && documentStates.has(fsPath)) {
      const doc = documentObjects.get(fsPath);
      documentStates.delete(fsPath);
      documentObjects.delete(fsPath);
      editorObjects.delete(fsPath);
      if (doc) onDidCloseTextDocumentEmitter.fire(doc);
      if (activeDocumentPath === fsPath) {
        activeDocumentPath = null;
        onDidChangeActiveTextEditorEmitter.fire(undefined);
        onDidChangeVisibleTextEditorsEmitter.fire([]);
      }
    }
    return;
  }
  if (!context) {
    if (activeDocumentPath !== null) {
      activeDocumentPath = null;
      onDidChangeActiveTextEditorEmitter.fire(undefined);
      onDidChangeVisibleTextEditorsEmitter.fire([]);
    }
    return;
  }
  const state = upsertDocumentFromContext(context);
  if (!state) return;
  const previousActive = activeDocumentPath;
  activeDocumentPath = state.fsPath;
  activeSelectionShape = context.selection ?? activeSelectionShape;
  const editor = getOrCreateEditor(state, "workbench");
  if (reason === "open" || reason === "focus") {
    if (previousActive !== state.fsPath) {
      onDidChangeActiveTextEditorEmitter.fire(editor);
      onDidChangeVisibleTextEditorsEmitter.fire([editor]);
    }
  }
  if (reason === "selection") {
    onDidChangeTextEditorSelectionEmitter.fire({
      textEditor: editor,
      selections: [editor.selection],
      kind: 2,
    });
  }
  if (reason === "edit") {
    onDidChangeTextDocumentEmitter.fire({
      document: getOrCreateDocument(state),
      contentChanges: [
        {
          range: new Range(new Position(0, 0), positionAt(state.content, state.content.length)),
          rangeOffset: 0,
          rangeLength: 0,
          text: state.content,
        },
      ],
      reason: undefined,
    });
  }
  if (reason === "save") {
    state.dirty = false;
    onDidSaveTextDocumentEmitter.fire(getOrCreateDocument(state));
  }
}

function getActiveEditor(extensionId: string) {
  if (!activeDocumentPath) return undefined;
  const state = documentStates.get(activeDocumentPath);
  if (!state) return undefined;
  return getOrCreateEditor(state, extensionId);
}

async function openTextDocumentByPath(fsPath: string): Promise<ReturnType<typeof buildDocumentObject>> {
  const existing = documentStates.get(fsPath);
  if (existing) return getOrCreateDocument(existing);
  const content = await fs.readFile(fsPath, "utf8");
  const state: DocumentState = {
    fsPath,
    languageId: languageForPath(fsPath),
    content,
    version: 1,
    dirty: false,
    untitled: false,
  };
  documentStates.set(fsPath, state);
  const doc = getOrCreateDocument(state);
  onDidOpenTextDocumentEmitter.fire(doc);
  return doc;
}

/* ------------------------------------------------------------------ */
/* Webviews                                                            */
/* ------------------------------------------------------------------ */

type TrackedWebview = {
  extensionId: string;
  surfaceKey: string;
  acceptMessage: (message: unknown) => void;
  getHtml: () => string;
  webview: {
    html: string;
    options: Record<string, unknown>;
    cspSource: string;
    onDidReceiveMessage: (listener: (event: unknown) => void) => Disposable;
    postMessage: (message?: unknown) => Promise<boolean>;
    asWebviewUri: (uri: unknown) => unknown;
  };
};

const resolvedWebviews = new Map<string, TrackedWebview>();
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
const webviewPanelSerializers = new Map<
  string,
  {
    extensionId: string;
    serializer: {
      deserializeWebviewPanel?: (panel: unknown, state: unknown) => unknown;
    };
  }
>();

function createTrackedWebview(input: {
  extensionId: string;
  surfaceKey: string;
  emitHtml: boolean;
}): TrackedWebview {
  const runtimeContext = extensionRuntimeContexts.get(input.extensionId);
  const resourceBaseUrl = runtimeContext?.resourceBaseUrl ?? "";
  const extensionRoot = runtimeContext?.extensionPath ?? process.cwd();
  let html = "";
  const incoming = new EventEmitter<unknown>();
  const cspSource = (() => {
    try {
      return resourceBaseUrl
        ? new URL(resourceBaseUrl).origin
        : `opencursor-webview://${input.extensionId}`;
    } catch {
      return `opencursor-webview://${input.extensionId}`;
    }
  })();
  const tracked: TrackedWebview = {
    extensionId: input.extensionId,
    surfaceKey: input.surfaceKey,
    acceptMessage: (message: unknown) => incoming.fire(message),
    getHtml: () => html,
    webview: {
      get html() {
        return html;
      },
      set html(value: string) {
        const next = typeof value === "string" ? value : String(value ?? "");
        if (next === html) return;
        html = next;
        if (input.emitHtml) {
          emitEvent({
            event: "webview-html",
            payload: { surfaceKey: input.surfaceKey, extensionId: input.extensionId, html },
          });
        }
      },
      options: {},
      cspSource,
      onDidReceiveMessage: incoming.event,
      postMessage: async (message?: unknown) => {
        emitEvent({
          event: "webview-message",
          payload: { surfaceKey: input.surfaceKey, extensionId: input.extensionId, message },
        });
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
  return tracked;
}

function createWebviewPanelObject(input: {
  extensionId: string;
  viewType: string;
  title: string;
  surfaceKey: string;
  announce: boolean;
}) {
  const tracked = createTrackedWebview({
    extensionId: input.extensionId,
    surfaceKey: input.surfaceKey,
    emitHtml: true,
  });
  resolvedWebviews.set(input.surfaceKey, tracked);
  const disposeEmitter = new EventEmitter<void>();
  const viewStateEmitter = new EventEmitter<unknown>();
  let panelTitle = input.title;
  let disposed = false;
  const panel = {
    viewType: input.viewType,
    get title() {
      return panelTitle;
    },
    set title(value: string) {
      panelTitle = String(value ?? "");
      emitEvent({
        event: "webview-html",
        payload: {
          surfaceKey: input.surfaceKey,
          extensionId: input.extensionId,
          html: tracked.getHtml(),
          title: panelTitle,
        },
      });
    },
    iconPath: undefined as unknown,
    webview: tracked.webview,
    options: {},
    viewColumn: 1,
    active: true,
    visible: true,
    reveal: () => {
      emitEvent({
        event: "webview-panel",
        payload: {
          surfaceKey: input.surfaceKey,
          extensionId: input.extensionId,
          viewType: input.viewType,
          title: panelTitle,
          html: tracked.getHtml(),
          active: true,
        },
      });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      resolvedWebviews.delete(input.surfaceKey);
      emitEvent({
        event: "webview-panel-disposed",
        payload: { surfaceKey: input.surfaceKey, extensionId: input.extensionId },
      });
      disposeEmitter.fire();
    },
    onDidDispose: disposeEmitter.event,
    onDidChangeViewState: viewStateEmitter.event,
  };
  if (input.announce) {
    emitEvent({
      event: "webview-panel",
      payload: {
        surfaceKey: input.surfaceKey,
        extensionId: input.extensionId,
        viewType: input.viewType,
        title: panelTitle,
        html: tracked.getHtml(),
        active: true,
      },
    });
  }
  return panel;
}

/* ------------------------------------------------------------------ */
/* Tree views                                                          */
/* ------------------------------------------------------------------ */

type TreeDataProviderLike = {
  getChildren?: (element?: unknown) => unknown;
  getTreeItem?: (element: unknown) => unknown;
  onDidChangeTreeData?: (listener: (event: unknown) => void) => Disposable;
};

type TreeProviderEntry = {
  extensionId: string;
  provider: TreeDataProviderLike;
  handles: Map<string, { element: unknown; command?: { command: string; arguments?: unknown[] } }>;
  handleCounter: number;
  changeSubscription?: Disposable;
  changeTimer?: ReturnType<typeof setTimeout>;
};

const treeDataProviders = new Map<string, TreeProviderEntry>();
const MAX_TREE_HANDLES = 20_000;
const MAX_TREE_CHILDREN = 500;

function registerTreeProvider(
  viewId: string,
  extensionId: string,
  provider: TreeDataProviderLike
): Disposable {
  const existing = treeDataProviders.get(viewId);
  existing?.changeSubscription?.dispose();
  const entry: TreeProviderEntry = {
    extensionId,
    provider,
    handles: new Map(),
    handleCounter: 0,
  };
  if (typeof provider.onDidChangeTreeData === "function") {
    try {
      entry.changeSubscription = provider.onDidChangeTreeData(() => {
        if (entry.changeTimer) return;
        entry.changeTimer = setTimeout(() => {
          entry.changeTimer = undefined;
          if (entry.handles.size > MAX_TREE_HANDLES) {
            entry.handles.clear();
          }
          emitEvent({ event: "tree-changed", payload: { extensionId, viewId } });
        }, 100);
      });
    } catch {
      /* provider may throw when subscribing */
    }
  }
  treeDataProviders.set(viewId, entry);
  return createDisposable(() => {
    entry.changeSubscription?.dispose();
    if (treeDataProviders.get(viewId) === entry) {
      treeDataProviders.delete(viewId);
    }
  });
}

function treeItemLabelText(label: unknown): string {
  if (label && typeof label === "object" && "label" in label) {
    return String((label as { label?: unknown }).label ?? "");
  }
  return String(label ?? "");
}

function serializeTreeIcon(
  iconPath: unknown,
  extensionRoot: string
): { iconId?: string; resourcePath?: string } {
  if (!iconPath) return {};
  if (iconPath instanceof ThemeIcon || (typeof iconPath === "object" && iconPath && "id" in iconPath && !("fsPath" in iconPath) && !("dark" in iconPath))) {
    return { iconId: String((iconPath as { id?: unknown }).id ?? "") || undefined };
  }
  let candidate: unknown = iconPath;
  if (typeof candidate === "object" && candidate && "dark" in candidate) {
    candidate = (candidate as { dark?: unknown }).dark;
  }
  const fsPath = uriToFsPath(candidate);
  if (!fsPath) return {};
  const absolute = path.isAbsolute(fsPath) ? fsPath : path.join(extensionRoot, fsPath);
  const relative = path.relative(path.resolve(extensionRoot), absolute);
  if (relative.startsWith("..")) return {};
  return { resourcePath: relative.replace(/\\/g, "/") };
}

async function getSerializedTreeChildren(input: {
  extensionId: string;
  viewId: string;
  parentHandle?: string;
}): Promise<{ items: SerializedTreeItem[]; missingProvider: boolean }> {
  const entry = treeDataProviders.get(input.viewId);
  if (!entry || entry.extensionId !== input.extensionId) {
    return { items: [], missingProvider: true };
  }
  const parent = input.parentHandle ? entry.handles.get(input.parentHandle)?.element : undefined;
  if (input.parentHandle && typeof parent === "undefined") {
    return { items: [], missingProvider: false };
  }
  const rawChildren = await Promise.resolve(entry.provider.getChildren?.(parent)).catch(() => []);
  const children = Array.isArray(rawChildren) ? rawChildren.slice(0, MAX_TREE_CHILDREN) : [];
  const extensionRoot = extensionRuntimeContexts.get(input.extensionId)?.extensionPath ?? process.cwd();
  const items: SerializedTreeItem[] = [];
  for (const child of children) {
    let treeItem: unknown = child;
    if (typeof entry.provider.getTreeItem === "function") {
      try {
        treeItem = await Promise.resolve(entry.provider.getTreeItem(child));
      } catch {
        treeItem = child;
      }
    }
    const raw = (treeItem ?? {}) as {
      id?: unknown;
      label?: unknown;
      description?: unknown;
      tooltip?: unknown;
      collapsibleState?: unknown;
      iconPath?: unknown;
      contextValue?: unknown;
      resourceUri?: unknown;
      command?: unknown;
      checkboxState?: unknown;
    };
    const handle =
      typeof raw.id === "string" && raw.id.trim()
        ? `id:${raw.id}`
        : `h:${(entry.handleCounter += 1)}`;
    const command =
      raw.command && typeof raw.command === "object" && "command" in raw.command
        ? {
            command: String((raw.command as { command?: unknown }).command ?? ""),
            arguments: Array.isArray((raw.command as { arguments?: unknown }).arguments)
              ? ((raw.command as { arguments?: unknown[] }).arguments as unknown[])
              : undefined,
          }
        : undefined;
    entry.handles.set(handle, { element: child, command });
    const label = treeItemLabelText(raw.label ?? child);
    const rawState = typeof raw.collapsibleState === "number" ? raw.collapsibleState : 0;
    const tooltip =
      typeof raw.tooltip === "string"
        ? raw.tooltip
        : raw.tooltip && typeof raw.tooltip === "object" && "value" in raw.tooltip
          ? String((raw.tooltip as { value?: unknown }).value ?? "")
          : undefined;
    const resourceFsPath = raw.resourceUri ? uriToFsPath(raw.resourceUri) : "";
    items.push({
      handle,
      label: label || (resourceFsPath ? path.basename(resourceFsPath) : "(empty)"),
      description:
        typeof raw.description === "string" && raw.description.trim() ? raw.description : undefined,
      tooltip,
      collapsibleState: rawState === 1 || rawState === 2 ? rawState : 0,
      ...serializeTreeIcon(raw.iconPath, extensionRoot),
      contextValue: typeof raw.contextValue === "string" ? raw.contextValue : undefined,
      hasCommand: Boolean(command?.command),
      checkboxState:
        raw.checkboxState === 1 || raw.checkboxState === 0 ? raw.checkboxState : undefined,
    });
  }
  return { items, missingProvider: false };
}

/* ------------------------------------------------------------------ */
/* UI request bridge (quick pick / input / notifications / progress)   */
/* ------------------------------------------------------------------ */

const UI_REQUEST_TIMEOUT_MS = 10 * 60_000;

type PendingUiRequest = {
  resolve: (response: UiResponsePayload) => void;
  onClientEvent?: (event: UiClientEvent) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pendingUiRequests = new Map<string, PendingUiRequest>();

function sendUiRequest(
  payload: Omit<UiRequestPayload, "requestId" | "createdAt">,
  onClientEvent?: (event: UiClientEvent) => void
): { requestId: string; response: Promise<UiResponsePayload> } {
  const requestId = randomUUID();
  const response = new Promise<UiResponsePayload>((resolve) => {
    const timer = setTimeout(() => {
      pendingUiRequests.delete(requestId);
      emitEvent({ event: "ui-close", payload: { requestId } });
      resolve({ requestId, dismissed: true });
    }, UI_REQUEST_TIMEOUT_MS);
    pendingUiRequests.set(requestId, {
      resolve: (value) => {
        clearTimeout(timer);
        pendingUiRequests.delete(requestId);
        resolve(value);
      },
      onClientEvent,
      timer,
    });
  });
  emitEvent({
    event: "ui-request",
    payload: { ...payload, requestId, createdAt: Date.now() },
  });
  return { requestId, response };
}

function serializeQuickPickItems(items: unknown[]): SerializedQuickPickItem[] {
  return items.slice(0, 500).map((item, index) => {
    if (typeof item === "string") {
      return { index, label: item };
    }
    const raw = (item ?? {}) as {
      label?: unknown;
      description?: unknown;
      detail?: unknown;
      picked?: unknown;
      kind?: unknown;
      title?: unknown;
    };
    return {
      index,
      label: String(raw.label ?? raw.title ?? ""),
      description: typeof raw.description === "string" ? raw.description : undefined,
      detail: typeof raw.detail === "string" ? raw.detail : undefined,
      picked: raw.picked === true ? true : undefined,
      kind: typeof raw.kind === "number" ? raw.kind : undefined,
    };
  });
}

async function showQuickPickImpl(
  extensionId: string,
  itemsOrPromise: unknown,
  options?: {
    canPickMany?: boolean;
    placeHolder?: string;
    title?: string;
    matchOnDescription?: boolean;
    matchOnDetail?: boolean;
  }
): Promise<unknown> {
  const items = Array.isArray(await Promise.resolve(itemsOrPromise))
    ? ((await Promise.resolve(itemsOrPromise)) as unknown[])
    : [];
  if (items.length === 0) return undefined;
  const { response } = sendUiRequest({
    extensionId,
    kind: "quickPick",
    items: serializeQuickPickItems(items),
    canSelectMany: options?.canPickMany === true,
    placeholder: options?.placeHolder,
    title: options?.title,
    matchOnDescription: options?.matchOnDescription,
    matchOnDetail: options?.matchOnDetail,
  });
  const result = await response;
  if (result.dismissed || !result.selectedIndices?.length) return undefined;
  const selected = result.selectedIndices
    .map((index) => items[index])
    .filter((item) => typeof item !== "undefined");
  if (options?.canPickMany === true) return selected;
  return selected[0];
}

async function showInputBoxImpl(
  extensionId: string,
  options?: {
    value?: string;
    prompt?: string;
    placeHolder?: string;
    password?: boolean;
    title?: string;
  }
): Promise<string | undefined> {
  const { response } = sendUiRequest({
    extensionId,
    kind: "inputBox",
    value: options?.value,
    prompt: options?.prompt,
    placeholder: options?.placeHolder,
    password: options?.password === true,
    title: options?.title,
  });
  const result = await response;
  if (result.dismissed) return undefined;
  return typeof result.value === "string" ? result.value : undefined;
}

function notificationItemsToStrings(items: unknown[]): { labels: string[]; originals: unknown[] } {
  const filtered = items.filter(
    (item) => typeof item === "string" || (item && typeof item === "object")
  );
  return {
    labels: filtered.map((item) =>
      typeof item === "string" ? item : String((item as { title?: unknown }).title ?? "")
    ),
    originals: filtered,
  };
}

async function showMessageImpl(
  extensionId: string,
  level: "info" | "warning" | "error",
  message: string,
  rest: unknown[]
): Promise<unknown> {
  let modal = false;
  let detail: string | undefined;
  let items = rest;
  const first = rest[0];
  if (first && typeof first === "object" && !("title" in (first as object)) && "modal" in (first as object)) {
    modal = Boolean((first as { modal?: unknown }).modal);
    detail =
      typeof (first as { detail?: unknown }).detail === "string"
        ? String((first as { detail?: unknown }).detail)
        : undefined;
    items = rest.slice(1);
  }
  const { labels, originals } = notificationItemsToStrings(items);
  if (labels.length === 0) {
    sendUiRequest({
      extensionId,
      kind: "notification",
      level,
      message: String(message ?? ""),
      modal,
      detail,
    });
    return undefined;
  }
  const { response } = sendUiRequest({
    extensionId,
    kind: "notification",
    level,
    message: String(message ?? ""),
    items: labels.map((label, index) => ({ index, label })),
    modal,
    detail,
  });
  const result = await response;
  if (result.dismissed || typeof result.actionIndex !== "number") return undefined;
  return originals[result.actionIndex];
}

function createInteractiveQuickPick(extensionId: string) {
  let items: unknown[] = [];
  let value = "";
  let visible = false;
  let requestId: string | null = null;
  const acceptEmitter = new EventEmitter<void>();
  const hideEmitter = new EventEmitter<void>();
  const valueEmitter = new EventEmitter<string>();
  const selectionEmitter = new EventEmitter<unknown[]>();
  const activeEmitter = new EventEmitter<unknown[]>();
  const buttonEmitter = new EventEmitter<unknown>();
  let updateTimer: ReturnType<typeof setTimeout> | undefined;

  const quickPick = {
    items: [] as unknown[],
    selectedItems: [] as unknown[],
    activeItems: [] as unknown[],
    value: "",
    placeholder: "",
    title: "",
    buttons: [] as unknown[],
    busy: false,
    enabled: true,
    ignoreFocusOut: false,
    canSelectMany: false,
    matchOnDescription: false,
    matchOnDetail: false,
    keepScrollPosition: false,
    step: undefined as number | undefined,
    totalSteps: undefined as number | undefined,
    show: () => {
      visible = true;
      items = Array.isArray(quickPick.items) ? quickPick.items : [];
      value = quickPick.value ?? "";
      const request = sendUiRequest(
        {
          extensionId,
          kind: "quickPick",
          interactive: true,
          items: serializeQuickPickItems(items),
          value,
          placeholder: quickPick.placeholder,
          title: quickPick.title,
          canSelectMany: quickPick.canSelectMany,
          busy: quickPick.busy,
        },
        (clientEvent) => {
          if (clientEvent.type === "valueChanged") {
            quickPick.value = clientEvent.value ?? "";
            valueEmitter.fire(quickPick.value);
          }
          if (clientEvent.type === "accepted") {
            const selected = (clientEvent.selectedIndices ?? [])
              .map((index) => items[index])
              .filter((item) => typeof item !== "undefined");
            quickPick.selectedItems = selected;
            quickPick.activeItems = selected;
            selectionEmitter.fire(selected);
            activeEmitter.fire(selected);
            acceptEmitter.fire();
          }
          if (clientEvent.type === "hidden") {
            visible = false;
            requestId = null;
            hideEmitter.fire();
          }
          if (clientEvent.type === "buttonTriggered" && typeof clientEvent.buttonIndex === "number") {
            buttonEmitter.fire(quickPick.buttons[clientEvent.buttonIndex]);
          }
        }
      );
      requestId = request.requestId;
      void request.response.then(() => {
        if (visible) {
          visible = false;
          hideEmitter.fire();
        }
      });
    },
    hide: () => {
      if (requestId) {
        emitEvent({ event: "ui-close", payload: { requestId } });
        const pending = pendingUiRequests.get(requestId);
        pending?.resolve({ requestId, dismissed: true });
        requestId = null;
      }
      if (visible) {
        visible = false;
        hideEmitter.fire();
      }
    },
    dispose: () => {
      quickPick.hide();
      acceptEmitter.dispose();
      hideEmitter.dispose();
      valueEmitter.dispose();
      selectionEmitter.dispose();
      activeEmitter.dispose();
      buttonEmitter.dispose();
    },
    onDidAccept: acceptEmitter.event,
    onDidHide: hideEmitter.event,
    onDidChangeValue: valueEmitter.event,
    onDidChangeSelection: selectionEmitter.event,
    onDidChangeActive: activeEmitter.event,
    onDidTriggerButton: buttonEmitter.event,
    onDidTriggerItemButton: noopEvent,
  };

  // Reflect post-show item/props updates to the client with a trailing throttle.
  const scheduleUpdate = () => {
    if (!requestId || updateTimer) return;
    updateTimer = setTimeout(() => {
      updateTimer = undefined;
      if (!requestId) return;
      items = Array.isArray(quickPick.items) ? quickPick.items : [];
      emitEvent({
        event: "ui-update",
        payload: {
          requestId,
          patch: {
            items: serializeQuickPickItems(items),
            value: quickPick.value,
            placeholder: quickPick.placeholder,
            title: quickPick.title,
            busy: quickPick.busy,
          },
        },
      });
    }, 30);
  };
  return new Proxy(quickPick, {
    set(target, property, newValue) {
      (target as Record<string | symbol, unknown>)[property] = newValue;
      if (
        property === "items" ||
        property === "value" ||
        property === "placeholder" ||
        property === "title" ||
        property === "busy"
      ) {
        scheduleUpdate();
      }
      return true;
    },
  });
}

function createInteractiveInputBox(extensionId: string) {
  let visible = false;
  let requestId: string | null = null;
  const acceptEmitter = new EventEmitter<void>();
  const hideEmitter = new EventEmitter<void>();
  const valueEmitter = new EventEmitter<string>();
  const inputBox = {
    value: "",
    placeholder: "",
    prompt: "",
    title: "",
    password: false,
    buttons: [] as unknown[],
    busy: false,
    enabled: true,
    ignoreFocusOut: false,
    validationMessage: undefined as string | undefined,
    step: undefined as number | undefined,
    totalSteps: undefined as number | undefined,
    show: () => {
      visible = true;
      const request = sendUiRequest(
        {
          extensionId,
          kind: "inputBox",
          interactive: true,
          value: inputBox.value,
          placeholder: inputBox.placeholder,
          prompt: inputBox.prompt,
          title: inputBox.title,
          password: inputBox.password,
        },
        (clientEvent) => {
          if (clientEvent.type === "valueChanged") {
            inputBox.value = clientEvent.value ?? "";
            valueEmitter.fire(inputBox.value);
          }
          if (clientEvent.type === "accepted") {
            inputBox.value = clientEvent.value ?? inputBox.value;
            acceptEmitter.fire();
          }
          if (clientEvent.type === "hidden") {
            visible = false;
            requestId = null;
            hideEmitter.fire();
          }
        }
      );
      requestId = request.requestId;
    },
    hide: () => {
      if (requestId) {
        emitEvent({ event: "ui-close", payload: { requestId } });
        const pending = pendingUiRequests.get(requestId);
        pending?.resolve({ requestId, dismissed: true });
        requestId = null;
      }
      if (visible) {
        visible = false;
        hideEmitter.fire();
      }
    },
    dispose: () => {
      inputBox.hide();
      acceptEmitter.dispose();
      hideEmitter.dispose();
      valueEmitter.dispose();
    },
    onDidAccept: acceptEmitter.event,
    onDidHide: hideEmitter.event,
    onDidChangeValue: valueEmitter.event,
    onDidTriggerButton: noopEvent,
  };
  return inputBox;
}

async function withProgressImpl(
  extensionId: string,
  options: { location?: number | { viewId?: string }; title?: string; cancellable?: boolean },
  task: (
    progress: { report: (value: { message?: string; increment?: number }) => void },
    token: unknown
  ) => unknown
): Promise<unknown> {
  const requestId = randomUUID();
  const tokenSource = new CancellationTokenSource();
  pendingUiRequests.set(requestId, {
    resolve: () => undefined,
    onClientEvent: (event) => {
      if (event.type === "cancelled") {
        tokenSource.cancel();
      }
    },
    timer: setTimeout(() => undefined, 0),
  });
  const location = typeof options.location === "number" ? options.location : 15;
  emitEvent({
    event: "ui-request",
    payload: {
      requestId,
      extensionId,
      kind: "progress",
      createdAt: Date.now(),
      title: options.title,
      progressLocation: location,
      cancellable: options.cancellable === true,
    },
  });
  let lastEmit = 0;
  let pendingProgress: { message?: string; increment?: number } | null = null;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  const flushProgress = () => {
    if (!pendingProgress) return;
    const payload = pendingProgress;
    pendingProgress = null;
    lastEmit = Date.now();
    emitEvent({
      event: "progress",
      payload: {
        requestId,
        extensionId,
        title: options.title,
        message: payload.message,
        increment: payload.increment,
      },
    });
  };
  const progress = {
    report: (value: { message?: string; increment?: number }) => {
      pendingProgress = {
        message: value?.message ?? pendingProgress?.message,
        increment:
          typeof value?.increment === "number"
            ? (pendingProgress?.increment ?? 0) + value.increment
            : pendingProgress?.increment,
      };
      const elapsed = Date.now() - lastEmit;
      if (elapsed >= 100) {
        flushProgress();
      } else if (!progressTimer) {
        progressTimer = setTimeout(() => {
          progressTimer = undefined;
          flushProgress();
        }, 100 - elapsed);
      }
    },
  };
  try {
    return await Promise.resolve(task(progress, tokenSource.token));
  } finally {
    if (progressTimer) clearTimeout(progressTimer);
    flushProgress();
    const pending = pendingUiRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingUiRequests.delete(requestId);
    }
    emitEvent({
      event: "progress",
      payload: { requestId, extensionId, done: true },
    });
    emitEvent({ event: "ui-close", payload: { requestId } });
    tokenSource.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* Status bar                                                          */
/* ------------------------------------------------------------------ */

let statusBarCounter = 0;
const STATUS_BAR_THROTTLE_MS = 50;

function createStatusBarItemImpl(
  extensionId: string,
  idOrAlignment?: unknown,
  alignmentOrPriority?: unknown,
  maybePriority?: unknown
) {
  let explicitId: string | undefined;
  let alignment: 1 | 2 = 1;
  let priority = 0;
  if (typeof idOrAlignment === "string") {
    explicitId = idOrAlignment;
    alignment = alignmentOrPriority === 2 ? 2 : 1;
    priority = typeof maybePriority === "number" ? maybePriority : 0;
  } else {
    alignment = idOrAlignment === 2 ? 2 : 1;
    priority = typeof alignmentOrPriority === "number" ? alignmentOrPriority : 0;
  }
  statusBarCounter += 1;
  const itemId = `${extensionId}:${explicitId ?? `sb${statusBarCounter}`}`;
  let visible = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const serialize = (): SerializedStatusBarItem => ({
    itemId,
    extensionId,
    alignment,
    priority,
    text: String(item.text ?? ""),
    tooltip:
      typeof item.tooltip === "string"
        ? item.tooltip
        : item.tooltip && typeof item.tooltip === "object" && "value" in (item.tooltip as object)
          ? String((item.tooltip as { value?: unknown }).value ?? "")
          : undefined,
    command:
      typeof item.command === "string"
        ? item.command
        : item.command && typeof item.command === "object" && "command" in (item.command as object)
          ? String((item.command as { command?: unknown }).command ?? "")
          : undefined,
    color:
      item.color instanceof ThemeColor
        ? `theme:${item.color.id}`
        : typeof item.color === "string"
          ? item.color
          : undefined,
    backgroundColor:
      item.backgroundColor instanceof ThemeColor ? `theme:${item.backgroundColor.id}` : undefined,
    visible,
  });

  const push = () => {
    if (disposed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed) return;
      emitEvent({ event: "status-bar", payload: serialize() });
    }, STATUS_BAR_THROTTLE_MS);
  };

  const state = {
    text: "",
    tooltip: undefined as unknown,
    command: undefined as unknown,
    color: undefined as unknown,
    backgroundColor: undefined as unknown,
    name: undefined as string | undefined,
    accessibilityInformation: undefined as unknown,
  };

  const item = new Proxy(
    {
      ...state,
      id: itemId,
      alignment,
      priority,
      show: () => {
        visible = true;
        push();
      },
      hide: () => {
        visible = false;
        push();
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (timer) clearTimeout(timer);
        emitEvent({ event: "status-bar-dispose", payload: { itemId } });
      },
    },
    {
      set(target, property, newValue) {
        (target as Record<string | symbol, unknown>)[property] = newValue;
        if (
          property === "text" ||
          property === "tooltip" ||
          property === "command" ||
          property === "color" ||
          property === "backgroundColor"
        ) {
          if (visible) push();
        }
        return true;
      },
    }
  );
  return item;
}

/* ------------------------------------------------------------------ */
/* Output channels                                                     */
/* ------------------------------------------------------------------ */

const OUTPUT_FLUSH_MS = 25;
const OUTPUT_MAX_CHUNK = 64 * 1024;

function createOutputChannelImpl(extensionId: string, name: string) {
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    if (!buffer) return;
    const data = buffer.slice(0, OUTPUT_MAX_CHUNK);
    buffer = buffer.slice(OUTPUT_MAX_CHUNK);
    emitEvent({ event: "output", payload: { extensionId, channel: name, data } });
    if (buffer) {
      timer = setTimeout(flush, OUTPUT_FLUSH_MS);
    }
  };
  const append = (value: string) => {
    buffer += value;
    if (buffer.length > 4 * OUTPUT_MAX_CHUNK) {
      // Never buffer unbounded output; drop the middle.
      buffer = `${buffer.slice(0, OUTPUT_MAX_CHUNK)}\n[...output truncated...]\n${buffer.slice(-OUTPUT_MAX_CHUNK)}`;
    }
    if (!timer) {
      timer = setTimeout(flush, OUTPUT_FLUSH_MS);
    }
  };
  const line = (prefix: string) => (value: unknown) =>
    append(`${prefix}${typeof value === "string" ? value : JSON.stringify(value)}\n`);
  return {
    name,
    logLevel: 2,
    onDidChangeLogLevel: noopEvent,
    append: (value: string) => append(String(value ?? "")),
    appendLine: (value: string) => append(`${String(value ?? "")}\n`),
    replace: (value: string) => {
      buffer = "";
      append(String(value ?? ""));
    },
    trace: line("[trace] "),
    debug: line("[debug] "),
    info: line("[info] "),
    warn: line("[warn] "),
    error: line("[error] "),
    clear: () => {
      buffer = "";
    },
    show: () => {
      emitEvent({ event: "output-show", payload: { extensionId, channel: name } });
    },
    hide: () => undefined,
    dispose: () => {
      if (timer) clearTimeout(timer);
      flush();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Diagnostics                                                         */
/* ------------------------------------------------------------------ */

function serializeDiagnostics(diagnostics: unknown[]): SerializedDiagnostic[] {
  return diagnostics.slice(0, 1_000).map((diag) => {
    const raw = (diag ?? {}) as {
      range?: unknown;
      message?: unknown;
      severity?: unknown;
      source?: unknown;
      code?: unknown;
    };
    const range = raw.range as { start?: unknown; end?: unknown } | undefined;
    const start = asPosition(range?.start);
    const end = asPosition(range?.end);
    const severity = typeof raw.severity === "number" ? raw.severity : 0;
    return {
      startLine: start.line,
      startColumn: start.character,
      endLine: end.line,
      endColumn: end.character,
      message: String(raw.message ?? ""),
      severity: severity === 1 || severity === 2 || severity === 3 ? severity : 0,
      source: typeof raw.source === "string" ? raw.source : undefined,
      code:
        typeof raw.code === "string" || typeof raw.code === "number"
          ? String(raw.code)
          : raw.code && typeof raw.code === "object" && "value" in raw.code
            ? String((raw.code as { value?: unknown }).value ?? "")
            : undefined,
    };
  });
}

let diagnosticCollectionCounter = 0;

function createDiagnosticCollectionImpl(extensionId: string, name?: string) {
  diagnosticCollectionCounter += 1;
  const collectionName = name?.trim() || `${extensionId}-${diagnosticCollectionCounter}`;
  const stored = new Map<string, unknown[]>();
  const emitFor = (uriKey: string) => {
    emitEvent({
      event: "diagnostics",
      payload: {
        extensionId,
        collection: collectionName,
        uri: uriKey,
        entries: serializeDiagnostics(stored.get(uriKey) ?? []),
      },
    });
  };
  const uriKeyOf = (uri: unknown) => uriToFsPath(uri) || uriToExternalString(uri);
  return {
    name: collectionName,
    set: (uriOrEntries: unknown, diagnostics?: unknown[]) => {
      if (Array.isArray(uriOrEntries)) {
        for (const entry of uriOrEntries) {
          if (!Array.isArray(entry) || entry.length < 2) continue;
          const key = uriKeyOf(entry[0]);
          if (!key) continue;
          stored.set(key, Array.isArray(entry[1]) ? entry[1] : []);
          emitFor(key);
        }
        return;
      }
      const key = uriKeyOf(uriOrEntries);
      if (!key) return;
      if (!diagnostics || diagnostics.length === 0) {
        stored.delete(key);
        emitEvent({
          event: "diagnostics",
          payload: { extensionId, collection: collectionName, uri: key, entries: [] },
        });
        return;
      }
      stored.set(key, diagnostics);
      emitFor(key);
    },
    delete: (uri: unknown) => {
      const key = uriKeyOf(uri);
      if (!key) return;
      stored.delete(key);
      emitEvent({
        event: "diagnostics",
        payload: { extensionId, collection: collectionName, uri: key, entries: [] },
      });
    },
    clear: () => {
      stored.clear();
      emitEvent({ event: "diagnostics-clear", payload: { extensionId, collection: collectionName } });
    },
    forEach: (callback: (uri: unknown, diagnostics: unknown[]) => void) => {
      for (const [key, value] of stored) {
        callback(Uri.file(key), value);
      }
    },
    get: (uri: unknown) => stored.get(uriKeyOf(uri)),
    has: (uri: unknown) => stored.has(uriKeyOf(uri)),
    dispose: () => {
      stored.clear();
      emitEvent({ event: "diagnostics-clear", payload: { extensionId, collection: collectionName } });
    },
  };
}

/* ------------------------------------------------------------------ */
/* Language features                                                   */
/* ------------------------------------------------------------------ */

type LanguageProviderEntry = {
  extensionId: string;
  selector: unknown;
  provider: Record<string, unknown>;
  triggerCharacters?: string[];
};

const languageProviders = {
  hover: [] as LanguageProviderEntry[],
  completion: [] as LanguageProviderEntry[],
  definition: [] as LanguageProviderEntry[],
  formatting: [] as LanguageProviderEntry[],
};

let languageRegistrationTimer: ReturnType<typeof setTimeout> | undefined;

function selectorLanguages(selector: unknown): string[] {
  const collect = (value: unknown): string[] => {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(collect);
    if (value && typeof value === "object") {
      const language = (value as { language?: unknown }).language;
      return typeof language === "string" ? [language] : ["*"];
    }
    return [];
  };
  const languages = collect(selector);
  return languages.length > 0 ? languages : ["*"];
}

function selectorMatches(selector: unknown, languageId: string): boolean {
  const languages = selectorLanguages(selector);
  return languages.includes("*") || languages.includes(languageId);
}

function scheduleLanguageRegistrationsEvent(): void {
  if (languageRegistrationTimer) return;
  languageRegistrationTimer = setTimeout(() => {
    languageRegistrationTimer = undefined;
    const registrations: SerializedLanguageRegistration[] = [];
    for (const [kind, entries] of Object.entries(languageProviders)) {
      for (const entry of entries) {
        registrations.push({
          extensionId: entry.extensionId,
          kind: kind as SerializedLanguageRegistration["kind"],
          languages: selectorLanguages(entry.selector),
          triggerCharacters: entry.triggerCharacters,
        });
      }
    }
    emitEvent({ event: "language-registrations", payload: { registrations } });
  }, 100);
}

function registerLanguageProvider(
  kind: keyof typeof languageProviders,
  entry: LanguageProviderEntry
): Disposable {
  languageProviders[kind].push(entry);
  scheduleLanguageRegistrationsEvent();
  return createDisposable(() => {
    const index = languageProviders[kind].indexOf(entry);
    if (index >= 0) {
      languageProviders[kind].splice(index, 1);
      scheduleLanguageRegistrationsEvent();
    }
  });
}

function markdownToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) {
    return String((value as { value?: unknown }).value ?? "");
  }
  return "";
}

async function provideLanguageFeatureImpl(params: {
  kind: "hover" | "completion" | "definition" | "formatting";
  uri: string;
  languageId: string;
  content?: string;
  position?: { line: number; character: number };
  formattingOptions?: { tabSize?: number; insertSpaces?: boolean };
  triggerCharacter?: string;
}): Promise<unknown> {
  const fsPath = params.uri.replace(/^file:\/\//, "");
  let state = documentStates.get(fsPath);
  if (typeof params.content === "string") {
    if (!state) {
      state = {
        fsPath,
        languageId: params.languageId,
        content: params.content,
        version: 1,
        dirty: false,
        untitled: false,
      };
      documentStates.set(fsPath, state);
    } else {
      state.content = params.content;
    }
  }
  if (!state) {
    try {
      await openTextDocumentByPath(fsPath);
      state = documentStates.get(fsPath);
    } catch {
      return null;
    }
  }
  if (!state) return null;
  const document = getOrCreateDocument(state);
  const position = params.position
    ? new Position(params.position.line, params.position.character)
    : new Position(0, 0);
  const token = new CancellationTokenSource().token;
  const timeout = <T>(promise: Promise<T>): Promise<T | null> =>
    Promise.race([
      promise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);

  if (params.kind === "hover") {
    for (const entry of languageProviders.hover) {
      if (!selectorMatches(entry.selector, state.languageId)) continue;
      const provider = entry.provider as {
        provideHover?: (doc: unknown, pos: unknown, tok: unknown) => unknown;
      };
      try {
        const hover = await timeout(Promise.resolve(provider.provideHover?.(document, position, token)));
        if (!hover) continue;
        const contents = (hover as { contents?: unknown }).contents;
        const list = Array.isArray(contents) ? contents : [contents];
        const rendered = list.map(markdownToString).filter(Boolean);
        if (rendered.length > 0) {
          return { contents: rendered };
        }
      } catch {
        /* provider errors must not break the bridge */
      }
    }
    return null;
  }

  if (params.kind === "completion") {
    for (const entry of languageProviders.completion) {
      if (!selectorMatches(entry.selector, state.languageId)) continue;
      const provider = entry.provider as {
        provideCompletionItems?: (doc: unknown, pos: unknown, tok: unknown, ctx: unknown) => unknown;
      };
      try {
        const result = await timeout(
          Promise.resolve(
            provider.provideCompletionItems?.(document, position, token, {
              triggerKind: params.triggerCharacter ? 1 : 0,
              triggerCharacter: params.triggerCharacter,
            })
          )
        );
        if (!result) continue;
        const items = Array.isArray(result)
          ? result
          : Array.isArray((result as { items?: unknown }).items)
            ? ((result as { items: unknown[] }).items)
            : [];
        if (items.length === 0) continue;
        return {
          items: items.slice(0, 200).map((item) => {
            const raw = (item ?? {}) as {
              label?: unknown;
              kind?: unknown;
              detail?: unknown;
              documentation?: unknown;
              insertText?: unknown;
              filterText?: unknown;
              sortText?: unknown;
              preselect?: unknown;
            };
            const label =
              raw.label && typeof raw.label === "object" && "label" in raw.label
                ? String((raw.label as { label?: unknown }).label ?? "")
                : String(raw.label ?? "");
            const insertRaw = raw.insertText;
            const isSnippet = Boolean(
              insertRaw && typeof insertRaw === "object" && "value" in insertRaw
            );
            return {
              label,
              kind: typeof raw.kind === "number" ? raw.kind : 0,
              detail: typeof raw.detail === "string" ? raw.detail : undefined,
              documentation: markdownToString(raw.documentation) || undefined,
              insertText: isSnippet
                ? String((insertRaw as { value?: unknown }).value ?? label)
                : typeof insertRaw === "string"
                  ? insertRaw
                  : label,
              isSnippet,
              filterText: typeof raw.filterText === "string" ? raw.filterText : undefined,
              sortText: typeof raw.sortText === "string" ? raw.sortText : undefined,
              preselect: raw.preselect === true,
            };
          }),
        };
      } catch {
        /* next provider */
      }
    }
    return null;
  }

  if (params.kind === "definition") {
    for (const entry of languageProviders.definition) {
      if (!selectorMatches(entry.selector, state.languageId)) continue;
      const provider = entry.provider as {
        provideDefinition?: (doc: unknown, pos: unknown, tok: unknown) => unknown;
      };
      try {
        const result = await timeout(
          Promise.resolve(provider.provideDefinition?.(document, position, token))
        );
        if (!result) continue;
        const list = Array.isArray(result) ? result : [result];
        const locations = list
          .map((location) => {
            const raw = (location ?? {}) as {
              uri?: unknown;
              range?: unknown;
              targetUri?: unknown;
              targetRange?: unknown;
            };
            const uri = raw.targetUri ?? raw.uri;
            const range = (raw.targetRange ?? raw.range) as
              | { start?: unknown; end?: unknown }
              | undefined;
            const fsTarget = uriToFsPath(uri);
            if (!fsTarget) return null;
            const start = asPosition(range?.start);
            const end = asPosition(range?.end);
            return {
              path: fsTarget,
              startLine: start.line,
              startColumn: start.character,
              endLine: end.line,
              endColumn: end.character,
            };
          })
          .filter((location) => location !== null);
        if (locations.length > 0) return { locations };
      } catch {
        /* next provider */
      }
    }
    return null;
  }

  if (params.kind === "formatting") {
    for (const entry of languageProviders.formatting) {
      if (!selectorMatches(entry.selector, state.languageId)) continue;
      const provider = entry.provider as {
        provideDocumentFormattingEdits?: (doc: unknown, opts: unknown, tok: unknown) => unknown;
      };
      try {
        const result = await timeout(
          Promise.resolve(
            provider.provideDocumentFormattingEdits?.(
              document,
              {
                tabSize: params.formattingOptions?.tabSize ?? 2,
                insertSpaces: params.formattingOptions?.insertSpaces ?? true,
              },
              token
            )
          )
        );
        if (!Array.isArray(result) || result.length === 0) continue;
        const edits: SerializedTextEdit[] = result
          .map((edit) => {
            const raw = (edit ?? {}) as { range?: unknown; newText?: unknown };
            const serialized = serializeRange(raw.range);
            if (!serialized) return null;
            return { ...serialized, newText: String(raw.newText ?? "") };
          })
          .filter((edit): edit is SerializedTextEdit => edit !== null);
        if (edits.length > 0) return { edits };
      } catch {
        /* next provider */
      }
    }
    return null;
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* File search + watching                                              */
/* ------------------------------------------------------------------ */

function translateGlobPart(glob: string): string {
  let out = "";
  let index = 0;
  while (index < glob.length) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        if (glob[index + 2] === "/") {
          out += "(?:[^/]*/)*";
          index += 3;
        } else {
          out += ".*";
          index += 2;
        }
      } else {
        out += "[^/]*";
        index += 1;
      }
    } else if (char === "?") {
      out += "[^/]";
      index += 1;
    } else if (char === "{") {
      const end = glob.indexOf("}", index);
      if (end < 0) {
        out += "\\{";
        index += 1;
      } else {
        const parts = glob.slice(index + 1, end).split(",");
        out += `(?:${parts.map(translateGlobPart).join("|")})`;
        index = end + 1;
      }
    } else if (char === "[") {
      const end = glob.indexOf("]", index);
      if (end < 0) {
        out += "\\[";
        index += 1;
      } else {
        out += glob.slice(index, end + 1);
        index = end + 1;
      }
    } else {
      out += char.replace(/[.+^$()|\\]/g, "\\$&");
      index += 1;
    }
  }
  return out;
}

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${translateGlobPart(glob.replace(/\\/g, "/"))}$`);
}

function patternInput(pattern: unknown): { base: string; glob: string } {
  if (pattern instanceof RelativePattern || (pattern && typeof pattern === "object" && "pattern" in pattern)) {
    const raw = pattern as { base?: unknown; pattern?: unknown; baseUri?: unknown };
    return {
      base: String(raw.base ?? uriToFsPath(raw.baseUri) ?? workspaceRoot) || workspaceRoot,
      glob: String(raw.pattern ?? "**/*"),
    };
  }
  return { base: workspaceRoot, glob: String(pattern ?? "**/*") };
}

const FIND_FILES_MAX_DIRS = 20_000;

async function findFilesImpl(
  include: unknown,
  exclude?: unknown,
  maxResults?: number
): Promise<UriLike[]> {
  const { base, glob } = patternInput(include);
  const includeRegex = globToRegExp(glob);
  const excludeRegex =
    exclude === null
      ? null
      : exclude
        ? globToRegExp(patternInput(exclude).glob)
        : null;
  const includeNodeModules = glob.includes("node_modules");
  const cap = Math.max(1, Math.min(maxResults ?? 2_000, 20_000));
  const results: UriLike[] = [];
  const stack: string[] = [""];
  let visitedDirs = 0;
  while (stack.length > 0 && results.length < cap && visitedDirs < FIND_FILES_MAX_DIRS) {
    const rel = stack.pop()!;
    visitedDirs += 1;
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await fs.readdir(path.join(base, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".hg") continue;
      if (!includeNodeModules && entry.name === "node_modules") continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (excludeRegex?.test(relPath)) continue;
      if (entry.isDirectory()) {
        stack.push(relPath);
      } else if (entry.isFile() && includeRegex.test(relPath)) {
        results.push(Uri.file(path.join(base, relPath)));
        if (results.length >= cap) break;
      }
    }
  }
  return results;
}

type WatcherSubscription = {
  base: string;
  regex: RegExp;
  onCreate: EventEmitter<unknown>;
  onChange: EventEmitter<unknown>;
  onDelete: EventEmitter<unknown>;
};

const watcherSubscriptions = new Set<WatcherSubscription>();
let sharedWatcher: { close: () => Promise<void> } | null = null;

function ensureSharedWatcher(): void {
  if (sharedWatcher) return;
  try {
    const requireFn = createRequire(import.meta.url);
    const chokidar = requireFn("chokidar") as {
      watch: (
        target: string,
        options: Record<string, unknown>
      ) => {
        on: (event: string, listener: (target: string) => void) => unknown;
        close: () => Promise<void>;
      };
    };
    const watcher = chokidar.watch(workspaceRoot, {
      ignored: (watchedPath: string) => {
        const rel = path.relative(workspaceRoot, watchedPath);
        return rel.split(path.sep).some((part) => part === "node_modules" || part === ".git");
      },
      ignoreInitial: true,
      persistent: true,
    });
    const dispatch = (kind: "create" | "change" | "delete") => (absolute: string) => {
      const rel = path.relative(workspaceRoot, absolute).replace(/\\/g, "/");
      for (const subscription of watcherSubscriptions) {
        const subjectRel =
          subscription.base === workspaceRoot
            ? rel
            : path.relative(subscription.base, absolute).replace(/\\/g, "/");
        if (subjectRel.startsWith("..")) continue;
        if (!subscription.regex.test(subjectRel)) continue;
        const uri = Uri.file(absolute);
        if (kind === "create") subscription.onCreate.fire(uri);
        else if (kind === "change") subscription.onChange.fire(uri);
        else subscription.onDelete.fire(uri);
      }
    };
    watcher.on("add", dispatch("create"));
    watcher.on("change", dispatch("change"));
    watcher.on("unlink", dispatch("delete"));
    watcher.on("addDir", dispatch("create"));
    watcher.on("unlinkDir", dispatch("delete"));
    sharedWatcher = watcher;
  } catch (error) {
    process.stderr.write(
      `[extensions] file watching unavailable: ${error instanceof Error ? error.message : String(error)}\n`
    );
    sharedWatcher = { close: async () => undefined };
  }
}

function createFileSystemWatcherImpl(pattern: unknown) {
  ensureSharedWatcher();
  const { base, glob } = patternInput(pattern);
  const subscription: WatcherSubscription = {
    base,
    regex: globToRegExp(glob),
    onCreate: new EventEmitter(),
    onChange: new EventEmitter(),
    onDelete: new EventEmitter(),
  };
  watcherSubscriptions.add(subscription);
  return {
    ignoreCreateEvents: false,
    ignoreChangeEvents: false,
    ignoreDeleteEvents: false,
    onDidCreate: subscription.onCreate.event,
    onDidChange: subscription.onChange.event,
    onDidDelete: subscription.onDelete.event,
    dispose: () => {
      watcherSubscriptions.delete(subscription);
      subscription.onCreate.dispose();
      subscription.onChange.dispose();
      subscription.onDelete.dispose();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Misc helpers                                                        */
/* ------------------------------------------------------------------ */

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

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

function resolveExtensionEntry(
  requireFn: ReturnType<typeof createRequire>,
  primaryEntry: string,
  fallbackEntry: string
): string {
  for (const candidate of [primaryEntry, fallbackEntry]) {
    try {
      return requireFn.resolve(candidate);
    } catch {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return primaryEntry;
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

const authenticationProviders = new Map<
  string,
  { extensionId: string; provider: Record<string, unknown>; options?: unknown }
>();
const authSessionsEmitter = new EventEmitter<unknown>();

/* ------------------------------------------------------------------ */
/* vscode shim                                                         */
/* ------------------------------------------------------------------ */

function createVscodeShim(extensionId: string) {
  const runtimeContext = extensionRuntimeContexts.get(extensionId);
  const extensionRoot = runtimeContext?.extensionPath ?? process.cwd();
  const workspaceFolder = {
    uri: Uri.file(workspaceRoot),
    name: path.basename(workspaceRoot),
    index: 0,
  };
  const shim = {
    version: "1.100.0",
    Disposable: VscodeDisposable,
    EventEmitter,
    Event: {
      None: noopEvent,
    },
    CancellationTokenSource,
    CancellationError: class CancellationError extends Error {
      constructor() {
        super("Canceled");
        this.name = "Canceled";
      }
    },
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
    Hover,
    MarkdownString,
    SnippetString,
    WorkspaceEdit: class WorkspaceEdit {
      readonly textEdits = new Map<string, SerializedTextEdit[]>();
      readonly fileOps: Array<
        | { kind: "create"; path: string }
        | { kind: "delete"; path: string }
        | { kind: "rename"; from: string; to: string }
      > = [];

      private editsFor(uri: unknown): SerializedTextEdit[] {
        const key = uriToFsPath(uri);
        let list = this.textEdits.get(key);
        if (!list) {
          list = [];
          this.textEdits.set(key, list);
        }
        return list;
      }

      replace(uri: unknown, range: unknown, newText: string): void {
        const serialized = serializeRange(range);
        if (serialized) this.editsFor(uri).push({ ...serialized, newText: String(newText ?? "") });
      }

      insert(uri: unknown, position: unknown, newText: string): void {
        const pos = asPosition(position);
        this.editsFor(uri).push({
          startLine: pos.line,
          startColumn: pos.character,
          endLine: pos.line,
          endColumn: pos.character,
          newText: String(newText ?? ""),
        });
      }

      delete(uri: unknown, range: unknown): void {
        const serialized = serializeRange(range);
        if (serialized) this.editsFor(uri).push(serialized);
      }

      set(uri: unknown, edits: unknown[]): void {
        const list = this.editsFor(uri);
        list.length = 0;
        for (const edit of Array.isArray(edits) ? edits : []) {
          const raw = (edit ?? {}) as { range?: unknown; newText?: unknown };
          const serialized = serializeRange(raw.range);
          if (serialized) list.push({ ...serialized, newText: String(raw.newText ?? "") });
        }
      }

      createFile(uri: unknown): void {
        this.fileOps.push({ kind: "create", path: uriToFsPath(uri) });
      }

      deleteFile(uri: unknown): void {
        this.fileOps.push({ kind: "delete", path: uriToFsPath(uri) });
      }

      renameFile(oldUri: unknown, newUri: unknown): void {
        this.fileOps.push({ kind: "rename", from: uriToFsPath(oldUri), to: uriToFsPath(newUri) });
      }

      get size(): number {
        return this.textEdits.size + this.fileOps.length;
      }

      entries(): unknown[] {
        return [...this.textEdits.entries()].map(([key, edits]) => [Uri.file(key), edits]);
      }
    },
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
    FileDecoration,
    LanguageModelChatMessage,
    QuickInputButtons: {
      Back: { iconPath: new ThemeIcon("arrow-left"), tooltip: "Back" },
    },
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
      Color: 15,
      File: 16,
      Reference: 17,
      Folder: 18,
      EnumMember: 19,
      Constant: 20,
      Struct: 21,
      Event: 22,
      Operator: 23,
      TypeParameter: 24,
      User: 25,
      Issue: 26,
    },
    CompletionTriggerKind: {
      Invoke: 0,
      TriggerCharacter: 1,
      TriggerForIncompleteCompletions: 2,
    },
    InlineCompletionTriggerKind: {
      Invoke: 0,
      Automatic: 1,
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
    TreeItemCheckboxState: {
      Unchecked: 0,
      Checked: 1,
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
    FileChangeType: {
      Changed: 1,
      Created: 2,
      Deleted: 3,
    },
    StatusBarAlignment: {
      Left: 1,
      Right: 2,
    },
    LogLevel: {
      Off: 0,
      Trace: 1,
      Debug: 2,
      Info: 3,
      Warning: 4,
      Error: 5,
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
    TextEditorRevealType: {
      Default: 0,
      InCenter: 1,
      InCenterIfOutsideViewport: 2,
      AtTop: 3,
    },
    TextEditorSelectionChangeKind: {
      Keyboard: 1,
      Mouse: 2,
      Command: 3,
    },
    TextDocumentSaveReason: {
      Manual: 1,
      AfterDelay: 2,
      FocusOut: 3,
    },
    TextEditorCursorStyle: {
      Line: 1,
      Block: 2,
      Underline: 3,
      LineThin: 4,
      BlockOutline: 5,
      UnderlineThin: 6,
    },
    TextEditorLineNumbersStyle: {
      Off: 0,
      On: 1,
      Relative: 2,
    },
    EndOfLine: {
      LF: 1,
      CRLF: 2,
    },
    QuickPickItemKind: {
      Separator: -1,
      Default: 0,
    },
    InputBoxValidationSeverity: {
      Info: 1,
      Warning: 2,
      Error: 3,
    },
    ViewColumn: {
      Active: -1,
      Beside: -2,
      One: 1,
      Two: 2,
      Three: 3,
      Four: 4,
      Five: 5,
    },
    TerminalLocation: {
      Panel: 1,
      Editor: 2,
    },
    EnvironmentVariableMutatorType: {
      Replace: 1,
      Append: 2,
      Prepend: 3,
    },
    CodeActionTriggerKind: {
      Invoke: 1,
      Automatic: 2,
    },
    LanguageStatusSeverity: {
      Information: 0,
      Warning: 1,
      Error: 2,
    },
    NotebookCellKind: {
      Markup: 1,
      Code: 2,
    },
    CodeActionKind: {
      Empty: createCodeActionKind(""),
      QuickFix: createCodeActionKind("quickfix"),
      Refactor: createCodeActionKind("refactor"),
      RefactorExtract: createCodeActionKind("refactor.extract"),
      RefactorInline: createCodeActionKind("refactor.inline"),
      RefactorMove: createCodeActionKind("refactor.move"),
      RefactorRewrite: createCodeActionKind("refactor.rewrite"),
      Source: createCodeActionKind("source"),
      SourceOrganizeImports: createCodeActionKind("source.organizeImports"),
      SourceFixAll: createCodeActionKind("source.fixAll"),
      Notebook: createCodeActionKind("notebook"),
    },
    Uri,
    commands: {
      registerCommand: (command: string, callback: (...args: unknown[]) => unknown, thisArg?: unknown) => {
        commands.set(command, thisArg ? callback.bind(thisArg) : callback);
        return createDisposable(() => commands.delete(command));
      },
      registerTextEditorCommand: (
        command: string,
        callback: (editor: unknown, edit: unknown, ...args: unknown[]) => unknown,
        thisArg?: unknown
      ) => {
        const bound = thisArg ? callback.bind(thisArg) : callback;
        commands.set(command, (...args: unknown[]) => {
          const editor = getActiveEditor(extensionId);
          if (!editor) return undefined;
          let result: unknown;
          void editor.edit((builder) => {
            result = bound(editor, builder, ...args);
          });
          return result;
        });
        return createDisposable(() => commands.delete(command));
      },
      executeCommand: async (command: string, ...args: unknown[]) => {
        if (command === "setContext") {
          const key = String(args[0] ?? "");
          if (key) {
            contextKeys.set(key, args[1]);
            emitEvent({ event: "context", payload: { key, value: args[1] } });
          }
          return undefined;
        }
        if (command === "vscode.open" || command === "vscode.openFolder") {
          const target = args[0];
          const url = uriToExternalString(target);
          if (/^https?:/i.test(url)) {
            emitEvent({ event: "external-url", payload: { extensionId, url } });
          } else {
            const fsPath = uriToFsPath(target);
            if (fsPath) {
              emitEvent({ event: "open-document", payload: { extensionId, path: fsPath } });
            }
          }
          return undefined;
        }
        const handler = commands.get(command);
        if (!handler) {
          if (
            command.startsWith("workbench.") ||
            command.startsWith("vscode.") ||
            command.startsWith("editor.") ||
            command.startsWith("markdown.") ||
            command.startsWith("cursor.") ||
            command.startsWith("_")
          ) {
            return undefined;
          }
          throw new Error(`Command not found: ${command}`);
        }
        return await handler(...args);
      },
      getCommands: async (filterInternal?: boolean) => {
        const all = [...commands.keys(), "setContext", "vscode.open"];
        return filterInternal ? all.filter((command) => !command.startsWith("_")) : all;
      },
    },
    window: {
      get activeTextEditor() {
        return getActiveEditor(extensionId);
      },
      get visibleTextEditors() {
        const editor = getActiveEditor(extensionId);
        return editor ? [editor] : [];
      },
      get activeColorTheme() {
        return { kind: activeColorThemeKind };
      },
      state: { focused: true, active: true },
      onDidChangeWindowState: noopEvent,
      tabGroups: {
        get all() {
          const editor = getActiveEditor(extensionId);
          const tabs = editor
            ? [
                {
                  label: path.basename(editor.document.fileName),
                  input: { uri: editor.document.uri },
                  isActive: true,
                  isDirty: editor.document.isDirty,
                  isPinned: false,
                  isPreview: false,
                  group: undefined as unknown,
                },
              ]
            : [];
          const group = {
            isActive: true,
            viewColumn: 1,
            activeTab: tabs[0],
            tabs,
          };
          if (tabs[0]) tabs[0].group = group;
          return [group];
        },
        get activeTabGroup() {
          return (this as { all: unknown[] }).all[0];
        },
        onDidChangeTabs: noopEvent,
        onDidChangeTabGroups: noopEvent,
        close: async () => true,
      },
      onDidChangeActiveTextEditor: onDidChangeActiveTextEditorEmitter.event,
      onDidChangeVisibleTextEditors: onDidChangeVisibleTextEditorsEmitter.event,
      onDidChangeTextEditorSelection: onDidChangeTextEditorSelectionEmitter.event,
      onDidChangeTextEditorVisibleRanges: noopEvent,
      onDidChangeTextEditorOptions: noopEvent,
      onDidChangeTextEditorViewColumn: noopEvent,
      onDidChangeActiveNotebookEditor: noopEvent,
      onDidChangeVisibleNotebookEditors: noopEvent,
      onDidChangeActiveColorTheme: activeColorThemeEmitter.event,
      showInformationMessage: (message: string, ...rest: unknown[]) =>
        showMessageImpl(extensionId, "info", message, rest),
      showWarningMessage: (message: string, ...rest: unknown[]) =>
        showMessageImpl(extensionId, "warning", message, rest),
      showErrorMessage: (message: string, ...rest: unknown[]) =>
        showMessageImpl(extensionId, "error", message, rest),
      showQuickPick: (items: unknown, options?: Record<string, unknown>) =>
        showQuickPickImpl(extensionId, items, options as Parameters<typeof showQuickPickImpl>[2]),
      showInputBox: (options?: Record<string, unknown>) =>
        showInputBoxImpl(extensionId, options as Parameters<typeof showInputBoxImpl>[1]),
      showWorkspaceFolderPick: async () => workspaceFolder,
      createQuickPick: () => createInteractiveQuickPick(extensionId),
      createInputBox: () => createInteractiveInputBox(extensionId),
      showOpenDialog: async (options?: {
        canSelectMany?: boolean;
        canSelectFolders?: boolean;
        title?: string;
        defaultUri?: unknown;
      }) => {
        const { response } = sendUiRequest({
          extensionId,
          kind: "openDialog",
          title: options?.title,
          canSelectMany: options?.canSelectMany === true,
          value: uriToFsPath(options?.defaultUri) || workspaceRoot,
        });
        const result = await response;
        if (result.dismissed || !result.paths?.length) return undefined;
        return result.paths.map((fsPath) => Uri.file(fsPath));
      },
      showSaveDialog: async (options?: { title?: string; defaultUri?: unknown }) => {
        const { response } = sendUiRequest({
          extensionId,
          kind: "saveDialog",
          title: options?.title,
          value: uriToFsPath(options?.defaultUri) || workspaceRoot,
        });
        const result = await response;
        if (result.dismissed || !result.paths?.length) return undefined;
        return Uri.file(result.paths[0]!);
      },
      withProgress: (options: Record<string, unknown>, task: Parameters<typeof withProgressImpl>[2]) =>
        withProgressImpl(extensionId, options as Parameters<typeof withProgressImpl>[1], task),
      showTextDocument: async (docOrUri: unknown, columnOrOptions?: unknown) => {
        const fsPath =
          docOrUri && typeof docOrUri === "object" && "uri" in docOrUri
            ? uriToFsPath((docOrUri as { uri?: unknown }).uri)
            : uriToFsPath(docOrUri);
        if (!fsPath) return getActiveEditor(extensionId);
        const options = (typeof columnOrOptions === "object" ? columnOrOptions : undefined) as
          | { preview?: boolean; selection?: { start?: Position; end?: Position } }
          | undefined;
        let selection: EditorSelectionShape | undefined;
        if (options?.selection) {
          const start = asPosition(options.selection.start);
          const end = asPosition(options.selection.end ?? options.selection.start);
          selection = {
            startLineNumber: start.line + 1,
            startColumn: start.character + 1,
            endLineNumber: end.line + 1,
            endColumn: end.character + 1,
          };
        }
        emitEvent({
          event: "open-document",
          payload: {
            extensionId,
            path: fsPath,
            preview: options?.preview,
            selection,
          },
        });
        let state = documentStates.get(fsPath);
        if (!state) {
          try {
            await openTextDocumentByPath(fsPath);
            state = documentStates.get(fsPath);
          } catch {
            /* stays undefined */
          }
        }
        if (state) {
          activeDocumentPath = state.fsPath;
          return getOrCreateEditor(state, extensionId);
        }
        return undefined;
      },
      createTextEditorDecorationType: () => ({
        key: `opencursor-decoration-${Math.random().toString(36).slice(2)}`,
        dispose: () => undefined,
      }),
      registerUriHandler: () => createDisposable(),
      registerTerminalProfileProvider: () => createDisposable(),
      registerFileDecorationProvider: () => createDisposable(),
      registerTerminalLinkProvider: () => createDisposable(),
      createTerminal: (options?: { name?: string } | string) => ({
        name: typeof options === "string" ? options : (options?.name ?? "Extension Terminal"),
        processId: Promise.resolve(undefined),
        creationOptions: options,
        exitStatus: undefined,
        state: { isInteractedWith: false },
        shellIntegration: undefined,
        sendText: () => undefined,
        show: () => undefined,
        hide: () => undefined,
        dispose: () => undefined,
      }),
      terminals: [] as unknown[],
      activeTerminal: undefined,
      onDidOpenTerminal: noopEvent,
      onDidCloseTerminal: noopEvent,
      onDidChangeActiveTerminal: noopEvent,
      onDidChangeTerminalState: noopEvent,
      onDidChangeTerminalShellIntegration: noopEvent,
      onDidStartTerminalShellExecution: noopEvent,
      onDidEndTerminalShellExecution: noopEvent,
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
      registerWebviewPanelSerializer: (
        viewType: string,
        serializer: { deserializeWebviewPanel?: (panel: unknown, state: unknown) => unknown }
      ) => {
        webviewPanelSerializers.set(viewType, { extensionId, serializer });
        return createDisposable(() => webviewPanelSerializers.delete(viewType));
      },
      registerTreeDataProvider: (viewId: string, provider: TreeDataProviderLike) =>
        registerTreeProvider(viewId, extensionId, provider),
      createTreeView: (
        viewId: string,
        options?: { treeDataProvider?: TreeDataProviderLike }
      ) => {
        let registration: Disposable | undefined;
        if (options?.treeDataProvider) {
          registration = registerTreeProvider(viewId, extensionId, options.treeDataProvider);
        }
        return {
          title: "",
          description: "",
          message: "",
          badge: undefined,
          selection: [] as unknown[],
          visible: true,
          reveal: async () => undefined,
          onDidChangeSelection: noopEvent,
          onDidChangeVisibility: noopEvent,
          onDidCollapseElement: noopEvent,
          onDidExpandElement: noopEvent,
          onDidChangeCheckboxState: noopEvent,
          dispose: () => registration?.dispose(),
        };
      },
      createWebviewPanel: (viewType: string, title: string) =>
        createWebviewPanelObject({
          extensionId,
          viewType: String(viewType ?? "webview"),
          title: String(title ?? viewType ?? "Webview"),
          surfaceKey: `extpanel-${randomUUID().slice(0, 18)}`,
          announce: true,
        }),
      createOutputChannel: (name: string) => createOutputChannelImpl(extensionId, String(name ?? "Output")),
      createStatusBarItem: (idOrAlignment?: unknown, alignmentOrPriority?: unknown, priority?: unknown) =>
        createStatusBarItemImpl(extensionId, idOrAlignment, alignmentOrPriority, priority),
      setStatusBarMessage: (text: string, timeoutOrThenable?: unknown) => {
        const item = createStatusBarItemImpl(extensionId, 1, -10_000);
        item.text = String(text ?? "");
        item.show();
        if (typeof timeoutOrThenable === "number") {
          setTimeout(() => item.dispose(), timeoutOrThenable);
        } else if (
          timeoutOrThenable &&
          typeof (timeoutOrThenable as { then?: unknown }).then === "function"
        ) {
          void (timeoutOrThenable as Promise<unknown>).then(
            () => item.dispose(),
            () => item.dispose()
          );
        } else {
          setTimeout(() => item.dispose(), 10_000);
        }
        return createDisposable(() => item.dispose());
      },
      showNotebookDocument: async () => undefined,
      activeNotebookEditor: undefined,
      visibleNotebookEditors: [] as unknown[],
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
    },
    workspace: {
      isTrusted: true,
      requestWorkspaceTrust: async () => true,
      onDidGrantWorkspaceTrust: noopEvent,
      workspaceFolders: [workspaceFolder],
      workspaceFile: undefined,
      name: path.basename(workspaceRoot),
      rootPath: workspaceRoot,
      getWorkspaceFolder: (uri: unknown) => {
        const fsPath = uriToFsPath(uri);
        if (!fsPath) return undefined;
        const resolved = path.resolve(fsPath);
        return resolved === workspaceRoot || resolved.startsWith(`${workspaceRoot}${path.sep}`)
          ? workspaceFolder
          : undefined;
      },
      asRelativePath: (value: unknown, includeWorkspaceFolder?: boolean) => {
        const fsPath = uriToFsPath(value);
        if (!fsPath) return String(value ?? "");
        const relative = path.relative(workspaceRoot, fsPath);
        if (relative.startsWith("..")) return fsPath;
        return includeWorkspaceFolder ? path.join(workspaceFolder.name, relative) : relative;
      },
      findFiles: (include: unknown, exclude?: unknown, maxResults?: number) =>
        findFilesImpl(include, exclude, maxResults),
      openTextDocument: async (uriOrOptions: unknown) => {
        if (typeof uriOrOptions === "string" || (uriOrOptions && typeof uriOrOptions === "object" && "fsPath" in uriOrOptions)) {
          const fsPath = uriToFsPath(uriOrOptions);
          if (fsPath) {
            return await openTextDocumentByPath(path.isAbsolute(fsPath) ? fsPath : path.join(workspaceRoot, fsPath));
          }
        }
        const options = (uriOrOptions ?? {}) as { content?: unknown; language?: unknown };
        untitledCounter += 1;
        const state: DocumentState = {
          fsPath: `Untitled-${untitledCounter}`,
          languageId: typeof options.language === "string" ? options.language : "plaintext",
          content: typeof options.content === "string" ? options.content : "",
          version: 1,
          dirty: typeof options.content === "string" && options.content.length > 0,
          untitled: true,
        };
        documentStates.set(state.fsPath, state);
        const doc = getOrCreateDocument(state);
        onDidOpenTextDocumentEmitter.fire(doc);
        return doc;
      },
      applyEdit: async (edit: {
        textEdits?: Map<string, SerializedTextEdit[]>;
        fileOps?: Array<
          | { kind: "create"; path: string }
          | { kind: "delete"; path: string }
          | { kind: "rename"; from: string; to: string }
        >;
      }) => {
        try {
          for (const op of edit.fileOps ?? []) {
            if (op.kind === "create") {
              await fs.mkdir(path.dirname(op.path), { recursive: true });
              await fs.writeFile(op.path, "", { flag: "a" });
            } else if (op.kind === "delete") {
              await fs.rm(op.path, { recursive: true, force: true });
            } else {
              await fs.mkdir(path.dirname(op.to), { recursive: true });
              await fs.rename(op.from, op.to);
            }
          }
          for (const [fsPath, edits] of edit.textEdits ?? new Map()) {
            if (edits.length === 0) continue;
            const state = documentStates.get(fsPath);
            if (state) {
              state.content = applyTextEditsToContent(state.content, edits);
              state.version += 1;
              state.dirty = true;
            } else {
              try {
                const content = await fs.readFile(fsPath, "utf8");
                await fs.writeFile(fsPath, applyTextEditsToContent(content, edits), "utf8");
              } catch {
                continue;
              }
            }
            emitEvent({ event: "editor-edit", payload: { extensionId, path: fsPath, edits } });
          }
          return true;
        } catch {
          return false;
        }
      },
      saveAll: async () => {
        let allSaved = true;
        for (const state of documentStates.values()) {
          if (!state.dirty || state.untitled) continue;
          try {
            await fs.writeFile(state.fsPath, state.content, "utf8");
            state.dirty = false;
            onDidSaveTextDocumentEmitter.fire(getOrCreateDocument(state));
          } catch {
            allSaved = false;
          }
        }
        return allSaved;
      },
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
        readFile: async (uri: unknown) => new Uint8Array(await fs.readFile(uriToFsPath(uri))),
        writeFile: async (uri: unknown, content: Uint8Array) => {
          const target = uriToFsPath(uri);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, content);
        },
        delete: async (uri: unknown, options?: { recursive?: boolean }) =>
          await fs.rm(uriToFsPath(uri), { recursive: options?.recursive !== false, force: true }),
        rename: async (source: unknown, target: unknown, options?: { overwrite?: boolean }) => {
          const from = uriToFsPath(source);
          const to = uriToFsPath(target);
          if (options?.overwrite === false && existsSync(to)) {
            throw FileSystemError.FileExists(to);
          }
          await fs.mkdir(path.dirname(to), { recursive: true });
          await fs.rename(from, to);
        },
        copy: async (source: unknown, target: unknown) => {
          const from = uriToFsPath(source);
          const to = uriToFsPath(target);
          await fs.mkdir(path.dirname(to), { recursive: true });
          await fs.cp(from, to, { recursive: true });
        },
        createDirectory: async (uri: unknown) => await fs.mkdir(uriToFsPath(uri), { recursive: true }),
        readDirectory: async (uri: unknown) => {
          const entries = await fs.readdir(uriToFsPath(uri), { withFileTypes: true });
          return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : entry.isFile() ? 1 : 0]);
        },
        isWritableFileSystem: () => true,
      },
      createFileSystemWatcher: (pattern: unknown) => createFileSystemWatcherImpl(pattern),
      get textDocuments() {
        return [...documentStates.values()].map((state) => getOrCreateDocument(state));
      },
      notebookDocuments: [] as unknown[],
      onDidOpenTextDocument: onDidOpenTextDocumentEmitter.event,
      onDidCloseTextDocument: onDidCloseTextDocumentEmitter.event,
      onDidSaveTextDocument: onDidSaveTextDocumentEmitter.event,
      onWillSaveTextDocument: noopEvent,
      onDidChangeTextDocument: onDidChangeTextDocumentEmitter.event,
      onDidCreateFiles: noopEvent,
      onDidDeleteFiles: noopEvent,
      onDidRenameFiles: noopEvent,
      onWillCreateFiles: noopEvent,
      onWillDeleteFiles: noopEvent,
      onWillRenameFiles: noopEvent,
      onDidOpenNotebookDocument: noopEvent,
      onDidCloseNotebookDocument: noopEvent,
      onDidSaveNotebookDocument: noopEvent,
      onDidChangeNotebookDocument: noopEvent,
      registerTextDocumentContentProvider: () => createDisposable(),
      registerFileSystemProvider: () => createDisposable(),
      registerNotebookSerializer: () => createDisposable(),
      registerTaskProvider: () => createDisposable(),
      getConfiguration: (section?: string) => createConfigurationObject(extensionId, section),
      onDidChangeConfiguration: configChangeEmitter.event,
      onDidChangeWorkspaceFolders: noopEvent,
    },
    env: {
      appName: "OpenCursor",
      appRoot: workspaceRoot,
      appHost: "desktop",
      language: "en",
      machineId,
      sessionId,
      uiKind: 1,
      uriScheme: "opencursor",
      shell: process.env.SHELL ?? (process.platform === "win32" ? "powershell.exe" : "/bin/bash"),
      remoteName: undefined,
      isNewAppInstall: false,
      asExternalUri: async (uri: unknown) => uri,
      isTelemetryEnabled: false,
      onDidChangeTelemetryEnabled: noopEvent,
      createTelemetryLogger: () => ({
        logUsage: () => undefined,
        logError: () => undefined,
        onDidChangeEnableStates: noopEvent,
        isUsageEnabled: false,
        isErrorsEnabled: false,
        dispose: () => undefined,
      }),
      openExternal: async (uri: unknown) => {
        const url = uriToExternalString(uri);
        if (/^https?:/i.test(url)) {
          emitEvent({ event: "external-url", payload: { extensionId, url } });
          return true;
        }
        if (url.startsWith("file://")) {
          emitEvent({
            event: "open-document",
            payload: { extensionId, path: url.slice("file://".length) },
          });
          return true;
        }
        return false;
      },
      clipboard: {
        readText: async () => clipboardCache,
        writeText: async (value: string) => {
          clipboardCache = String(value ?? "");
          emitEvent({ event: "clipboard-write", payload: { extensionId, text: clipboardCache } });
        },
      },
      logLevel: 3,
      onDidChangeLogLevel: noopEvent,
    },
    l10n: {
      uri: undefined,
      bundle: undefined,
      t: (message: string | { message: string; args?: unknown[] }, ...args: unknown[]) => {
        const text = typeof message === "string" ? message : message.message;
        const values = typeof message === "string" ? args : (message.args ?? args);
        return values.reduce<string>(
          (acc, value, index) => acc.replace(new RegExp(`\\{${index}\\}`, "g"), String(value)),
          text
        );
      },
    },
    languages: {
      getLanguages: async () => [
        ...new Set([...Object.values(LANGUAGE_BY_EXTENSION), "plaintext", "jsonc"]),
      ],
      match: (selector: unknown, document: unknown) => {
        const languageId =
          document && typeof document === "object" && "languageId" in document
            ? String((document as { languageId?: unknown }).languageId ?? "")
            : "";
        return selectorMatches(selector, languageId) ? 10 : 0;
      },
      setTextDocumentLanguage: async (document: unknown, languageId: string) => {
        const fsPath =
          document && typeof document === "object" && "uri" in document
            ? uriToFsPath((document as { uri?: unknown }).uri)
            : "";
        const state = fsPath ? documentStates.get(fsPath) : undefined;
        if (state) state.languageId = languageId;
        return document;
      },
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
      registerHoverProvider: (selector: unknown, provider: Record<string, unknown>) =>
        registerLanguageProvider("hover", { extensionId, selector, provider }),
      registerCompletionItemProvider: (
        selector: unknown,
        provider: Record<string, unknown>,
        ...triggerCharacters: string[]
      ) =>
        registerLanguageProvider("completion", {
          extensionId,
          selector,
          provider,
          triggerCharacters: triggerCharacters.filter((char) => typeof char === "string"),
        }),
      registerDefinitionProvider: (selector: unknown, provider: Record<string, unknown>) =>
        registerLanguageProvider("definition", { extensionId, selector, provider }),
      registerDocumentFormattingEditProvider: (selector: unknown, provider: Record<string, unknown>) =>
        registerLanguageProvider("formatting", { extensionId, selector, provider }),
      registerCodeActionsProvider: () => createDisposable(),
      registerDocumentLinkProvider: () => createDisposable(),
      registerDocumentRangeFormattingEditProvider: () => createDisposable(),
      registerOnTypeFormattingEditProvider: () => createDisposable(),
      registerRenameProvider: () => createDisposable(),
      registerDocumentSymbolProvider: () => createDisposable(),
      registerWorkspaceSymbolProvider: () => createDisposable(),
      registerReferenceProvider: () => createDisposable(),
      registerImplementationProvider: () => createDisposable(),
      registerTypeDefinitionProvider: () => createDisposable(),
      registerDeclarationProvider: () => createDisposable(),
      registerCodeLensProvider: () => createDisposable(),
      registerColorProvider: () => createDisposable(),
      registerFoldingRangeProvider: () => createDisposable(),
      registerSelectionRangeProvider: () => createDisposable(),
      registerCallHierarchyProvider: () => createDisposable(),
      registerTypeHierarchyProvider: () => createDisposable(),
      registerDocumentHighlightProvider: () => createDisposable(),
      registerSignatureHelpProvider: () => createDisposable(),
      registerInlayHintsProvider: () => createDisposable(),
      registerInlineCompletionItemProvider: () => createDisposable(),
      registerDocumentSemanticTokensProvider: () => createDisposable(),
      registerDocumentRangeSemanticTokensProvider: () => createDisposable(),
      registerLinkedEditingRangeProvider: () => createDisposable(),
      registerEvaluatableExpressionProvider: () => createDisposable(),
      registerInlineValuesProvider: () => createDisposable(),
      onDidChangeDiagnostics: noopEvent,
      getDiagnostics: () => [] as unknown[],
      createDiagnosticCollection: (name?: string) => createDiagnosticCollectionImpl(extensionId, name),
    },
    extensions: {
      getExtension: (id: string) => extensionRegistry.get(String(id ?? "").toLowerCase()),
      get all() {
        return [...extensionRegistry.values()];
      },
      onDidChange: noopEvent,
    },
    authentication: {
      registerAuthenticationProvider: (
        id: string,
        _label: string,
        provider: Record<string, unknown>,
        options?: unknown
      ) => {
        authenticationProviders.set(id, { extensionId, provider, options });
        return createDisposable(() => authenticationProviders.delete(id));
      },
      getSession: async (
        providerId: string,
        scopes: readonly string[],
        options?: { createIfNone?: boolean; silent?: boolean }
      ) => {
        const entry = authenticationProviders.get(providerId);
        if (!entry) return undefined;
        const provider = entry.provider as {
          getSessions?: (scopes?: readonly string[], options?: unknown) => Promise<unknown[]>;
          createSession?: (scopes: readonly string[], options?: unknown) => Promise<unknown>;
        };
        try {
          const sessions = (await provider.getSessions?.(scopes, {})) ?? [];
          if (Array.isArray(sessions) && sessions.length > 0) return sessions[0];
          if (options?.createIfNone && provider.createSession) {
            return await provider.createSession(scopes, {});
          }
        } catch {
          /* fall through */
        }
        return undefined;
      },
      getAccounts: async () => [] as unknown[],
      onDidChangeSessions: authSessionsEmitter.event,
    },
    lm: {
      selectChatModels: async () => [] as unknown[],
      onDidChangeChatModels: noopEvent,
      registerTool: () => createDisposable(),
      invokeTool: async () => {
        throw new Error("Language model tools are not available in this host.");
      },
      tools: [] as unknown[],
      registerMcpServerDefinitionProvider: () => createDisposable(),
    },
    chat: {
      createChatParticipant: () => ({
        iconPath: undefined,
        requestHandler: undefined,
        followupProvider: undefined,
        dispose: () => undefined,
        onDidReceiveFeedback: noopEvent,
      }),
    },
    debug: {
      activeDebugSession: undefined,
      activeDebugConsole: {
        append: () => undefined,
        appendLine: () => undefined,
      },
      breakpoints: [] as unknown[],
      onDidStartDebugSession: noopEvent,
      onDidTerminateDebugSession: noopEvent,
      onDidChangeActiveDebugSession: noopEvent,
      onDidReceiveDebugSessionCustomEvent: noopEvent,
      onDidChangeBreakpoints: noopEvent,
      registerDebugConfigurationProvider: () => createDisposable(),
      registerDebugAdapterDescriptorFactory: () => createDisposable(),
      registerDebugAdapterTrackerFactory: () => createDisposable(),
      startDebugging: async () => false,
      stopDebugging: async () => undefined,
      addBreakpoints: () => undefined,
      removeBreakpoints: () => undefined,
      asDebugSourceUri: (source: unknown) => source,
    },
    scm: {
      inputBox: undefined,
      createSourceControl: (id: string, label: string) => ({
        id,
        label,
        rootUri: Uri.file(workspaceRoot),
        inputBox: {
          value: "",
          placeholder: "",
          enabled: true,
          visible: true,
        },
        count: 0,
        quickDiffProvider: undefined,
        commitTemplate: undefined,
        acceptInputCommand: undefined,
        statusBarCommands: undefined,
        createResourceGroup: (groupId: string, groupLabel: string) => ({
          id: groupId,
          label: groupLabel,
          hideWhenEmpty: false,
          resourceStates: [] as unknown[],
          dispose: () => undefined,
        }),
        dispose: () => undefined,
      }),
    },
    tasks: {
      registerTaskProvider: () => createDisposable(),
      fetchTasks: async () => [] as unknown[],
      executeTask: async () => {
        throw new Error("Task execution is not available in this host.");
      },
      taskExecutions: [] as unknown[],
      onDidStartTask: noopEvent,
      onDidEndTask: noopEvent,
      onDidStartTaskProcess: noopEvent,
      onDidEndTaskProcess: noopEvent,
    },
    tests: {
      createTestController: (id: string, label: string) => ({
        id,
        label,
        items: {
          add: () => undefined,
          delete: () => undefined,
          replace: () => undefined,
          get: () => undefined,
          forEach: () => undefined,
          size: 0,
        },
        createRunProfile: () => ({ dispose: () => undefined }),
        createTestItem: (itemId: string, itemLabel: string, uri?: unknown) => ({
          id: itemId,
          label: itemLabel,
          uri,
          children: {
            add: () => undefined,
            delete: () => undefined,
            replace: () => undefined,
            get: () => undefined,
            forEach: () => undefined,
            size: 0,
          },
        }),
        createTestRun: () => ({
          passed: () => undefined,
          failed: () => undefined,
          errored: () => undefined,
          skipped: () => undefined,
          started: () => undefined,
          enqueued: () => undefined,
          appendOutput: () => undefined,
          end: () => undefined,
          token: new CancellationTokenSource().token,
        }),
        refreshHandler: undefined,
        resolveHandler: undefined,
        dispose: () => undefined,
      }),
    },
    notebooks: {
      createNotebookController: () => ({
        dispose: () => undefined,
        createNotebookCellExecution: () => ({
          start: () => undefined,
          end: () => undefined,
        }),
        executeHandler: undefined,
        onDidChangeSelectedNotebooks: noopEvent,
      }),
      registerNotebookCellStatusBarItemProvider: () => createDisposable(),
    },
    comments: {
      createCommentController: (id: string, label: string) => ({
        id,
        label,
        options: undefined,
        commentingRangeProvider: undefined,
        createCommentThread: () => ({
          dispose: () => undefined,
          comments: [] as unknown[],
        }),
        dispose: () => undefined,
      }),
    },
  };
  return new Proxy(shim, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      if (typeof property === "string" && /^[A-Z]/.test(property) && property !== "then") {
        return VscodeFallbackClass;
      }
      return undefined;
    },
  });
}

/* ------------------------------------------------------------------ */
/* Module loader patch                                                 */
/* ------------------------------------------------------------------ */

type ModuleLoader = {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

const requireNodeModule = createRequire(import.meta.url);
const moduleLoader = requireNodeModule("node:module") as ModuleLoader;
const originalLoad = moduleLoader._load;
const shimCache = new Map<string, ReturnType<typeof createVscodeShim>>();
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
    let shim = shimCache.get(extensionId);
    if (!shim) {
      shim = createVscodeShim(extensionId);
      shimCache.set(extensionId, shim);
    }
    return shim;
  }
  return originalLoad.call(this, request, parent, isMain);
};

/* ------------------------------------------------------------------ */
/* Activation                                                          */
/* ------------------------------------------------------------------ */

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

async function activate(params: ActivateParams) {
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

async function activateInner(params: ActivateParams) {
  const startedAt = Date.now();
  emitEvent({ event: "activation-started", payload: { extensionId: params.extensionId } });
  try {
    const result = await activateCore(params);
    emitEvent({
      event: "activation-finished",
      payload: { extensionId: params.extensionId, ok: true, durationMs: Date.now() - startedAt },
    });
    return result;
  } catch (error) {
    emitEvent({
      event: "activation-finished",
      payload: {
        extensionId: params.extensionId,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

async function activateCore(params: ActivateParams) {
  extensionRuntimeContexts.set(params.extensionId, params.context);
  const store = ensureConfigStore(params.extensionId);
  if (params.settings) {
    applyExtensionSettings(params.extensionId, params.settings);
  }
  let packageJSON: unknown = {};
  try {
    packageJSON = JSON.parse(
      await fs.readFile(path.join(params.context.extensionPath, "package.json"), "utf8")
    );
  } catch {
    packageJSON = {};
  }
  store.defaults = extractConfigDefaults(packageJSON);

  if (!params.main) {
    activated.add(params.extensionId);
    registerExtensionRecord(params, packageJSON, undefined);
    return { activated: true, commands: [...commands.keys()], staticOnly: true };
  }
  const entry = path.resolve(params.installPath, "extension", params.main);
  const fallbackEntry = path.resolve(params.installPath, params.main);
  const requireFn = createRequire(import.meta.url);
  let moduleExports: unknown;
  try {
    moduleExports = requireFn(resolveExtensionEntry(requireFn, entry, fallbackEntry));
  } catch (error) {
    if (!hasStaticContributionOnlyValue(packageJSON)) {
      throw error;
    }
    process.stderr.write(
      `[${params.extensionId}] runtime import failed for static contribution package; treating manifest contributions as active.\n`
    );
    activated.add(params.extensionId);
    registerExtensionRecord(params, packageJSON, undefined);
    return { activated: true, commands: [...commands.keys()], staticOnly: true };
  }
  const vscode = createVscodeShim(params.extensionId);
  const extensionUri = Uri.file(params.context.extensionPath);
  await fs.mkdir(params.context.storagePath, { recursive: true }).catch(() => undefined);
  await fs.mkdir(params.context.globalStoragePath, { recursive: true }).catch(() => undefined);
  await fs.mkdir(params.context.logPath, { recursive: true }).catch(() => undefined);
  const [workspaceState, globalState, secrets] = await Promise.all([
    createPersistentMemento(path.join(params.context.storagePath, "memento.json")),
    createPersistentMemento(path.join(params.context.globalStoragePath, "memento.json")),
    createSecretStorage(path.join(params.context.globalStoragePath, "secrets.json")),
  ]);
  const context = {
    ...params.context,
    subscriptions: [] as Disposable[],
    extensionMode: 1,
    asAbsolutePath: (relativePath: string) => path.join(params.context.extensionPath, relativePath),
    extension: {
      id: params.extensionId,
      extensionUri,
      extensionPath: params.context.extensionPath,
      packageJSON,
      extensionKind: [2],
      isActive: true,
      exports: moduleExports,
      activate: async () => moduleExports,
    },
    extensionUri,
    storageUri: Uri.file(params.context.storagePath),
    globalStorageUri: Uri.file(params.context.globalStoragePath),
    logUri: Uri.file(params.context.logPath),
    workspaceState,
    globalState,
    secrets,
    environmentVariableCollection: {
      persistent: false,
      description: undefined,
      replace: () => undefined,
      append: () => undefined,
      prepend: () => undefined,
      get: () => undefined,
      forEach: () => undefined,
      delete: () => undefined,
      clear: () => undefined,
      getScoped: () => ({
        persistent: false,
        replace: () => undefined,
        append: () => undefined,
        prepend: () => undefined,
        get: () => undefined,
        forEach: () => undefined,
        delete: () => undefined,
        clear: () => undefined,
      }),
    },
    languageModelAccessInformation: {
      onDidChange: noopEvent,
      canSendRequest: () => undefined,
    },
    logPath: params.context.logPath,
  };
  registerExtensionRecord(params, packageJSON, moduleExports);
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
  void vscode;
  activated.add(params.extensionId);
  extensionSubscriptions.set(params.extensionId, context.subscriptions);
  return { activated: true, commands: [...commands.keys()] };
}

function registerExtensionRecord(
  params: ActivateParams,
  packageJSON: unknown,
  moduleExports: unknown
): void {
  extensionRegistry.set(params.extensionId.toLowerCase(), {
    id: params.extensionId,
    extensionUri: Uri.file(params.context.extensionPath),
    extensionPath: params.context.extensionPath,
    packageJSON,
    extensionKind: [2],
    isActive: true,
    exports: moduleExports,
    activate: async () => moduleExports,
  });
}

/* ------------------------------------------------------------------ */
/* Request dispatch                                                    */
/* ------------------------------------------------------------------ */

async function handleRequest(request: HostRequest): Promise<HostResponse> {
  try {
    if (request.method === "activate") {
      return { id: request.id, ok: true, result: await activate(request.params) };
    }
    if (request.method === "executeCommand") {
      if (request.params.editorContext) {
        applyEditorContextSync(request.params.editorContext, "focus");
      }
      let commandId = request.params.command;
      let args = request.params.args ?? [];
      if (request.params.treeItem) {
        const entry = treeDataProviders.get(request.params.treeItem.viewId);
        const handleEntry = entry?.handles.get(request.params.treeItem.handle);
        if (!handleEntry) {
          throw new Error("Tree item is no longer available; refresh the view.");
        }
        if (handleEntry.command?.command) {
          commandId = handleEntry.command.command;
          args = handleEntry.command.arguments ?? [handleEntry.element];
        } else if (commandId) {
          args = [handleEntry.element, ...args];
        } else {
          throw new Error("Tree item has no command.");
        }
      }
      const handler = commands.get(commandId);
      if (!handler) {
        if (commandId === "setContext" || commandId.startsWith("workbench.") || commandId.startsWith("vscode.")) {
          return { id: request.id, ok: true, result: { commandResult: undefined, externalUrls: [] } };
        }
        throw new Error(`Command not found: ${commandId}`);
      }
      const commandResult = await handler(...args);
      let safeResult: unknown = commandResult;
      try {
        JSON.stringify(safeResult);
      } catch {
        safeResult = undefined;
      }
      return {
        id: request.id,
        ok: true,
        result: {
          commandResult: safeResult,
          externalUrls: [],
        },
      };
    }
    if (request.method === "resolveWebviewView") {
      const webviewKey = request.params.surfaceSessionId ?? request.params.surfaceId;
      if (request.params.theme) {
        applyThemePayload(request.params.theme);
      }
      const existingWebview = resolvedWebviews.get(webviewKey);
      if (existingWebview && existingWebview.extensionId === request.params.extensionId) {
        return {
          id: request.id,
          ok: true,
          result: {
            html: existingWebview.getHtml(),
            messages: [],
            externalUrls: [],
            missingProvider: false,
          },
        };
      }
      const exactEntry = webviewViewProviders.get(request.params.surfaceId);
      const extensionEntries = [...webviewViewProviders.entries()].filter(
        ([, provider]) => provider.extensionId === request.params.extensionId
      );
      const entry =
        exactEntry ?? (extensionEntries.length === 1 ? extensionEntries[0]?.[1] : undefined);
      if (!entry) {
        const treeEntry = treeDataProviders.get(request.params.surfaceId);
        if (treeEntry && treeEntry.extensionId === request.params.extensionId) {
          const { items } = await getSerializedTreeChildren({
            extensionId: request.params.extensionId,
            viewId: request.params.surfaceId,
          });
          return {
            id: request.id,
            ok: true,
            result: {
              html: "",
              messages: [],
              externalUrls: [],
              missingProvider: false,
              treeView: true,
              treeItems: items,
            },
          };
        }
        const serializerEntry = webviewPanelSerializers.get(request.params.surfaceId);
        if (serializerEntry && serializerEntry.extensionId === request.params.extensionId) {
          const panel = createWebviewPanelObject({
            extensionId: request.params.extensionId,
            viewType: request.params.surfaceId,
            title: request.params.title ?? request.params.surfaceId,
            surfaceKey: webviewKey,
            announce: false,
          });
          await serializerEntry.serializer.deserializeWebviewPanel?.(panel, request.params.state);
          const tracked = resolvedWebviews.get(webviewKey);
          return {
            id: request.id,
            ok: true,
            result: {
              html: tracked?.getHtml() ?? "",
              messages: [],
              externalUrls: [],
              missingProvider: false,
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
      const tracked = createTrackedWebview({
        extensionId: request.params.extensionId,
        surfaceKey: webviewKey,
        emitHtml: true,
      });
      resolvedWebviews.set(webviewKey, tracked);
      const visibilityEmitter = new EventEmitter<void>();
      const viewDisposeEmitter = new EventEmitter<void>();
      const view = {
        viewType: request.params.surfaceId,
        title: request.params.title ?? request.params.surfaceId,
        description: "",
        badge: undefined,
        visible: true,
        webview: tracked.webview,
        show: () => undefined,
        onDidDispose: viewDisposeEmitter.event,
        onDidChangeVisibility: visibilityEmitter.event,
      };
      await entry.provider.resolveWebviewView?.(
        view,
        { state: request.params.state },
        {
          isCancellationRequested: false,
          onCancellationRequested: noopEvent,
        }
      );
      return {
        id: request.id,
        ok: true,
        result: {
          html: tracked.getHtml(),
          messages: [],
          externalUrls: [],
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
          result: { messages: [], externalUrls: [], missingWebview: true },
        };
      }
      webview.acceptMessage(request.params.message);
      return {
        id: request.id,
        ok: true,
        result: { messages: [], externalUrls: [], missingWebview: false },
      };
    }
    if (request.method === "updateWebviewTheme") {
      applyThemePayload(request.params.theme);
      return {
        id: request.id,
        ok: true,
        result: { messages: [], externalUrls: [], missingWebview: false },
      };
    }
    if (request.method === "getTreeChildren") {
      return {
        id: request.id,
        ok: true,
        result: await getSerializedTreeChildren({
          extensionId: request.params.extensionId,
          viewId: request.params.viewId,
          parentHandle: request.params.parentHandle,
        }),
      };
    }
    if (request.method === "uiResponse") {
      const pending = pendingUiRequests.get(request.params.requestId);
      if (pending) {
        pending.resolve(request.params);
      }
      return { id: request.id, ok: true, result: { delivered: Boolean(pending) } };
    }
    if (request.method === "uiEvent") {
      const pending = pendingUiRequests.get(request.params.requestId);
      pending?.onClientEvent?.(request.params);
      return { id: request.id, ok: true, result: { delivered: Boolean(pending) } };
    }
    if (request.method === "provideLanguageFeature") {
      return {
        id: request.id,
        ok: true,
        result: await provideLanguageFeatureImpl(request.params),
      };
    }
    if (request.method === "dispose") {
      for (const subscriptions of extensionSubscriptions.values()) {
        for (const item of subscriptions) {
          try {
            item.dispose();
          } catch {
            /* extension dispose errors must not block shutdown */
          }
        }
      }
      await flushAllStores().catch(() => undefined);
      writeResponse({ id: request.id, ok: true, result: { disposed: true } });
      // Give the response line a moment to flush before exiting.
      setTimeout(() => process.exit(0), 20);
      return { id: request.id, ok: true, result: { disposed: true } };
    }
    return { id: (request as { id: string }).id, ok: false, error: "Unknown host method." };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    };
  }
}

function applyThemePayload(theme: unknown): void {
  const kind =
    theme && typeof theme === "object" && (theme as { colorScheme?: unknown }).colorScheme === "light"
      ? 1
      : 2;
  if (kind !== activeColorThemeKind) {
    activeColorThemeKind = kind;
    activeColorThemeEmitter.fire({ kind });
  }
}

function handleNotify(notify: HostNotify): void {
  if (notify.notify === "editorContext") {
    applyEditorContextSync(notify.params.context, notify.params.reason);
    return;
  }
  if (notify.notify === "configChanged") {
    applyExtensionSettings(notify.params.extensionId, notify.params.settings);
    configChangeEmitter.fire({ affectsConfiguration: () => true });
    return;
  }
  if (notify.notify === "themeChanged") {
    applyThemePayload(notify.params.theme);
  }
}

/* ------------------------------------------------------------------ */
/* stdin loop + metrics                                                */
/* ------------------------------------------------------------------ */

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
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      process.stderr.write(`[extensions] dropped malformed request line (${line.length} bytes)\n`);
      continue;
    }
    if (parsed && typeof parsed === "object" && "notify" in parsed) {
      try {
        handleNotify(parsed as HostNotify);
      } catch (error) {
        process.stderr.write(
          `[extensions] notify handler failed: ${error instanceof Error ? error.message : String(error)}\n`
        );
      }
      continue;
    }
    if (parsed && typeof parsed === "object" && "id" in parsed && "method" in parsed) {
      void handleRequest(parsed as HostRequest).then((response) => {
        if ((parsed as HostRequest).method !== "dispose") {
          writeResponse(response);
        }
      });
    }
  }
});

process.stdin.on("end", () => {
  void flushAllStores().finally(() => process.exit(0));
});

const startedCpu = process.cpuUsage();
const startedAt = Date.now();

function emitMetrics(): void {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage(startedCpu);
  emitEvent({
    event: "metrics",
    payload: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      uptimeMs: Date.now() - startedAt,
    },
  });
}

const metricsTimer = setInterval(emitMetrics, 10_000);
metricsTimer.unref?.();

emitEvent({ event: "ready", payload: { pid: process.pid } });
emitMetrics();

process.stderr.write(`[extensions] host child ready at ${fileURLToPath(import.meta.url)}\n`);

// escapeHtml retained for potential HTML fallbacks (tree rendering moved client-side).
void escapeHtml;
void readFileSync;
