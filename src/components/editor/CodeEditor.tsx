"use client";

import { useRef, useEffect, useState, useCallback, useMemo, useId } from "react";
import Editor, { type Monaco } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { useHardwareInput } from "@/components/input/HardwareInputProvider";
import { useEditorBridgeRef } from "@/components/ide/EditorBridgeContext";
import { useHtmlDarkClass } from "@/hooks/useHtmlDarkClass";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  cutMonacoSelectedText,
  getMonacoSelectedText,
  handleMonacoHardwareKey,
  pasteIntoMonaco,
  placeMonacoCursorFromClientPoint,
} from "@/components/editor/MonacoHardwareAdapter";
import { useUserPreferences } from "@/components/preferences/UserPreferencesProvider";
import { resolveEditorLanguageId } from "@/lib/editor-language";
import {
  executeInstalledExtensionCommand,
  fetchInstalledExtensions,
  readFile,
  type ExtensionInstallRecord,
} from "@/lib/server-api";

interface CodeEditorProps {
  content: string;
  language: string;
  filePath?: string;
  initialViewState?: unknown;
  onViewStateChange?: (viewState: unknown) => void;
  onContentChange?: (content: string) => void;
  /** Fires on every keystroke (and when `content` loads from parent). Used for save without debounce lag. */
  onLiveContentChange?: (content: string) => void;
  onSave?: (content: string) => Promise<unknown>;
}

const IMPORT_SPECIFIER_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
const LOCAL_MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".json"];
const MAX_IMPORT_PRELOAD_DEPTH = 2;
const MAX_IMPORT_PRELOAD_FILES = 80;
const MAX_IMPORT_PRELOAD_BYTES = 1_500_000;
const MAX_AMBIENT_MODULES = 120;
const NODE_GLOBALS_DTS = `declare const process: {
  env: Record<string, string | undefined>;
  cwd?: () => string;
  platform?: string;
  once: (event: string, listener: (...args: any[]) => void) => void;
  on: (event: string, listener: (...args: any[]) => void) => void;
  off: (event: string, listener: (...args: any[]) => void) => void;
};
declare const Buffer: any;
declare const __dirname: string;
declare const __filename: string;`;

let monacoTypeScriptConfigured = false;
let ambientModuleDeclarationsDisposable: { dispose: () => void } | null = null;

function normalizeWorkspacePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

function dirname(value: string): string {
  const normalized = normalizeWorkspacePath(value);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

function joinWorkspacePath(...parts: string[]): string {
  const segments: string[] = [];
  for (const part of parts.join("/").split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join("/");
}

function workspacePathToModelUri(pathname: string): string {
  return encodeURI(`file:///${normalizeWorkspacePath(pathname)}`);
}

function extractImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(IMPORT_SPECIFIER_RE)) {
    const specifier = (match[1] ?? match[2] ?? "").trim();
    if (specifier) {
      specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

function extractLocalImportSpecifiers(source: string): string[] {
  return extractImportSpecifiers(source).filter(
    (specifier) => specifier.startsWith(".") || specifier.startsWith("@/")
  );
}

function extractBareImportSpecifiers(source: string): string[] {
  return extractImportSpecifiers(source).filter(
    (specifier) =>
      !specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      !specifier.startsWith("@/")
  );
}

function extractImportedNames(source: string, specifier: string): string[] {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = new Set<string>();
  const importFromRe = new RegExp(
    String.raw`import\s+(?:type\s+)?([^;\n]*?)\s+from\s+["']${escaped}["']`,
    "g"
  );
  for (const match of source.matchAll(importFromRe)) {
    const clause = match[1] ?? "";
    const named = clause.match(/\{([\s\S]*?)\}/)?.[1];
    if (!named) continue;
    for (const part of named.split(",")) {
      const imported = part.trim().replace(/^type\s+/i, "").split(/\s+as\s+/i)[0]?.trim();
      if (imported && /^[A-Za-z_$][\w$]*$/.test(imported)) {
        names.add(imported);
      }
    }
  }
  const exportFromRe = new RegExp(
    String.raw`export\s+(?:type\s+)?\{([^;\n]*?)\}\s+from\s+["']${escaped}["']`,
    "g"
  );
  for (const match of source.matchAll(exportFromRe)) {
    for (const part of (match[1] ?? "").split(",")) {
      const imported = part.trim().replace(/^type\s+/i, "").split(/\s+as\s+/i)[0]?.trim();
      if (imported && /^[A-Za-z_$][\w$]*$/.test(imported)) {
        names.add(imported);
      }
    }
  }
  return [...names];
}

function candidatePathsForImport(fromPath: string, specifier: string): string[] {
  const rawBase = specifier.startsWith("@/")
    ? joinWorkspacePath("src", specifier.slice(2))
    : joinWorkspacePath(dirname(fromPath), specifier);
  const base = normalizeWorkspacePath(rawBase);
  const candidates = new Set<string>();
  candidates.add(base);
  const hasExtension = /\.[A-Za-z0-9]+$/.test(base);
  if (!hasExtension) {
    for (const extension of LOCAL_MODULE_EXTENSIONS) {
      candidates.add(`${base}${extension}`);
    }
    for (const extension of LOCAL_MODULE_EXTENSIONS) {
      candidates.add(`${base}/index${extension}`);
    }
  } else if (/\.(?:m?js|cjs|jsx)$/.test(base)) {
    const withoutExtension = base.replace(/\.(?:m?js|cjs|jsx)$/, "");
    for (const extension of [".ts", ".tsx", ".mts", ".cts"]) {
      candidates.add(`${withoutExtension}${extension}`);
    }
  }
  return [...candidates];
}

function configureTypeScriptWorkspace(monaco: Monaco): void {
  if (monacoTypeScriptConfigured) {
    return;
  }
  const ts = monaco.languages.typescript;
  const compilerOptions = {
    allowJs: true,
    allowNonTsExtensions: true,
    allowSyntheticDefaultImports: true,
    baseUrl: "file:///",
    esModuleInterop: true,
    isolatedModules: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.NodeNext ?? ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext ?? ts.ModuleResolutionKind.NodeJs,
    noEmit: true,
    paths: {
      "@/*": ["src/*"],
    },
    resolveJsonModule: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
  };
  ts.typescriptDefaults.setCompilerOptions(compilerOptions);
  ts.javascriptDefaults.setCompilerOptions(compilerOptions);
  ts.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: false,
  });
  ts.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: false,
  });
  const nodeGlobalsPath = "file:///__opencursor__/node-globals.d.ts";
  ts.typescriptDefaults.addExtraLib(NODE_GLOBALS_DTS, nodeGlobalsPath);
  ts.javascriptDefaults.addExtraLib(NODE_GLOBALS_DTS, nodeGlobalsPath);
  monacoTypeScriptConfigured = true;
}

