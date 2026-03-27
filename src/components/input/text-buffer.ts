export type TextSelection = {
  start: number;
  end: number;
};

export type TextBufferEditResult = {
  value: string;
  selection: TextSelection;
};

export type TextBufferKeyResult = TextBufferEditResult & {
  handled: boolean;
};

export function clampSelection(
  value: string,
  selection: TextSelection
): TextSelection {
  const max = value.length;
  const start = Math.max(0, Math.min(selection.start, max));
  const end = Math.max(0, Math.min(selection.end, max));
  return start <= end ? { start, end } : { start: end, end: start };
}

export function hasSelection(selection: TextSelection): boolean {
  return selection.start !== selection.end;
}

export function getSelectedText(
  value: string,
  selection: TextSelection
): string {
  const safe = clampSelection(value, selection);
  return value.slice(safe.start, safe.end);
}

export function collapseSelectionToStart(
  value: string,
  selection: TextSelection
): TextSelection {
  const safe = clampSelection(value, selection);
  return { start: safe.start, end: safe.start };
}

export function collapseSelectionToEnd(
  value: string,
  selection: TextSelection
): TextSelection {
  const safe = clampSelection(value, selection);
  return { start: safe.end, end: safe.end };
}

export function replaceSelection(
  value: string,
  selection: TextSelection,
  insert: string
): TextBufferEditResult {
  const safe = clampSelection(value, selection);
  const nextValue =
    value.slice(0, safe.start) + insert + value.slice(safe.end);
  const nextCaret = safe.start + insert.length;
  return {
    value: nextValue,
    selection: { start: nextCaret, end: nextCaret },
  };
}

export function selectAll(value: string): TextSelection {
  return { start: 0, end: value.length };
}

function getLineStart(value: string, index: number): number {
  return value.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
}

function getLineEnd(value: string, index: number): number {
  const nextBreak = value.indexOf("\n", index);
  return nextBreak === -1 ? value.length : nextBreak;
}

function moveCaretHorizontally(
  value: string,
  selection: TextSelection,
  direction: -1 | 1,
  extend: boolean
): TextSelection {
  const safe = clampSelection(value, selection);

  if (!extend && hasSelection(safe)) {
    return direction < 0
      ? collapseSelectionToStart(value, safe)
      : collapseSelectionToEnd(value, safe);
  }

  const anchor = extend ? safe.start : null;
  const focus = direction < 0 ? safe.end - 1 : safe.end + 1;
  const clamped = Math.max(0, Math.min(value.length, focus));
  if (!extend || anchor == null) {
    return { start: clamped, end: clamped };
  }
  return clampSelection(value, { start: anchor, end: clamped });
}

function moveCaretToBoundary(
  value: string,
  selection: TextSelection,
  boundary: "start" | "end",
  extend: boolean
): TextSelection {
  const safe = clampSelection(value, selection);

  if (!extend && hasSelection(safe)) {
    return boundary === "start"
      ? collapseSelectionToStart(value, safe)
      : collapseSelectionToEnd(value, safe);
  }

  const focusIndex = safe.end;
  const next =
    boundary === "start"
      ? getLineStart(value, focusIndex)
      : getLineEnd(value, focusIndex);

  if (!extend) {
    return { start: next, end: next };
  }

  return clampSelection(value, { start: safe.start, end: next });
}

function moveCaretVertically(
  value: string,
  selection: TextSelection,
  direction: -1 | 1,
  extend: boolean
): TextSelection {
  const safe = clampSelection(value, selection);

  if (!extend && hasSelection(safe)) {
    return direction < 0
      ? collapseSelectionToStart(value, safe)
      : collapseSelectionToEnd(value, safe);
  }

  const focus = safe.end;
  const lineStart = getLineStart(value, focus);
  const lineEnd = getLineEnd(value, focus);
  const column = focus - lineStart;

  let next = focus;
  if (direction < 0) {
    if (lineStart === 0) {
      next = 0;
    } else {
      const prevLineEnd = lineStart - 1;
      const prevLineStart = getLineStart(value, prevLineEnd);
      next = Math.min(prevLineStart + column, prevLineEnd);
    }
  } else if (lineEnd === value.length) {
    next = value.length;
  } else {
    const nextLineStart = lineEnd + 1;
    const nextLineEnd = getLineEnd(value, nextLineStart);
    next = Math.min(nextLineStart + column, nextLineEnd);
  }

  if (!extend) {
    return { start: next, end: next };
  }

  return clampSelection(value, { start: safe.start, end: next });
}

export function applyTextBufferKey(
  value: string,
  selection: TextSelection,
  event: KeyboardEvent,
  options?: { multiline?: boolean }
): TextBufferKeyResult {
  const multiline = options?.multiline === true;
  const safe = clampSelection(value, selection);
  const mod = event.metaKey || event.ctrlKey;

  if (mod && event.key.toLowerCase() === "a") {
    return {
      handled: true,
      value,
      selection: selectAll(value),
    };
  }

  if (event.key === "Backspace") {
    if (hasSelection(safe)) {
      const next = replaceSelection(value, safe, "");
      return { handled: true, ...next };
    }
    if (safe.end === 0) {
      return { handled: true, value, selection: safe };
    }
    const deletionStart = safe.end - 1;
    return {
      handled: true,
      value: value.slice(0, deletionStart) + value.slice(safe.end),
      selection: { start: deletionStart, end: deletionStart },
    };
  }

  if (event.key === "Delete") {
    if (hasSelection(safe)) {
      const next = replaceSelection(value, safe, "");
      return { handled: true, ...next };
    }
    if (safe.end === value.length) {
      return { handled: true, value, selection: safe };
    }
    return {
      handled: true,
      value: value.slice(0, safe.end) + value.slice(safe.end + 1),
      selection: { start: safe.end, end: safe.end },
    };
  }

  if (event.key === "ArrowLeft") {
    return {
      handled: true,
      value,
      selection: moveCaretHorizontally(
        value,
        safe,
        -1,
        event.shiftKey
      ),
    };
  }

  if (event.key === "ArrowRight") {
    return {
      handled: true,
      value,
      selection: moveCaretHorizontally(
        value,
        safe,
        1,
        event.shiftKey
      ),
    };
  }

  if (event.key === "Home") {
    return {
      handled: true,
      value,
      selection: moveCaretToBoundary(
        value,
        safe,
        "start",
        event.shiftKey
      ),
    };
  }

  if (event.key === "End") {
    return {
      handled: true,
      value,
      selection: moveCaretToBoundary(
        value,
        safe,
        "end",
        event.shiftKey
      ),
    };
  }

  if (multiline && event.key === "ArrowUp") {
    return {
      handled: true,
      value,
      selection: moveCaretVertically(
        value,
        safe,
        -1,
        event.shiftKey
      ),
    };
  }

  if (multiline && event.key === "ArrowDown") {
    return {
      handled: true,
      value,
      selection: moveCaretVertically(
        value,
        safe,
        1,
        event.shiftKey
      ),
    };
  }

  if (event.key === "Enter") {
    if (!multiline) {
      return { handled: false, value, selection: safe };
    }
    const next = replaceSelection(value, safe, "\n");
    return { handled: true, ...next };
  }

  if (multiline && event.key === "Tab" && !mod) {
    const next = replaceSelection(value, safe, "\t");
    return { handled: true, ...next };
  }

  if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
    const next = replaceSelection(value, safe, event.key);
    return { handled: true, ...next };
  }

  return { handled: false, value, selection: safe };
}
