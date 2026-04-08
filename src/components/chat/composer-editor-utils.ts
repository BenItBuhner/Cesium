/**
 * Plain text for the chat composer contenteditable. Prefer over `textContent`:
 * browsers represent soft line breaks with `<br>` / block nodes — `textContent` merges those
 * into a single line and drops structure.
 */
export function getComposerPlainText(container: HTMLElement): string {
  const raw =
    typeof container.innerText === "string"
      ? container.innerText
      : (container.textContent ?? "");
  return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Character offset of the caret inside `container` (text-only contenteditable). */
export function getCaretOffset(container: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return 0;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return 0;
  const pre = document.createRange();
  pre.selectNodeContents(container);
  pre.setEnd(range.endContainer, range.endOffset);
  return pre.toString().length;
}

export function setCaretOffset(container: HTMLElement, offset: number): void {
  const text = getComposerPlainText(container);
  const safe = Math.max(0, Math.min(offset, text.length));
  const range = document.createRange();
  const sel = window.getSelection();
  let remaining = safe;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  if (!node) {
    if (!container.firstChild) container.appendChild(document.createTextNode(""));
    node = container.firstChild as Text;
  }
  while (node) {
    const len = node.textContent?.length ?? 0;
    if (remaining <= len) {
      range.setStart(node, remaining);
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
      return;
    }
    remaining -= len;
    node = walker.nextNode() as Text | null;
  }
  range.selectNodeContents(container);
  range.collapse(false);
  sel?.removeAllRanges();
  sel?.addRange(range);
}

export function replaceTextRange(
  container: HTMLElement,
  start: number,
  end: number,
  insert: string
): void {
  const full = getComposerPlainText(container);
  const next = full.slice(0, start) + insert + full.slice(end);
  container.textContent = next;
  setCaretOffset(container, start + insert.length);
}

/** `@query` or `/query` token ending at `cursor`, with char offsets into plain text. */
export function parseTriggerToken(
  text: string,
  cursor: number
): { kind: "at" | "slash"; query: string; start: number; end: number } | null {
  let i = cursor;
  while (i > 0 && !/[\s\n]/.test(text[i - 1]!)) i--;
  const token = text.slice(i, cursor);
  if (token.startsWith("@")) {
    return { kind: "at", query: token.slice(1), start: i, end: cursor };
  }
  if (token.startsWith("/")) {
    return { kind: "slash", query: token.slice(1), start: i, end: cursor };
  }
  return null;
}

/** When we cannot measure the caret, place a rect at the end of the first line (not the top of the box). */
function caretFallbackRect(container: HTMLElement): DOMRect {
  const br = container.getBoundingClientRect();
  const lineH = 20;
  const top = Math.max(br.top, br.bottom - lineH);
  return new DOMRect(br.left + 2, top, 0, lineH);
}

/** Best-effort caret screen position for anchoring a popover. */
export function getCaretClientRect(container: HTMLElement): DOMRect | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return null;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(true);
  if (!container.contains(range.commonAncestorContainer)) return null;

  let rect = range.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) {
    return rect;
  }

  const marker = document.createElement("span");
  marker.appendChild(document.createTextNode("\u200b"));
  try {
    range.insertNode(marker);
  } catch {
    return caretFallbackRect(container);
  }
  rect = marker.getBoundingClientRect();
  marker.parentNode?.removeChild(marker);
  container.normalize();

  if (rect.width > 0 || rect.height > 0) {
    return rect;
  }
  return caretFallbackRect(container);
}
