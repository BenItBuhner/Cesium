/**
 * Attribute carried by design-capture pill spans inside the contenteditable.
 * The value is the raw compact token text (`⟦design:<id>⟧`) so
 * {@link getComposerPlainText} and friends can reconstitute the original string
 * without walking the pill's inner UI DOM.
 */
const DESIGN_TOKEN_ATTR = "data-design-token";

/**
 * Walk the container DOM in document order, reconstructing the plain-text
 * string the composer's React state tracks. Text nodes contribute their raw
 * text; pill spans contribute the stored compact token; `<br>` contributes a
 * newline. `block` elements (divs inserted by Enter key / paste) add a newline
 * *between* siblings, matching `innerText`'s behavior.
 */
function walkComposerPlainText(container: HTMLElement): string {
  const parts: string[] = [];
  const recurse = (node: Node, atStartOfBlock: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const token = el.getAttribute(DESIGN_TOKEN_ATTR);
    if (token) {
      parts.push(token);
      return;
    }
    if (el.tagName === "BR") {
      parts.push("\n");
      return;
    }
    const isBlock =
      el.tagName === "DIV" ||
      el.tagName === "P" ||
      el.tagName === "LI";
    if (isBlock && !atStartOfBlock) {
      parts.push("\n");
    }
    const children = el.childNodes;
    for (let i = 0; i < children.length; i += 1) {
      recurse(children[i]!, i === 0);
    }
  };
  const children = container.childNodes;
  for (let i = 0; i < children.length; i += 1) {
    recurse(children[i]!, i === 0);
  }
  return parts.join("").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function getComposerPlainText(container: HTMLElement): string {
  return walkComposerPlainText(container);
}

/**
 * Walk to a specific (node, offset) and return the running plain-text offset
 * at that position. Identical accounting to {@link walkComposerPlainText} so
 * caret math stays aligned with the text the composer state holds.
 */
function plainTextOffsetAt(
  container: HTMLElement,
  target: Node,
  targetOffset: number
): number {
  let acc = 0;
  let found = false;

  const recurse = (node: Node, atStartOfBlock: boolean): void => {
    if (found) return;

    if (node === target) {
      if (node.nodeType === Node.TEXT_NODE) {
        acc += Math.min(targetOffset, node.textContent?.length ?? 0);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        const children = el.childNodes;
        const limit = Math.min(targetOffset, children.length);
        for (let i = 0; i < limit; i += 1) {
          recurse(children[i]!, i === 0);
          if (found) return;
        }
      }
      found = true;
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      acc += node.textContent?.length ?? 0;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const token = el.getAttribute(DESIGN_TOKEN_ATTR);
    if (token) {
      acc += token.length;
      return;
    }
    if (el.tagName === "BR") {
      acc += 1;
      return;
    }
    const isBlock =
      el.tagName === "DIV" || el.tagName === "P" || el.tagName === "LI";
    if (isBlock && !atStartOfBlock) {
      acc += 1;
    }
    const children = el.childNodes;
    for (let i = 0; i < children.length; i += 1) {
      recurse(children[i]!, i === 0);
      if (found) return;
    }
  };

  const children = container.childNodes;
  for (let i = 0; i < children.length; i += 1) {
    recurse(children[i]!, i === 0);
    if (found) break;
  }
  return acc;
}

/** Character offset of the caret inside `container`. Pill spans count as the
 * length of their stored token. */
export function getCaretOffset(container: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return 0;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return 0;
  return plainTextOffsetAt(container, range.endContainer, range.endOffset);
}

export function getPlainTextRangeOffsets(
  container: HTMLElement
): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const start = plainTextOffsetAt(container, range.startContainer, range.startOffset);
  const end = plainTextOffsetAt(container, range.endContainer, range.endOffset);
  return start <= end ? { start, end } : { start: end, end: start };
}

export function setCaretOffset(container: HTMLElement, offset: number): void {
  const total = walkComposerPlainText(container).length;
  const safe = Math.max(0, Math.min(offset, total));
  const range = document.createRange();
  const sel = window.getSelection();
  let remaining = safe;

  // Walk the same DOM tree in the same order as plain-text accounting so we
  // can place the caret on the corresponding text node or beside a pill span.
  const place = (parent: Node, afterNode: Node | null) => {
    if (afterNode) {
      range.setStartAfter(afterNode);
    } else {
      range.setStart(parent, 0);
    }
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  let placed = false;
  const recurse = (node: Node, atStartOfBlock: boolean): void => {
    if (placed) return;

    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent?.length ?? 0;
      if (remaining <= len) {
        range.setStart(node, remaining);
        range.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(range);
        placed = true;
        return;
      }
      remaining -= len;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const token = el.getAttribute(DESIGN_TOKEN_ATTR);
    if (token) {
      const len = token.length;
      if (remaining <= 0) {
        place(el.parentNode!, el.previousSibling);
        placed = true;
        return;
      }
      if (remaining < len) {
        // Caret falls inside the pill — snap to the nearest edge.
        place(el.parentNode!, el);
        placed = true;
        return;
      }
      remaining -= len;
      return;
    }
    if (el.tagName === "BR") {
      if (remaining <= 0) {
        place(el.parentNode!, el.previousSibling);
        placed = true;
        return;
      }
      remaining -= 1;
      return;
    }
    const isBlock =
      el.tagName === "DIV" || el.tagName === "P" || el.tagName === "LI";
    if (isBlock && !atStartOfBlock) {
      if (remaining <= 0) {
        place(el.parentNode!, el.previousSibling);
        placed = true;
        return;
      }
      remaining -= 1;
    }
    const children = el.childNodes;
    for (let i = 0; i < children.length; i += 1) {
      recurse(children[i]!, i === 0);
      if (placed) return;
    }
  };

  if (!container.firstChild) {
    container.appendChild(document.createTextNode(""));
  }
  const children = container.childNodes;
  for (let i = 0; i < children.length; i += 1) {
    recurse(children[i]!, i === 0);
    if (placed) return;
  }
  // Fallback: end of container.
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
  // The mutation wipes any pill spans that sat inside (start, end); the
  // reconciler in ChatComposer will restore them on the next effect pass when
  // React state catches up.
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }
  appendTextWithBrBreaks(container, next);
  setCaretOffset(container, start + insert.length);
}

// ---------------------------------------------------------------------------
// Pill reconciliation
// ---------------------------------------------------------------------------

const DESIGN_TOKEN_OPEN = "\u27E6";
const DESIGN_TOKEN_CLOSE = "\u27E7";
const DESIGN_TOKEN_PATTERN = /\u27E6design:([A-Za-z0-9_-]+)\u27E7/g;

export interface ComposerPillDescriptor {
  captureId: string;
  label: string;
  snippet?: string;
}

/**
 * True if the container's DOM already matches `value` *and* has a pill span
 * in each token slot. We use this as a cheap guard so the reconciler doesn't
 * churn the DOM (and blow away the user's caret) on every keystroke.
 */
export function composerEditorDomInSync(
  container: HTMLElement,
  value: string
): boolean {
  if (walkComposerPlainText(container) !== value) return false;
  const pillSpans = container.querySelectorAll(`[${DESIGN_TOKEN_ATTR}]`);
  let i = 0;
  const expected: string[] = [];
  DESIGN_TOKEN_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DESIGN_TOKEN_PATTERN.exec(value))) {
    expected.push(`${DESIGN_TOKEN_OPEN}design:${m[1]!}${DESIGN_TOKEN_CLOSE}`);
  }
  if (pillSpans.length !== expected.length) return false;
  for (i = 0; i < pillSpans.length; i += 1) {
    if (pillSpans[i]!.getAttribute(DESIGN_TOKEN_ATTR) !== expected[i]) {
      return false;
    }
  }
  return true;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function appendTextWithBrBreaks(parent: HTMLElement | DocumentFragment, text: string): void {
  if (!text) return;
  const segments = text.split("\n");
  for (let i = 0; i < segments.length; i += 1) {
    if (i > 0) parent.appendChild(document.createElement("br"));
    if (segments[i]!.length > 0) {
      parent.appendChild(document.createTextNode(segments[i]!));
    }
  }
}

