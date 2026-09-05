/**
 * Attribute helpers for the XML-ish reference blocks embedded in prompts
 * (`<conversation-reference>`, `<text-reference>`, `<design-capture>`).
 */

export function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/** Parse `key="value"` pairs from a tag's attribute string, decoding entities in values. */
export function parseXmlAttrs(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.\-]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(attrString))) {
    attrs[match[1]!] = decodeXmlEntities(match[2]!);
  }
  return attrs;
}
