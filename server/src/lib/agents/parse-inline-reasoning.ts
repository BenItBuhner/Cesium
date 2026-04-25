export type InlineReasoningBlock = {
  text: string;
  raw: string;
};

export type ExtractInlineReasoningResult = {
  reasoning: InlineReasoningBlock[];
  text: string;
};

export type ExtractInlineReasoningOptions = {
  /**
   * When true (default), strips leading/trailing newlines after tag extraction.
   * Set false for streamed deltas: newlines at chunk boundaries are semantic for Markdown.
   */
  normalizeEdges?: boolean;
};

const XML_REASONING_RE =
  /<(?:thinking|reason|thought|reflection|mindset)\b[^>]*>([\s\S]*?)<\/(?:thinking|reason|thought|reflection|mindset)\s*>/gi;

const ATTR_RE = /\btype\s*=\s*(["'])(.*?)\1/i;

export function extractInlineReasoning(
  input: string,
  options?: ExtractInlineReasoningOptions
): ExtractInlineReasoningResult {
  const normalizeEdges = options?.normalizeEdges ?? true;
  const reasoning: InlineReasoningBlock[] = [];
  let text = input;

  text = text.replace(XML_REASONING_RE, (match, innerContent: string) => {
    const attrType = ATTR_RE.exec(match)?.[2]?.trim();
    if (attrType === "tool" || attrType === "tool_call") {
      return match;
    }

    const trimmed = innerContent.trim();
    if (trimmed) {
      reasoning.push({ text: trimmed, raw: match });
    }
    return "\n";
  });

  if (normalizeEdges) {
    text = text.replace(/^\n+/, "").replace(/\n+$/, "");
  }
  text = text.replace(/\n{3,}/g, "\n\n");

  return { reasoning, text };
}