/** Pill span HTML. Kept in one place so the composer and the design pill in
 *  user messages stay visually aligned. */
function buildPillSpan(token: string, pill: ComposerPillDescriptor | undefined): HTMLSpanElement {
  const span = document.createElement("span");
  span.setAttribute(DESIGN_TOKEN_ATTR, token);
  span.setAttribute("contenteditable", "false");
  span.setAttribute("data-design-capture-id", pill?.captureId ?? "");
  span.className =
    "opencursor-design-pill mx-[2px] inline-flex max-w-full items-center gap-[4px] " +
    "rounded-[6px] border border-[var(--border-subtle)] bg-[var(--file-tag-bg)] " +
    "px-[7px] py-[1px] align-baseline font-sans text-[12.5px] font-medium " +
    "whitespace-nowrap select-none cursor-default " +
    (pill ? "text-[var(--file-tag-text)]" : "text-[var(--text-secondary)] italic");
  if (pill?.snippet) {
    const title = `${pill.label}\n\n${pill.snippet.slice(0, 600)}${
      pill.snippet.length > 600 ? "…" : ""
    }`;
    span.setAttribute("title", title);
  } else if (pill?.label) {
    span.setAttribute("title", pill.label);
  }
  const iconSvg =
    '<svg class="size-[12px] shrink-0" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect width="18" height="7" x="3" y="3" rx="1"/>' +
    '<rect width="9" height="7" x="3" y="14" rx="1"/>' +
    '<rect width="5" height="7" x="16" y="14" rx="1"/>' +
    "</svg>";
  const label = escapeHtml(pill?.label ?? "missing capture");
  span.innerHTML = `${iconSvg}<span class="max-w-[240px] truncate">${label}</span>`;
  return span;
}

/**
 * Rebuild the contenteditable's children from `value`, replacing each
 * `⟦design:<id>⟧` token with a pill span. Preserves caret position by
 * measuring before and restoring after.
 */
export function reconcileComposerEditorDom(
  container: HTMLElement,
  value: string,
  pills: Record<string, ComposerPillDescriptor> | undefined
): void {
  const caretOffset = document.activeElement === container ? getCaretOffset(container) : null;

  // Build the new children detached, then swap in one shot to avoid visible
  // flashes and to keep MutationObservers calm.
  const frag = document.createDocumentFragment();
  let cursor = 0;
  DESIGN_TOKEN_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DESIGN_TOKEN_PATTERN.exec(value))) {
    const start = m.index;
    const end = start + m[0].length;
    if (start > cursor) {
      appendTextWithBrBreaks(frag, value.slice(cursor, start));
    }
    frag.appendChild(buildPillSpan(m[0], pills?.[m[1]!]));
    cursor = end;
  }
  if (cursor < value.length) {
    appendTextWithBrBreaks(frag, value.slice(cursor));
  }
  if (!frag.hasChildNodes()) {
    frag.appendChild(document.createTextNode(""));
  }

  // Swap children.
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }
  container.appendChild(frag);

  if (caretOffset != null) {
    setCaretOffset(container, caretOffset);
  }
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
