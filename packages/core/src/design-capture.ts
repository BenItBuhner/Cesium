/**
 * Shared token/serialization format for browser design-mode captures.
 *
 * Three places speak this:
 *   1. `OpenInEditorContext.applyBrowserDesignCapture` inserts the compact
 *      token (below) into the composer draft and stores the capture metadata
 *      alongside the draft (`draft.captures[captureId]`).
 *   2. `ChatComposer` expands each compact token into a structured
 *      `<design-capture>…</design-capture>` XML block right before submitting
 *      so the LLM sees the full element HTML.
 *   3. `parseUserMessageSegments` in `agent-chat.ts` re-detects the XML blocks
 *      in the historical user message content and re-produces a `design`
 *      segment for `UserMessage.tsx` to render as a pill.
 *
 * The compact composer-side token uses mathematical brackets (U+27E6 / U+27E7)
 * so it cannot collide with ordinary prose, code, or @-chips. The submitted
 * XML block uses a real tag name the agent can read without extra instruction.
 */

import type { UserMessageSegment } from "./types";

export type DesignCaptureKind = "select" | "stroke";

export interface DesignCapture {
  id: string;
  kind: DesignCaptureKind;
  label: string;
  /** Full element outerHTML (truncated) for `select`; annotation caption for `stroke`. */
  snippet?: string;
  caption?: string;
}

/** Composer-side compact token. Never contains user-visible content — the
 *  composer renders it as a pill via `renderComposerText`. */
const OPEN = "\u27E6";
const CLOSE = "\u27E7";

export function makeComposerCaptureToken(captureId: string): string {
  return `${OPEN}design:${captureId}${CLOSE}`;
}

/**
 * Matches a compact composer token. `captureId` is `[A-Za-z0-9_-]+` because
 * the guest script emits ids like `cap-abc123-xyz`.
 */
export const COMPOSER_CAPTURE_TOKEN_REGEX = /\u27E6design:([A-Za-z0-9_-]+)\u27E7/g;

export function findComposerCaptureTokens(text: string): Array<{ start: number; end: number; captureId: string }> {
  const out: Array<{ start: number; end: number; captureId: string }> = [];
  const re = new RegExp(COMPOSER_CAPTURE_TOKEN_REGEX.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      captureId: m[1]!,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Submitted / historical XML block
// ---------------------------------------------------------------------------

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the `<design-capture>…</design-capture>` block that gets sent to the
 * agent and saved in the conversation transcript. The snippet body is embedded
 * verbatim inside a fenced HTML code block so the LLM can quote it directly.
 */
export function buildDesignCaptureBlock(capture: DesignCapture): string {
  const bodyParts: string[] = [];
  if (capture.caption) {
    bodyParts.push(capture.caption);
  }
  if (capture.snippet) {
    bodyParts.push("```html\n" + capture.snippet + "\n```");
  }
  const body = bodyParts.length > 0 ? `\n${bodyParts.join("\n\n")}\n` : "\n";
  return (
    `<design-capture id="${escapeAttr(capture.id)}" ` +
    `kind="${escapeAttr(capture.kind)}" ` +
    `label="${escapeAttr(capture.label)}">` +
    body +
    `</design-capture>`
  );
}

/**
 * Regex for the XML block. Non-greedy body match; `\s\S` so inline newlines
 * are captured. Multiline / multiple captures per message are supported.
 */
export const DESIGN_CAPTURE_BLOCK_REGEX =
  /<design-capture\s+([^>]*)>([\s\S]*?)<\/design-capture>/g;

function parseAttrs(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.\-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrString))) {
    attrs[m[1]!] = decodeHtmlEntities(m[2]!);
  }
  return attrs;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/** Stripped snippet body for tooltip display — drops the surrounding fence. */
export function extractSnippetFromBlockBody(body: string): string | undefined {
  const fence = body.match(/```html\n([\s\S]*?)\n```/);
  return fence ? fence[1] : undefined;
}

/**
 * Tokenize a piece of user-turn content into a mix of `text` and `design`
 * segments. Plain text between blocks is preserved as `text` segments.
 * Returns `null` if no design blocks are present (caller can fall back to
 * other parsers like the @-chip parser).
 */
export function splitContentByDesignBlocks(content: string): UserMessageSegment[] | null {
  const re = new RegExp(DESIGN_CAPTURE_BLOCK_REGEX.source, "g");
  const out: UserMessageSegment[] = [];
  let lastIndex = 0;
  let saw = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    saw = true;
    const start = m.index;
    const end = start + m[0].length;
    if (start > lastIndex) {
      out.push({ type: "text", text: content.slice(lastIndex, start) });
    }
    const attrs = parseAttrs(m[1] ?? "");
    const snippet = extractSnippetFromBlockBody(m[2] ?? "");
    const captureId = attrs.id || "";
    const kindRaw = attrs.kind;
    const kind: DesignCaptureKind = kindRaw === "stroke" ? "stroke" : "select";
    const label = attrs.label || "element";
    out.push({
      type: "design",
      text: label,
      captureId,
      captureKind: kind,
      captureSnippet: snippet,
    });
    lastIndex = end;
  }
  if (!saw) return null;
  if (lastIndex < content.length) {
    out.push({ type: "text", text: content.slice(lastIndex) });
  }
  return out.filter((seg) => seg.type !== "text" || seg.text.length > 0);
}
