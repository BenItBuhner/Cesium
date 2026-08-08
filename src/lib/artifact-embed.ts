/**
 * Inline artifact embeds: assistant replies place `[[artifact:<id>]]` (or an
 * `<artifact id="…"/>` tag) on its own line to render a live artifact card in
 * the conversation. Matching is line-based so it stays streaming-safe — only a
 * fully received tag line renders as an embed.
 */

const DOUBLE_BRACKET_PATTERN = /^\[\[artifact:([a-z0-9][a-z0-9-]{0,80})\]\]$/i;
const XML_TAG_PATTERN = /^<artifact\s+id=["']([a-z0-9][a-z0-9-]{0,80})["']\s*\/?>(?:<\/artifact>)?$/i;

/** Returns the artifact id when a trimmed line is exactly an artifact embed tag. */
export function matchArtifactEmbedLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const doubleBracket = DOUBLE_BRACKET_PATTERN.exec(trimmed);
  if (doubleBracket) {
    return doubleBracket[1].toLowerCase();
  }
  const xmlTag = XML_TAG_PATTERN.exec(trimmed);
  if (xmlTag) {
    return xmlTag[1].toLowerCase();
  }
  return null;
}

export function buildArtifactEmbedTag(artifactId: string): string {
  return `[[artifact:${artifactId}]]`;
}