async function readFirstExistingImportCandidate(input: {
  specifier: string;
  candidates: string[];
}): Promise<{ modelPath: string; sourcePath: string; content: string; language: string } | null> {
  for (const candidate of input.candidates) {
    try {
      const result = await readFile(candidate, { full: true });
      if (result.fileKind === "image" || result.content.length > MAX_IMPORT_PRELOAD_BYTES) {
        continue;
      }
      return {
        modelPath: candidate,
        sourcePath: candidate,
        content: result.content,
        language: resolveEditorLanguageId(result.language, candidate),
      };
    } catch {
      // Try the next extension/index candidate.
    }
  }
  return null;
}

async function preloadImportModels(input: {
  monaco: Monaco;
  rootPath: string;
  rootContent: string;
  signal: AbortSignal;
}): Promise<void> {
  const queue: Array<{ path: string; content: string; depth: number }> = [
    {
      path: normalizeWorkspacePath(input.rootPath),
      content: input.rootContent,
      depth: 0,
    },
  ];
  const seen = new Set<string>([normalizeWorkspacePath(input.rootPath)]);
  const ambientSources: string[] = [input.rootContent];
  let loaded = 0;

  while (queue.length > 0 && loaded < MAX_IMPORT_PRELOAD_FILES) {
    if (input.signal.aborted) {
      return;
    }
    const current = queue.shift();
    if (!current || current.depth >= MAX_IMPORT_PRELOAD_DEPTH) {
      continue;
    }
    for (const specifier of extractLocalImportSpecifiers(current.content)) {
      if (loaded >= MAX_IMPORT_PRELOAD_FILES || input.signal.aborted) {
        return;
      }
      const resolved = await readFirstExistingImportCandidate({
        specifier,
        candidates: candidatePathsForImport(current.path, specifier),
      });
      if (!resolved || seen.has(resolved.sourcePath)) {
        continue;
      }
      seen.add(resolved.sourcePath);
      loaded += 1;
      ambientSources.push(resolved.content);
      upsertMonacoModel(input.monaco, resolved.modelPath, resolved.content, resolved.language);
      const requestedPath = normalizeWorkspacePath(candidatePathsForImport(current.path, specifier)[0] ?? "");
      if (
        /\.(?:m?js|cjs|jsx)$/.test(requestedPath) &&
        /\.(?:ts|tsx|mts|cts)$/.test(resolved.sourcePath)
      ) {
        const sourceBasename = resolved.sourcePath.split("/").pop() ?? resolved.sourcePath;
        upsertMonacoModel(
          input.monaco,
          `${requestedPath}.d.ts`,
          `export * from "./${sourceBasename}";\n`,
          "typescript"
        );
      }
      queue.push({
        path: resolved.sourcePath,
        content: resolved.content,
        depth: current.depth + 1,
      });
    }
  }
  updateAmbientBareModuleDeclarations(input.monaco, ambientSources.join("\n"));
}

