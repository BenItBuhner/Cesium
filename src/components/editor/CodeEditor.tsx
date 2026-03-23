"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import Editor, { type Monaco } from "@monaco-editor/react";

interface CodeEditorProps {
  content: string;
  language: string;
  /** Output-style pane (e.g. bash tab): no line numbers, terminal-like density. Still editable (demo only, not persisted). */
  terminal?: boolean;
}

function defineOpenCursorTheme(monaco: Monaco) {
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
}

export function CodeEditor({ content, language, terminal }: CodeEditorProps) {
  const monacoRef = useRef<Monaco | null>(null);
  const isTerminal = terminal === true;
  /** Ephemeral buffer: not written back to workspace state (demo UX only). */
  const [value, setValue] = useState(content);

  useEffect(() => {
    setValue(content);
  }, [content]);

  const onChange = useCallback((v: string | undefined) => {
    setValue(v ?? "");
  }, []);

  function handleBeforeMount(monaco: Monaco) {
    defineOpenCursorTheme(monaco);
    monacoRef.current = monaco;
  }

  useEffect(() => {
    return () => {
      monacoRef.current = null;
    };
  }, []);

  return (
    <div className="h-full w-full">
      <Editor
        height="100%"
        language={language === "shell" ? "shell" : language}
        value={value}
        onChange={onChange}
        theme="opencursor-dark"
        beforeMount={handleBeforeMount}
        options={{
          readOnly: false,
          domReadOnly: false,
          fontSize: 14,
          fontFamily: "var(--font-geist-mono), 'Geist Mono', monospace",
          lineNumbers: isTerminal ? "off" : "on",
          ...(isTerminal ? { lineNumbersMinChars: 0, lineDecorationsWidth: 0 } : {}),
          minimap: { enabled: false },
          scrollBeyondLastLine: isTerminal,
          padding: { top: 12, bottom: 12 },
          renderLineHighlight: isTerminal ? "none" : "line",
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
          folding: !isTerminal,
          glyphMargin: false,
          occurrencesHighlight: isTerminal ? "off" : "singleFile",
          selectionHighlight: true,
          cursorBlinking: "blink",
          cursorSmoothCaretAnimation: "off",
          dragAndDrop: true,
          quickSuggestions: !isTerminal,
          parameterHints: { enabled: !isTerminal },
          suggestOnTriggerCharacters: !isTerminal,
          acceptSuggestionOnEnter: !isTerminal ? "on" : "off",
          tabCompletion: "off",
          formatOnPaste: false,
          formatOnType: false,
        }}
      />
    </div>
  );
}
