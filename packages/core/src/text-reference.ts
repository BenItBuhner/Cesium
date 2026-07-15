import type { UserMessageSegment } from "./types";

export interface TextReference {
  id: string;
  label: string;
  text: string;
  charCount: number;
}

const OPEN = "\u27E6";
const CLOSE = "\u27E7";

export const LONG_PASTE_REFERENCE_THRESHOLD_CHARS = 10_000;

export function makeComposerTextReferenceToken(referenceId: string): string {
  return `${OPEN}textref:${referenceId}${CLOSE}`;
}

export const COMPOSER_TEXT_REFERENCE_TOKEN_REGEX =
  /\u27E6textref:([A-Za-z0-9_-]+)\u27E7/g;

export function findComposerTextReferenceTokens(
  text: string
): Array<{ start: number; end: number; referenceId: string }> {
  const out: Array<{ start: number; end: number; referenceId: string }> = [];
  const re = new RegExp(COMPOSER_TEXT_REFERENCE_TOKEN_REGEX.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    out.push({
      start: match.index,
      end: match.index + match[0].length,
      referenceId: match[1]!,
    });
  }
  return out;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function parseAttrs(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.\-]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(attrString))) {
    attrs[match[1]!] = decodeHtmlEntities(match[2]!);
  }
  return attrs;
}

export function buildTextReferenceBlock(reference: TextReference): string {
  return (
    `<text-reference id="${escapeAttr(reference.id)}" ` +
    `label="${escapeAttr(reference.label)}" ` +
    `chars="${reference.charCount}">\n` +
    "```text\n" +
    reference.text +
    "\n```\n" +
    "</text-reference>"
  );
}

export const TEXT_REFERENCE_BLOCK_REGEX =
  /<text-reference\s+([^>]*)>([\s\S]*?)<\/text-reference>/g;

function extractTextFromBlockBody(body: string): string | undefined {
  const fence = body.match(/```text\n([\s\S]*?)\n```/);
  return fence ? fence[1] : body.trim() || undefined;
}

export function splitContentByTextReferenceBlocks(
  content: string
): UserMessageSegment[] | null {
  const re = new RegExp(TEXT_REFERENCE_BLOCK_REGEX.source, "g");
  const out: UserMessageSegment[] = [];
  let lastIndex = 0;
  let saw = false;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content))) {
    saw = true;
    const start = match.index;
    const end = start + match[0].length;
    if (start > lastIndex) {
      out.push({ type: "text", text: content.slice(lastIndex, start) });
    }
    const attrs = parseAttrs(match[1] ?? "");
    const fullText = extractTextFromBlockBody(match[2] ?? "");
    out.push({
      type: "text-reference",
      text: attrs.label || "Pasted text",
      referenceId: attrs.id || "",
      referenceCharCount: Number.parseInt(attrs.chars || "", 10) || fullText?.length,
      referenceText: fullText,
    });
    lastIndex = end;
  }
  if (!saw) return null;
  if (lastIndex < content.length) {
    out.push({ type: "text", text: content.slice(lastIndex) });
  }
  return out.filter((segment) => segment.type !== "text" || segment.text.length > 0);
}
