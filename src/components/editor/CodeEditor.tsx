"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import Editor, { type Monaco } from "@monaco-editor/react";
import { useHtmlDarkClass } from "@/hooks/useHtmlDarkClass";

interface CodeEditorProps {
  content: string;
  language: string;
}

function defineOpenCursorThemes(monaco: Monaco) {
  monaco.editor.defineTheme("opencursor-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "5b5b5b", fontStyle: "italic" },
      { token: "keyword", foreground: "ffffff" },
      { token: "string", foreground: "a5d6a7" },
      { token: "number", foreground: "f4a261" },
      { token: "type", foreground: "80cbc4" },
    ],
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
    rules: [
      { token: "comment", foreground: "8a8a8a", fontStyle: "italic" },
      { token: "keyword", foreground: "1a1a1a" },
      { token: "string", foreground: "2d6a3a" },
      { token: "number", foreground: "b85c1c" },
      { token: "type", foreground: "00695c" },
    ],
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

export function CodeEditor({ content, language }: CodeEditorProps) {
  const monacoRef = useRef<Monaco | null>(null);
  const isDark = useHtmlDarkClass();
  const monacoTheme = isDark ? "opencursor-dark" : "opencursor-light";
  const editorLanguage = language === "shell" ? "shell" : language;
  /** Ephemeral buffer: not written back to workspace state (demo UX only). */
  const [value, setValue] = useState(content);

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

  return (
    <div className="h-full w-full">
      <Editor
        height="100%"
        language={editorLanguage}
        value={value}
        onChange={onChange}
        theme={monacoTheme}
        beforeMount={handleBeforeMount}
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
