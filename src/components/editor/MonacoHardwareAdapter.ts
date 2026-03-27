import type { Monaco } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";

function trigger(
  editor: MonacoEditor.IStandaloneCodeEditor,
  command: string,
  payload: unknown = null
) {
  editor.trigger("hardware-ipad", command, payload);
}

function getContextKeyValue(
  editor: MonacoEditor.IStandaloneCodeEditor,
  key: string
): boolean {
  const maybeEditor = editor as MonacoEditor.IStandaloneCodeEditor & {
    _contextKeyService?: {
      getContextKeyValue?: (name: string) => unknown;
    };
  };

  return Boolean(maybeEditor._contextKeyService?.getContextKeyValue?.(key));
}

export function handleMonacoHardwareKey(
  editor: MonacoEditor.IStandaloneCodeEditor,
  event: KeyboardEvent
): boolean {
  const key = event.key;
  const lower = key.toLowerCase();
  const mod = event.metaKey || event.ctrlKey;

  if (mod && lower === "a") {
    event.preventDefault();
    trigger(editor, "selectAll");
    return true;
  }
  if (mod && lower === "z" && event.shiftKey) {
    event.preventDefault();
    trigger(editor, "redo");
    return true;
  }
  if (mod && lower === "z") {
    event.preventDefault();
    trigger(editor, "undo");
    return true;
  }
  if (mod && lower === "y") {
    event.preventDefault();
    trigger(editor, "redo");
    return true;
  }
  if (mod && lower === "f") {
    event.preventDefault();
    trigger(editor, "actions.find");
    return true;
  }

  if (key === "Escape") {
    event.preventDefault();
    trigger(editor, "hideSuggestWidget");
    return true;
  }
  if (key === "Backspace") {
    event.preventDefault();
    trigger(editor, "deleteLeft");
    return true;
  }
  if (key === "Delete") {
    event.preventDefault();
    trigger(editor, "deleteRight");
    return true;
  }
  if (key === "Enter") {
    event.preventDefault();
    if (getContextKeyValue(editor, "suggestWidgetVisible")) {
      trigger(editor, "acceptSelectedSuggestion");
    } else {
      trigger(editor, "type", { text: "\n" });
    }
    return true;
  }
  if (key === "Tab") {
    event.preventDefault();
    if (!event.shiftKey && getContextKeyValue(editor, "suggestWidgetVisible")) {
      trigger(editor, "acceptSelectedSuggestion");
    } else {
      trigger(
        editor,
        event.shiftKey
          ? "editor.action.outdentLines"
          : "editor.action.indentLines"
      );
    }
    return true;
  }

  if (key === "ArrowLeft") {
    event.preventDefault();
    trigger(editor, event.shiftKey ? "cursorLeftSelect" : "cursorLeft");
    return true;
  }
  if (key === "ArrowRight") {
    event.preventDefault();
    trigger(editor, event.shiftKey ? "cursorRightSelect" : "cursorRight");
    return true;
  }
  if (key === "ArrowUp") {
    event.preventDefault();
    trigger(editor, event.shiftKey ? "cursorUpSelect" : "cursorUp");
    return true;
  }
  if (key === "ArrowDown") {
    event.preventDefault();
    trigger(editor, event.shiftKey ? "cursorDownSelect" : "cursorDown");
    return true;
  }
  if (key === "Home") {
    event.preventDefault();
    trigger(editor, event.shiftKey ? "cursorHomeSelect" : "cursorHome");
    return true;
  }
  if (key === "End") {
    event.preventDefault();
    trigger(editor, event.shiftKey ? "cursorEndSelect" : "cursorEnd");
    return true;
  }

  if (key.length === 1 && !event.metaKey && !event.ctrlKey) {
    event.preventDefault();
    trigger(editor, "type", { text: key });
    return true;
  }

  return false;
}

export function placeMonacoCursorFromClientPoint(
  editor: MonacoEditor.IStandaloneCodeEditor,
  monaco: Monaco,
  clientX: number,
  clientY: number,
  extendSelection: boolean
): boolean {
  const target = editor.getTargetAtClientPoint(clientX, clientY);
  const position = target?.position;
  if (!position) return false;

  if (extendSelection) {
    const selection = editor.getSelection();
    if (selection) {
      editor.setSelection(
        new monaco.Selection(
          selection.selectionStartLineNumber,
          selection.selectionStartColumn,
          position.lineNumber,
          position.column
        )
      );
    } else {
      editor.setPosition(position);
    }
  } else {
    editor.setPosition(position);
  }

  editor.revealPositionInCenterIfOutsideViewport(position);
  return true;
}

export function getMonacoSelectedText(
  editor: MonacoEditor.IStandaloneCodeEditor
): string | null {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection || selection.isEmpty()) return null;
  return model.getValueInRange(selection);
}

export function cutMonacoSelectedText(
  editor: MonacoEditor.IStandaloneCodeEditor
): string | null {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection || selection.isEmpty()) return null;

  const selected = model.getValueInRange(selection);
  editor.executeEdits("hardware-ipad-cut", [
    {
      range: selection,
      text: "",
      forceMoveMarkers: true,
    },
  ]);
  return selected;
}

export function pasteIntoMonaco(
  editor: MonacoEditor.IStandaloneCodeEditor,
  text: string
): boolean {
  trigger(editor, "type", { text });
  return true;
}
