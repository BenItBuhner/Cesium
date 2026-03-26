"use client";

import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import Editor, { type Monaco } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { useHtmlDarkClass } from "@/hooks/useHtmlDarkClass";

interface CodeEditorProps {
  content: string;
  language: string;
  filePath?: string;
  onContentChange?: (content: string) => void;
  onSave?: (content: string) => Promise<unknown>;
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

export function CodeEditor({
  content,
  language,
  filePath,
  onContentChange,
  onSave,
}: CodeEditorProps) {
  const monacoRef = useRef<Monaco | null>(null);
  const isDark = useHtmlDarkClass();
  const monacoTheme = isDark ? "opencursor-dark" : "opencursor-light";
  const editorLanguage = language === "shell" ? "shell" : language;
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

  useEffect(() => {
    setValue(content);
  }, [content]);

  const onChange = useCallback((v: string | undefined) => {
    setValue(v ?? "");
  }, []);

  function handleBeforeMount(monaco: Monaco) {
    defineOpenCursorThemes(monaco);
    monacoRef.current = monaco;
  }

  useEffect(() => {
    return () => {
      monacoRef.current = null;
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
      editorInstance.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => {
          void handleSave();
        }
      );
    },
    [handleSave]
  );

  return (
    <div className="relative h-full w-full">
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