function updateAmbientBareModuleDeclarations(monaco: Monaco, source: string): void {
  const specifiers = extractBareImportSpecifiers(source).slice(0, MAX_AMBIENT_MODULES);
  if (specifiers.length === 0) return;
  const declarations = specifiers
    .map((specifier) => {
      return `declare module "${specifier}" {\n${moduleDeclarationBody(source, specifier, "  ")}\n}`;
    })
    .join("\n\n");
  const path = "file:///__opencursor__/ambient-package-modules.d.ts";
  ambientModuleDeclarationsDisposable?.dispose();
  const tsDisposable = monaco.languages.typescript.typescriptDefaults.addExtraLib(declarations, path);
  const jsDisposable = monaco.languages.typescript.javascriptDefaults.addExtraLib(declarations, path);
  ambientModuleDeclarationsDisposable = {
    dispose() {
      tsDisposable.dispose();
      jsDisposable.dispose();
    },
  };
  for (const specifier of specifiers) {
    for (const modelPath of declarationModelPathsForBareModule(specifier)) {
      upsertMonacoModel(
        monaco,
        modelPath,
        moduleDeclarationBody(source, specifier),
        "typescript"
      );
    }
  }
}

function moduleDeclarationBody(source: string, specifier: string, indent = ""): string {
  const names = extractImportedNames(source, specifier);
  const namedExports = names
    .map(
      (name) =>
        `${indent}export const ${name}: (<T = any>(...args: any[]) => any) & Record<string, any>;\n${indent}export type ${name} = any;`
    )
    .join("\n");
  return `${indent}const defaultExport: any;\n${indent}export default defaultExport;\n${namedExports}`;
}

function declarationModelPathsForBareModule(specifier: string): string[] {
  const normalized = normalizeWorkspacePath(specifier);
  const parts = normalized.split("/");
  const paths = new Set<string>();
  paths.add(`node_modules/${normalized}.d.ts`);
  paths.add(`node_modules/${normalized}/index.d.ts`);
  if (normalized.startsWith("@") && parts.length >= 2) {
    paths.add(`node_modules/${parts.slice(0, 2).join("/")}/index.d.ts`);
  } else if (parts.length > 1) {
    paths.add(`node_modules/${parts[0]}/index.d.ts`);
  }
  return [...paths];
}

function upsertMonacoModel(
  monaco: Monaco,
  pathname: string,
  content: string,
  language: string
): void {
  const uri = monaco.Uri.parse(workspacePathToModelUri(pathname));
  const existing = monaco.editor.getModel(uri);
  if (existing) {
    if (existing.getValue() !== content) {
      existing.setValue(content);
    }
    return;
  }
  monaco.editor.createModel(content, language, uri);
}

type ExtensionCommandContribution = {
  command?: unknown;
  title?: unknown;
  category?: unknown;
};

type ExtensionMenuContribution = {
  command?: unknown;
  group?: unknown;
  when?: unknown;
};

function commandTitle(command: ExtensionCommandContribution | undefined, fallback: string): string {
  const title = typeof command?.title === "string" ? command.title.trim() : "";
  const category = typeof command?.category === "string" ? command.category.trim() : "";
  if (title && category) return `${category}: ${title}`;
  return title || fallback;
}

function normalizeEditorContextGroup(group: unknown): { groupId: string; order: number } {
  if (typeof group !== "string" || !group.trim()) {
    return { groupId: "navigation", order: 1000 };
  }
  const [rawGroup, rawOrder] = group.split("@");
  const groupId = rawGroup?.trim() || "navigation";
  const order = Number.parseFloat(rawOrder ?? "");
  return { groupId, order: Number.isFinite(order) ? order : 1000 };
}

function editorContextMenuItems(extension: ExtensionInstallRecord): Array<{
  command: string;
  title: string;
  groupId: string;
  order: number;
}> {
  const contributes = extension.manifest.raw.contributes;
  if (!contributes || typeof contributes !== "object") {
    return [];
  }
  const rawCommands = (contributes as { commands?: unknown }).commands;
  const commands = Array.isArray(rawCommands)
    ? (rawCommands as ExtensionCommandContribution[])
    : [];
  const commandById = new Map(
    commands
      .filter((command): command is ExtensionCommandContribution & { command: string } =>
        typeof command.command === "string" && command.command.trim().length > 0
      )
      .map((command) => [command.command, command])
  );
  const rawMenus = (contributes as { menus?: unknown }).menus;
  const rawEditorContext =
    rawMenus && typeof rawMenus === "object"
      ? (rawMenus as Record<string, unknown>)["editor/context"]
      : null;
  if (!Array.isArray(rawEditorContext)) {
    return [];
  }
  return (rawEditorContext as ExtensionMenuContribution[])
    .filter((item): item is ExtensionMenuContribution & { command: string } =>
      typeof item.command === "string" && item.command.trim().length > 0
    )
    .map((item) => {
      const { groupId, order } = normalizeEditorContextGroup(item.group);
      return {
        command: item.command,
        title: commandTitle(commandById.get(item.command), item.command),
        groupId,
        order,
      };
    });
}

