import type { UserMessageSegment } from "./types";
import { escapeXmlAttr, parseXmlAttrs } from "./xml-attrs";

/**
 * Composer-taggable reference to another saved conversation. Tagging inserts a
 * compact `⟦conv:<id>⟧` pill token; on submit the token expands into a
 * `<conversation-reference>` XML block so first-party Cesium agents can pull
 * the transcript with the conversation tools (list / read / search).
 */
export interface ConversationReference {
  id: string;
  title: string;
  workspaceId?: string;
  workspaceName?: string;
}

const OPEN = "\u27E6";
const CLOSE = "\u27E7";

export function makeComposerConversationReferenceToken(conversationId: string): string {
  return `${OPEN}conv:${conversationId}${CLOSE}`;
}

export const COMPOSER_CONVERSATION_REFERENCE_TOKEN_REGEX =
  /\u27E6conv:([A-Za-z0-9_-]+)\u27E7/g;

export function findComposerConversationReferenceTokens(
  text: string
): Array<{ start: number; end: number; conversationId: string }> {
  const out: Array<{ start: number; end: number; conversationId: string }> = [];
  const re = new RegExp(COMPOSER_CONVERSATION_REFERENCE_TOKEN_REGEX.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    out.push({
      start: match.index,
      end: match.index + match[0].length,
      conversationId: match[1]!,
    });
  }
  return out;
}

export function buildConversationReferenceBlock(reference: ConversationReference): string {
  const workspaceAttrs =
    (reference.workspaceId ? ` workspace-id="${escapeXmlAttr(reference.workspaceId)}"` : "") +
    (reference.workspaceName ? ` workspace-name="${escapeXmlAttr(reference.workspaceName)}"` : "");
  return (
    `<conversation-reference id="${escapeXmlAttr(reference.id)}" ` +
    `title="${escapeXmlAttr(reference.title)}"${workspaceAttrs}>` +
    "The user tagged this saved conversation as context. Use read_conversation with this id " +
    "(or search_conversations / list_conversations) to pull the relevant parts of its transcript; " +
    "related conversations may hold useful context too." +
    "</conversation-reference>"
  );
}

export const CONVERSATION_REFERENCE_BLOCK_REGEX =
  /<conversation-reference\s+([^>]*)>([\s\S]*?)<\/conversation-reference>/g;

export function splitContentByConversationReferenceBlocks(
  content: string
): UserMessageSegment[] | null {
  const re = new RegExp(CONVERSATION_REFERENCE_BLOCK_REGEX.source, "g");
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
    const attrs = parseXmlAttrs(match[1] ?? "");
    out.push({
      type: "conversation",
      text: attrs.title || "Conversation",
      conversationId: attrs.id || "",
      conversationWorkspaceName: attrs["workspace-name"] || undefined,
    });
    lastIndex = end;
  }
  if (!saw) return null;
  if (lastIndex < content.length) {
    out.push({ type: "text", text: content.slice(lastIndex) });
  }
  return out.filter((segment) => segment.type !== "text" || segment.text.length > 0);
}
