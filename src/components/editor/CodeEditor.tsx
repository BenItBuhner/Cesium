"use client";

import { useRef, useEffect, useState, useCallback, useMemo, useId } from "react";
import Editor, { type Monaco } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { useHardwareInput } from "@/components/input/HardwareInputProvider";
import { useHtmlDarkClass } from "@/hooks/useHtmlDarkClass";
import {
  cutMonacoSelectedText,
  getMonacoSelectedText,
  handleMonacoHardwareKey,
  pasteIntoMonaco,
  placeMonacoCursorFromClientPoint,
} from "@/components/editor/MonacoHardwareAdapter";
import { resolveEditorLanguageId } from "@/lib/editor-language";
import { readFile } from "@/lib/server-api";

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

let monacoTypeScriptConfigured = false;

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

function extractLocalImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(IMPORT_SPECIFIER_RE)) {
    const specifier = (match[1] ?? match[2] ?? "").trim();
    if (specifier.startsWith(".") || specifier.startsWith("@/")) {
      specifiers.add(specifier);
    }
  }
  return [...specifiers];
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
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
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
  monacoTypeScriptConfigured = true;
}

async function readFirstExistingImportCandidate(
  candidates: string[]
): Promise<{ path: string; content: string; language: string } | null> {
  for (const candidate of candidates) {
    try {
      const result = await readFile(candidate, { full: true });
      if (result.fileKind === "image" || result.content.length > MAX_IMPORT_PRELOAD_BYTES) {
        continue;
      }
      return {
        path: candidate,
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
      const resolved = await readFirstExistingImportCandidate(
        candidatePathsForImport(current.path, specifier)
      );
      if (!resolved || seen.has(resolved.path)) {
        continue;
      }
      seen.add(resolved.path);
      loaded += 1;
      const uri = input.monaco.Uri.parse(workspacePathToModelUri(resolved.path));
      const existing = input.monaco.editor.getModel(uri);
      if (existing) {
        if (existing.getValue() !== resolved.content) {
          existing.setValue(resolved.content);
        }
      } else {
        input.monaco.editor.createModel(resolved.content, resolved.language, uri);
      }
      queue.push({
        path: resolved.path,
        content: resolved.content,
        depth: current.depth + 1,
      });
    }
  }
}

function defineOpenCursorThemes(monaco: Monaco) {
  monaco.editor.defineTheme("opencursor-dark", {
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

  monaco.editor.defineTheme("opencursor-light", {
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

function registerOpenCursorLanguages(monaco: Monaco) {
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
  const captureRef = useRef<HTMLDivElement | null>(null);
  const isDark = useHtmlDarkClass();
  const monacoTheme = isDark ? "opencursor-dark" : "opencursor-light";
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
  const onLiveContentChangeRef = useRef(onLiveContentChange);
  const onViewStateChangeRef = useRef(onViewStateChange);
  const lastViewStateSignatureRef = useRef<string | null>(
    serializeViewState(initialViewState)
  );
  onLiveContentChangeRef.current = onLiveContentChange;
  onViewStateChangeRef.current = onViewStateChange;

  useEffect(() => {
    setValue(content);
  }, [content]);

  useEffect(() => {
    onLiveContentChangeRef.current?.(content);
  }, [content]);

  useEffect(() => {
    lastViewStateSignatureRef.current = serializeViewState(initialViewState);
  }, [initialViewState]);

  const onChange = useCallback((v: string | undefined) => {
    const next = v ?? "";
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
    registerOpenCursorLanguages(monaco);
    configureTypeScriptWorkspace(monaco);
    defineOpenCursorThemes(monaco);
    monacoRef.current = monaco;
  }

  useEffect(() => {
    return () => {
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
  }, [editorLanguage, filePath, value]);

  const handleSave = useCallback(async () => {
    if (!onSave) return;
    setSaveState("saving");
    await onSave(value);
    setSaveState("saved");
    window.setTimeout(() => setSaveState("idle"), 1200);
  }, [onSave, value]);

  const handleMount = useCallback(
    (editorInstance: MonacoEditor.IStandaloneCodeEditor, monaco: Monaco) => {
      monacoRef.current = monaco;
      editorInstanceRef.current = editorInstance;
      setEditorInstance(editorInstance);
      editorInstance.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => {
          void handleSave();
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
    [handleSave, initialViewState]
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