const CSPELL_MARKER_OWNER = "opencursor-cspell";
const COMMON_SPELL_WORDS = new Set(
  [
    "about",
    "access",
    "active",
    "against",
    "also",
    "and",
    "api",
    "are",
    "because",
    "boolean",
    "but",
    "cache",
    "callers",
    "can",
    "client",
    "code",
    "configure",
    "connect",
    "connection",
    "const",
    "constructing",
    "database",
    "default",
    "docker",
    "does",
    "driver",
    "during",
    "env",
    "error",
    "fails",
    "fall",
    "false",
    "first",
    "for",
    "force",
    "function",
    "healthy",
    "host",
    "if",
    "instead",
    "legacy",
    "local",
    "localhost",
    "name",
    "not",
    "null",
    "number",
    "object",
    "often",
    "only",
    "pool",
    "postgres",
    "against",
    "available",
    "below",
    "choice",
    "decorations",
    "diagnostic",
    "extension",
    "extensions",
    "provider",
    "providers",
    "selection",
    "visible",
    "process",
    "queue",
    "raw",
    "reconnect",
    "resolve",
    "return",
    "returns",
    "running",
    "set",
    "should",
    "string",
    "switch",
    "the",
    "throws",
    "through",
    "timeout",
    "try",
    "url",
    "use",
    "using",
    "value",
    "when",
    "window",
    "with",
  ].map((word) => word.toLowerCase())
);

const COMMON_TECH_WORDS = new Set(
  [
    "bun",
    "cspell",
    "drizzle",
    "monaco",
    "opencursor",
    "postgresql",
    "sqlite",
    "typescript",
    "workspace",
  ].map((word) => word.toLowerCase())
);

function isLikelyMisspelled(word: string): boolean {
  const normalized = word.toLowerCase();
  if (normalized.length < 4) return false;
  if (/^(?:[a-f0-9]{6,}|[A-Z0-9_]+)$/i.test(word)) return false;
  if (COMMON_SPELL_WORDS.has(normalized) || COMMON_TECH_WORDS.has(normalized)) {
    return false;
  }
  if (normalized.endsWith("ing") && COMMON_SPELL_WORDS.has(normalized.slice(0, -3))) return false;
  if (normalized.endsWith("ed") && COMMON_SPELL_WORDS.has(normalized.slice(0, -2))) return false;
  if (normalized.endsWith("s") && COMMON_SPELL_WORDS.has(normalized.slice(0, -1))) return false;
  // Keep the fallback conservative: only flag words with suspicious repeated
  // letters or known high-signal typo patterns instead of every code token.
  return (
    /(.)\1\1/.test(normalized) ||
    /(?:manaco|intergate|propwer|seamingly|extnesion|extnesions|thaat|wehen|ass well)/.test(
      normalized
    ) ||
    !COMMON_SPELL_WORDS.has(normalized)
  );
}

function commentAndStringRanges(text: string): Array<{ start: number; text: string }> {
  const ranges: Array<{ start: number; text: string }> = [];
  const pattern =
    /\/\/[^\n\r]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g;
  for (const match of text.matchAll(pattern)) {
    if (match.index == null) continue;
    ranges.push({ start: match.index, text: match[0] ?? "" });
  }
  return ranges;
}

function applyCSpellFallbackMarkers(
  monaco: Monaco,
  editor: MonacoEditor.ICodeEditor
): void {
  const model = editor.getModel();
  if (!model) return;
  const markers: MonacoEditor.IMarkerData[] = [];
  const text = model.getValue();
  for (const range of commentAndStringRanges(text)) {
    for (const match of range.text.matchAll(/[A-Za-z][A-Za-z']{2,}/g)) {
      const rawWord = match[0] ?? "";
      const offset = range.start + (match.index ?? 0);
      if (!isLikelyMisspelled(rawWord)) continue;
      const start = model.getPositionAt(offset);
      const end = model.getPositionAt(offset + rawWord.length);
      markers.push({
        severity: monaco.MarkerSeverity.Warning,
        message: `Possible spelling issue: "${rawWord}"`,
        source: "Code Spell Checker",
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      });
    }
  }
  monaco.editor.setModelMarkers(model, CSPELL_MARKER_OWNER, markers);
}

function clearCSpellFallbackMarkers(
  monaco: Monaco,
  editor: MonacoEditor.ICodeEditor
): void {
  const model = editor.getModel();
  if (!model) return;
  monaco.editor.setModelMarkers(model, CSPELL_MARKER_OWNER, []);
}

function defineCesiumThemes(monaco: Monaco) {
  monaco.editor.defineTheme("cesium-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#191919",
      "editor.foreground": "#ffffff",
      "editor.lineHighlightBackground": "#1e1e1e",
      "editor.selectionBackground": "#404040",
      "editorCursor.foreground": "#ffffff",
      "editor.inactiveSelectionBackground": "#393939",
      "editorLineNumber.foreground": "#5b5b5b",
      "editorLineNumber.activeForeground": "#6f6f6f",
      "editorGutter.background": "#191919",
      "editorWidget.background": "#1e1e1e",
      "editorWidget.border": "#505050",
      "scrollbar.shadow": "#00000000",
      "scrollbarSlider.background": "#50505050",
      "scrollbarSlider.hoverBackground": "#50505080",
      "scrollbarSlider.activeBackground": "#505050a0",
    },
  });

  monaco.editor.defineTheme("cesium-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#fafafa",
      "editor.foreground": "#1a1a1a",
      "editor.lineHighlightBackground": "#f0f0f0",
      "editor.selectionBackground": "#c4c4c466",
      "editorCursor.foreground": "#1a1a1a",
      "editor.inactiveSelectionBackground": "#e6e6e6",
      "editorLineNumber.foreground": "#9a9a9a",
      "editorLineNumber.activeForeground": "#5c5c5c",
      "editorGutter.background": "#fafafa",
      "editorWidget.background": "#f0f0f0",
      "editorWidget.border": "#c4c4c4",
      "scrollbar.shadow": "#00000000",
      "scrollbarSlider.background": "#c4c4c466",
      "scrollbarSlider.hoverBackground": "#c4c4c499",
      "scrollbarSlider.activeBackground": "#c4c4c4cc",
    },
  });
}

function hasLanguage(monaco: Monaco, id: string): boolean {
  return monaco.languages
    .getLanguages()
    .some((language: { id: string }) => language.id.toLowerCase() === id.toLowerCase());
}

function registerIniLanguage(monaco: Monaco) {
  if (hasLanguage(monaco, "ini")) {
    return;
  }

  monaco.languages.register({
    id: "ini",
    aliases: ["INI", "Properties"],
    extensions: [".ini", ".cfg", ".conf", ".properties"],
  });

  monaco.languages.setLanguageConfiguration("ini", {
    comments: { lineComment: "#" },
  });

  monaco.languages.setMonarchTokensProvider("ini", {
    tokenizer: {
      root: [
        [/^\s*[#;].*$/, "comment"],
        [/\[[^[\]]+\]/, "keyword"],
        [/[A-Za-z0-9_.-]+(?=\s*[=:])/, "type"],
        [/[=:]/, "operator"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/'([^'\\]|\\.)*'/, "string"],
        [/[+-]?\d+(?:\.\d+)?\b/, "number"],
        [/\s+/, ""],
        [/[^\s#;]+/, "string"],
      ],
    },
  });
}

function registerIgnoreLanguage(monaco: Monaco) {
  if (hasLanguage(monaco, "ignore")) {
    return;
  }

  monaco.languages.register({
    id: "ignore",
    aliases: ["Ignore", "Git Ignore"],
    filenames: [
      ".cursorignore",
      ".dockerignore",
      ".eslintignore",
      ".gitattributes",
      ".gitignore",
      ".ignore",
      ".npmignore",
      ".prettierignore",
      ".stylelintignore",
    ],
  });

  monaco.languages.setLanguageConfiguration("ignore", {
    comments: { lineComment: "#" },
  });

  monaco.languages.setMonarchTokensProvider("ignore", {
    tokenizer: {
      root: [
        [/^\s*#.*$/, "comment"],
        [/\s+/, ""],
        [/\[[^\]]+\]/, "regexp"],
        [/\{[^}]+\}/, "regexp"],
        [/\*\*|\*|\?/, "regexp"],
        [/!/, "keyword"],
        [/\\./, "string.escape"],
        [/[\\/]+/, "delimiter"],
        [/[^#!*?{}\[\]\/\\\s]+/, "string"],
      ],
    },
  });
}

function registerDotenvLanguage(monaco: Monaco) {
  if (hasLanguage(monaco, "dotenv")) {
    return;
  }

  monaco.languages.register({
    id: "dotenv",
    aliases: ["Dotenv", ".env"],
    filenames: [".env"],
  });

  monaco.languages.setLanguageConfiguration("dotenv", {
    comments: { lineComment: "#" },
  });

  monaco.languages.setMonarchTokensProvider("dotenv", {
    tokenizer: {
      root: [
        [/^\s*#.*$/, "comment"],
        [/^\s*export\b/, "keyword"],
        [/[A-Za-z_][\w.-]*(?=\s*=)/, "type"],
        [/=/, "operator"],
        [/\$\{?[A-Za-z_][\w]*\}?/, "variable"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/'([^'\\]|\\.)*'/, "string"],
        [/\b(true|false|null)\b/, "keyword"],
        [/[+-]?\d+(?:\.\d+)?\b/, "number"],
        [/\s+/, ""],
        [/[^\s#]+/, "string"],
      ],
    },
  });
}

function registerTomlLanguage(monaco: Monaco) {
  if (hasLanguage(monaco, "toml")) {
    return;
  }

  monaco.languages.register({
    id: "toml",
    aliases: ["TOML"],
    extensions: [".toml"],
  });

  monaco.languages.setLanguageConfiguration("toml", {
    comments: { lineComment: "#" },
  });

  monaco.languages.setMonarchTokensProvider("toml", {
    tokenizer: {
      root: [
        [/^\s*#.*$/, "comment"],
        [/\[[^[\]]+\]/, "keyword"],
        [/[A-Za-z0-9_.-]+(?=\s*=)/, "type"],
        [/=/, "operator"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/'([^'\\]|\\.)*'/, "string"],
        [/\b(true|false)\b/, "keyword"],
        [/[+-]?\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?\b/, "number"],
        [/[{}\[\],]/, "delimiter"],
        [/\s+/, ""],
      ],
    },
  });
}

function registerCesiumLanguages(monaco: Monaco) {
  registerIniLanguage(monaco);
  registerIgnoreLanguage(monaco);
  registerDotenvLanguage(monaco);
  registerTomlLanguage(monaco);
}

function serializeViewState(viewState: unknown): string | null {
  if (viewState == null) {
    return null;
  }
  try {
    return JSON.stringify(viewState);
  } catch {
    return null;
  }
}

export function CodeEditor({
  content,
  language,
  filePath,
  initialViewState,
  onViewStateChange,
  onContentChange,
  onLiveContentChange,
  onSave,
}: CodeEditorProps) {
  const surfaceId = useId().replace(/:/g, "_");
  const { vscodeExtensionsBeta } = useUserPreferences();
  const { activeWorkspaceId } = useWorkspace();
  const editorBridgeRef = useEditorBridgeRef();
  const {
    enabled: hardwareInputEnabled,
    registerSurface,
    unregisterSurface,
    activateSurface,
    deactivateSurface,
  } = useHardwareInput();
  const monacoRef = useRef<Monaco | null>(null);
  const editorInstanceRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(
    null
  );
  const extensionDisposeRef = useRef<(() => void) | null>(null);
  const extensionEditorActionDisposablesRef = useRef<Array<{ dispose: () => void }>>([]);
  const extensionDocPathRef = useRef<string | null>(null);
  const captureRef = useRef<HTMLDivElement | null>(null);
  const isDark = useHtmlDarkClass();
  const monacoTheme = isDark ? "cesium-dark" : "cesium-light";
  const editorLanguage = useMemo(
    () => resolveEditorLanguageId(language, filePath),
    [filePath, language]
  );
  const editorModelPath = useMemo(() => {
    if (!filePath) {
      return undefined;
    }
    const normalized = filePath.replace(/\\/g, "/");
    return encodeURI(`file:///${normalized}`);
  }, [filePath]);
  /** Ephemeral buffer: not written back to workspace state (demo UX only). */
  const [value, setValue] = useState(content);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [editorInstance, setEditorInstance] =
    useState<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const valueRef = useRef(content);
  const onLiveContentChangeRef = useRef(onLiveContentChange);
  const onViewStateChangeRef = useRef(onViewStateChange);
  const onSaveRef = useRef(onSave);
  const handleSaveRef = useRef<() => Promise<void>>(async () => undefined);
  const lastViewStateSignatureRef = useRef<string | null>(
    serializeViewState(initialViewState)
  );
  valueRef.current = value;
  onLiveContentChangeRef.current = onLiveContentChange;
  onViewStateChangeRef.current = onViewStateChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    setValue(content);
    valueRef.current = content;
  }, [content]);

  useEffect(() => {
    onLiveContentChangeRef.current?.(content);
  }, [content]);

  useEffect(() => {
    lastViewStateSignatureRef.current = serializeViewState(initialViewState);
  }, [initialViewState]);

  const onChange = useCallback((v: string | undefined) => {
    const next = v ?? "";
    valueRef.current = next;
    setValue(next);
    onLiveContentChangeRef.current?.(next);
  }, []);

  const emitViewStateChange = useCallback((viewState: unknown) => {
    const handler = onViewStateChangeRef.current;
    if (!handler) {
      return;
    }
    const nextSignature = serializeViewState(viewState);
    if (
      nextSignature !== null &&
      nextSignature === lastViewStateSignatureRef.current
    ) {
      return;
    }
    lastViewStateSignatureRef.current = nextSignature;
    handler(viewState);
  }, []);

  function handleBeforeMount(monaco: Monaco) {
    registerCesiumLanguages(monaco);
    configureTypeScriptWorkspace(monaco);
    defineCesiumThemes(monaco);
    monacoRef.current = monaco;
  }

  useEffect(() => {
    return () => {
      extensionDisposeRef.current?.();
      extensionDisposeRef.current = null;
      for (const disposable of extensionEditorActionDisposablesRef.current) {
        disposable.dispose();
      }
      extensionEditorActionDisposablesRef.current = [];
      monacoRef.current = null;
      editorInstanceRef.current = null;
    };
  }, []);

  useEffect(() => {
    const m = monacoRef.current;
    if (m) m.editor.setTheme(monacoTheme);
  }, [monacoTheme]);

  useEffect(() => {
    if (!onContentChange || value === content) return;
    const timeout = window.setTimeout(() => {
      onContentChange(value);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [content, onContentChange, value]);

  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco || !filePath || !["typescript", "javascript"].includes(editorLanguage)) {
      return;
    }
    updateAmbientBareModuleDeclarations(monaco, value);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void preloadImportModels({
        monaco,
        rootPath: filePath,
        rootContent: value,
        signal: controller.signal,
      }).catch(() => undefined);
    }, 150);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [editorInstance, editorLanguage, filePath, value]);

  useEffect(() => {
    const monaco = monacoRef.current;
    if (!vscodeExtensionsBeta || !monaco || !filePath) {
      extensionDisposeRef.current?.();
      extensionDisposeRef.current = null;
      extensionDocPathRef.current = null;
      return;
    }
    if (extensionDocPathRef.current && extensionDocPathRef.current !== filePath) {
      extensionDisposeRef.current?.();
      extensionDisposeRef.current = null;
      extensionDocPathRef.current = null;
    }
    let cancelled = false;
    void import("@/lib/extensions/editor-service").then((service) => {
      if (cancelled) return;
      if (!extensionDisposeRef.current) {
        extensionDisposeRef.current = service.registerExtensionEditorDocument({
          monaco,
          filePath,
          language: editorLanguage,
          content: value,
        });
        extensionDocPathRef.current = filePath;
        return;
      }
      service.updateExtensionEditorDocument({
        filePath,
        language: editorLanguage,
        content: value,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [editorInstance, editorLanguage, filePath, value, vscodeExtensionsBeta]);

  useEffect(() => {
    if (!vscodeExtensionsBeta || !activeWorkspaceId || !editorInstance || !filePath) {
      for (const disposable of extensionEditorActionDisposablesRef.current) {
        disposable.dispose();
      }
      extensionEditorActionDisposablesRef.current = [];
      return;
    }

    let cancelled = false;
    void fetchInstalledExtensions(activeWorkspaceId)
      .then(({ extensions }) => {
        if (cancelled) return;
        for (const disposable of extensionEditorActionDisposablesRef.current) {
          disposable.dispose();
        }
        extensionEditorActionDisposablesRef.current = [];

        const seen = new Set<string>();
        for (const extension of extensions.filter((candidate) => candidate.enabled)) {
          for (const item of editorContextMenuItems(extension)) {
            if (seen.has(item.command)) continue;
            seen.add(item.command);
            extensionEditorActionDisposablesRef.current.push(
              editorInstance.addAction({
                id: `opencursor.extension.${item.command}`,
                label: item.title,
                contextMenuGroupId: item.groupId,
                contextMenuOrder: item.order,
                run: async (editor) => {
                  const selection = editor.getSelection();
                  const selectedText = selection
                    ? editor.getModel()?.getValueInRange(selection) ?? ""
                    : "";
                  let externalUrls: string[] = [];
                  try {
                    const result = await executeInstalledExtensionCommand({
                      workspaceId: activeWorkspaceId,
                      command: item.command,
                      args: [],
                      editorContext: {
                        uri: `file:///${normalizeWorkspacePath(filePath)}`,
                        path: normalizeWorkspacePath(filePath),
                        language: editorLanguage,
                        content: editor.getModel()?.getValue() ?? valueRef.current,
                        selection,
                        selectedText,
                      },
                    });
                    externalUrls = result.externalUrls ?? [];
                  } catch (error) {
                    if (!item.command.startsWith("cSpell.")) {
                      throw error;
                    }
                  }
                  const monaco = monacoRef.current;
                  if (monaco && item.command === "cSpell.hide") {
                    clearCSpellFallbackMarkers(monaco, editor);
                  }
                  if (
                    monaco &&
                    (item.command === "cSpell.show" ||
                      item.command === "cSpell.suggestSpellingCorrections")
                  ) {
                    applyCSpellFallbackMarkers(monaco, editor);
                  }
                  for (const rawUrl of externalUrls) {
                    try {
                      const url = new URL(rawUrl);
                      if (url.protocol === "http:" || url.protocol === "https:") {
                        void editorBridgeRef.current?.openBrowserTab(url.href, {
                          activate: true,
                          engine: "proxy",
                        });
                      }
                    } catch {
                      // Ignore malformed extension URLs.
                    }
                  }
                },
              })
            );
          }
        }
      })
      .catch(() => {
        if (cancelled) return;
        for (const disposable of extensionEditorActionDisposablesRef.current) {
          disposable.dispose();
        }
        extensionEditorActionDisposablesRef.current = [];
      });

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, editorBridgeRef, editorInstance, editorLanguage, filePath, vscodeExtensionsBeta]);

  const handleSave = useCallback(async () => {
    const save = onSaveRef.current;
    if (!save) return;
    const latestContent = editorInstanceRef.current?.getValue() ?? valueRef.current;
    valueRef.current = latestContent;
    setSaveState("saving");
    try {
      const result = await save(latestContent);
      if (result === false) {
        setSaveState("idle");
        return;
      }
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 1200);
    } catch {
      setSaveState("idle");
    }
  }, []);
  handleSaveRef.current = handleSave;

  const handleMount = useCallback(
    (editorInstance: MonacoEditor.IStandaloneCodeEditor, monaco: Monaco) => {
      monacoRef.current = monaco;
      editorInstanceRef.current = editorInstance;
      setEditorInstance(editorInstance);
      editorInstance.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => {
          void handleSaveRef.current();
        }
      );
      if (initialViewState) {
        editorInstance.restoreViewState(
          initialViewState as MonacoEditor.ICodeEditorViewState
        );
      }
      lastViewStateSignatureRef.current = serializeViewState(
        editorInstance.saveViewState()
      );
    },
    [initialViewState]
  );

  useEffect(() => {
    if (!editorInstance) {
      return;
    }

    let timer: number | null = null;
    const flushViewState = () => {
      emitViewStateChange(editorInstance.saveViewState());
    };
    const scheduleViewState = () => {
      if (timer) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(() => {
        timer = null;
        flushViewState();
      }, 120);
    };

    const disposables = [
      editorInstance.onDidScrollChange(scheduleViewState),
      editorInstance.onDidChangeCursorPosition(scheduleViewState),
      editorInstance.onDidBlurEditorText(() => {
        if (timer) {
          window.clearTimeout(timer);
          timer = null;
        }
        flushViewState();
      }),
    ];

    return () => {
      if (timer) {
        window.clearTimeout(timer);
      }
      flushViewState();
      for (const disposable of disposables) {
        disposable.dispose();
      }
    };
  }, [editorInstance, emitViewStateChange]);

  useEffect(() => {
    if (!hardwareInputEnabled || !editorInstance) {
      unregisterSurface(surfaceId);
      return;
    }

    registerSurface(surfaceId, {
      id: surfaceId,
      kind: "monaco",
      allowWorkbenchShortcuts: true,
      focusTarget: captureRef.current,
      onKeyDown: (event) => handleMonacoHardwareKey(editorInstance, event),
      onPaste: (text) => pasteIntoMonaco(editorInstance, text),
      onCopy: () => getMonacoSelectedText(editorInstance),
      onCut: () => cutMonacoSelectedText(editorInstance),
    });

    return () => unregisterSurface(surfaceId);
  }, [
    editorInstance,
    hardwareInputEnabled,
    registerSurface,
    surfaceId,
    unregisterSurface,
  ]);

  useEffect(() => {
    if (!hardwareInputEnabled || !editorInstance) return;

    const disposable = editorInstance.onDidFocusEditorText(() => {
      const target = captureRef.current;
      if (!target) return;
      try {
        target.focus({ preventScroll: true });
      } catch {
        target.focus();
      }
    });

    return () => disposable.dispose();
  }, [editorInstance, hardwareInputEnabled]);

  return (
    <div
      ref={captureRef}
      className="relative h-full w-full outline-none"
      tabIndex={hardwareInputEnabled ? 0 : -1}
      data-hardware-input-surface={hardwareInputEnabled ? "" : undefined}
      data-hardware-surface-kind={hardwareInputEnabled ? "monaco" : undefined}
      onFocus={() => {
        if (hardwareInputEnabled) {
          activateSurface(surfaceId, captureRef.current);
        }
      }}
      onBlur={() => {
        if (hardwareInputEnabled) {
          deactivateSurface(surfaceId);
        }
      }}
      onPointerDownCapture={(event) => {
        if (!hardwareInputEnabled) return;
        const editor = editorInstanceRef.current;
        const monaco = monacoRef.current;
        if (!editor || !monaco) return;

        activateSurface(surfaceId, captureRef.current);
        void placeMonacoCursorFromClientPoint(
          editor,
          monaco,
          event.clientX,
          event.clientY,
          event.shiftKey
        );
        event.preventDefault();
      }}
    >
      {saveState !== "idle" ? (
        <div className="pointer-events-none absolute right-3 top-3 z-10 rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-2 py-1 font-sans text-[11px] text-[var(--text-secondary)]">
          {saveState === "saving" ? "Saving..." : "Saved"}
        </div>
      ) : null}
      <Editor
        height="100%"
        language={editorLanguage}
        path={editorModelPath}
        value={value}
        onChange={onChange}
        theme={monacoTheme}
        beforeMount={handleBeforeMount}
        onMount={handleMount}
        options={{
          readOnly: false,
          domReadOnly: false,
          fontSize: 14,
          fontFamily: "var(--font-geist-mono), 'Geist Mono', monospace",
          lineNumbers: "on",
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          padding: { top: 12, bottom: 12 },
          renderLineHighlight: "line",
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          overviewRulerBorder: false,
          scrollbar: {
            vertical: "auto",
            horizontal: "auto",
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
          },
          wordWrap: "on",
          automaticLayout: true,
          contextmenu: true,
          links: true,
          folding: true,
          glyphMargin: false,
          occurrencesHighlight: "singleFile",
          selectionHighlight: true,
          cursorBlinking: "blink",
          cursorSmoothCaretAnimation: "off",
          dragAndDrop: true,
          quickSuggestions: true,
          parameterHints: { enabled: true },
          suggestOnTriggerCharacters: true,
          acceptSuggestionOnEnter: "on",
          tabCompletion: "off",
          formatOnPaste: false,
          formatOnType: false,
        }}
      />
    </div>
  );
}
