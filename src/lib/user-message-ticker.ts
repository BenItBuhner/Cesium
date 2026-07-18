import type { ChatMessage, UserMessageSegment } from "@/lib/types";
import { stripAgentTodoJsonAssistantContent } from "@/lib/agent-chat";
import { buildMessageThreadSegments } from "@/components/chat/message-thread-rows";
import {
  contentTopOfElementInScrollRoot,
  selectorForChatMessageId,
} from "@/lib/chat-scroll-anchor";

export const USER_MESSAGE_TICKER_MIN_TURNS = 2;
export const USER_MESSAGE_TICKER_PREVIEW_CHARS = 110;

export type UserMessageTickerAttachmentChip = {
  kind: "image" | "file" | "context" | "design" | "text-reference";
  label: string;
};

export type UserMessageTickerItem = {
  messageId: string;
  segmentIndex: number;
  userPreview: string;
  assistantPreview: string | null;
  attachments: UserMessageTickerAttachmentChip[];
};

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Strip light markdown / HTML noise for compact hover previews. */
export function plainTextForTickerPreview(raw: string): string {
  return collapseWhitespace(
    raw
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
      .replace(/<\/?[^>]+>/g, " ")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^>\s+/gm, "")
      .replace(/[*_~]+/g, "")
  );
}

export function truncateTickerText(
  text: string,
  maxChars = USER_MESSAGE_TICKER_PREVIEW_CHARS
): string {
  const cleaned = collapseWhitespace(text);
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  return `${cleaned.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function userMessagePreviewText(message: ChatMessage): string {
  if (message.type !== "user") {
    return "";
  }
  if (message.segments && message.segments.length > 0) {
    const fromSegments = message.segments
      .filter((segment): segment is UserMessageSegment & { type: "text" } => segment.type === "text")
      .map((segment) => segment.text)
      .join("");
    const cleaned = collapseWhitespace(fromSegments);
    if (cleaned) {
      return cleaned;
    }
  }
  return collapseWhitespace(message.rawContent ?? message.content ?? "");
}

function segmentAttachmentChips(
  segments: UserMessageSegment[] | undefined
): UserMessageTickerAttachmentChip[] {
  if (!segments?.length) {
    return [];
  }
  const chips: UserMessageTickerAttachmentChip[] = [];
  for (const segment of segments) {
    if (segment.type === "text") {
      continue;
    }
    const label = collapseWhitespace(segment.text) || segment.type;
    if (segment.type === "image") {
      chips.push({ kind: "image", label });
    } else if (segment.type === "file") {
      chips.push({ kind: "file", label });
    } else if (segment.type === "context") {
      chips.push({ kind: "context", label });
    } else if (segment.type === "design") {
      chips.push({ kind: "design", label });
    } else if (segment.type === "text-reference") {
      chips.push({ kind: "text-reference", label });
    }
  }
  return chips;
}

function imageAttachmentChips(
  message: ChatMessage
): UserMessageTickerAttachmentChip[] {
  if (!message.attachments?.length) {
    return [];
  }
  return message.attachments.map((attachment, index) => ({
    kind: "image" as const,
    label: collapseWhitespace(attachment.name ?? "") || `Image ${index + 1}`,
  }));
}

function assistantPreviewForTurn(
  messages: ChatMessage[],
  userIndex: number,
  tailIndices: number[]
): string | null {
  let lastAssistant: ChatMessage | null = null;
  for (const index of tailIndices) {
    const message = messages[index];
    if (message?.type === "assistant") {
      lastAssistant = message;
    }
  }
  if (!lastAssistant) {
    for (let i = userIndex + 1; i < messages.length; i += 1) {
      const message = messages[i];
      if (!message || message.type === "user") {
        break;
      }
      if (message.type === "assistant") {
        lastAssistant = message;
      }
    }
  }
  if (!lastAssistant) {
    return null;
  }
  const cleaned = plainTextForTickerPreview(
    stripAgentTodoJsonAssistantContent(lastAssistant.content ?? "")
  );
  return cleaned || null;
}

/**
 * One ticker tick per loaded user turn (chronological, oldest first).
 * Only reflects currently paged-in messages — older turns appear as history loads.
 */
export function buildUserMessageTickerItems(
  messages: ChatMessage[]
): UserMessageTickerItem[] {
  const segments = buildMessageThreadSegments(messages);
  const items: UserMessageTickerItem[] = [];

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    if (!segment || segment.type !== "turn") {
      continue;
    }
    const userMessage = messages[segment.userIndex];
    if (!userMessage || userMessage.type !== "user") {
      continue;
    }
    const userPreview = truncateTickerText(userMessagePreviewText(userMessage));
    if (!userPreview && !userMessage.attachments?.length && !userMessage.segments?.length) {
      continue;
    }
    const attachmentMap = new Map<string, UserMessageTickerAttachmentChip>();
    for (const chip of [
      ...imageAttachmentChips(userMessage),
      ...segmentAttachmentChips(userMessage.segments),
    ]) {
      const key = `${chip.kind}:${chip.label}`;
      if (!attachmentMap.has(key)) {
        attachmentMap.set(key, chip);
      }
    }
    const assistantRaw = assistantPreviewForTurn(
      messages,
      segment.userIndex,
      segment.tailIndices
    );
    items.push({
      messageId: userMessage.id,
      segmentIndex,
      userPreview: userPreview || "User message",
      assistantPreview: assistantRaw ? truncateTickerText(assistantRaw) : null,
      attachments: [...attachmentMap.values()].slice(0, 4),
    });
  }

  return items;
}

export function shouldShowUserMessageTicker(itemCount: number): boolean {
  return itemCount >= USER_MESSAGE_TICKER_MIN_TURNS;
}

/** Prefer the newest user turn whose sticky root is at or above the viewport rail. */
export function findActiveTickerMessageId(
  scrollRoot: HTMLElement,
  orderedMessageIds: string[],
  railInsetPx: number
): string | null {
  const scrollTop = scrollRoot.scrollTop;
  const anchor = scrollTop + railInsetPx + 0.75;
  let best: { id: string; top: number } | null = null;

  for (const id of orderedMessageIds) {
    const el = scrollRoot.querySelector(selectorForChatMessageId(id));
    if (!el) {
      continue;
    }
    const top = contentTopOfElementInScrollRoot(el, scrollRoot);
    if (top <= anchor) {
      if (!best || top >= best.top) {
        best = { id, top };
      }
    }
  }

  if (best) {
    return best.id;
  }

  // Virtualized gaps: no sticky/user row in the DOM yet — approximate from scroll progress.
  if (orderedMessageIds.length === 0) {
    return null;
  }
  const maxScroll = Math.max(1, scrollRoot.scrollHeight - scrollRoot.clientHeight);
  const progress = Math.min(1, Math.max(0, scrollRoot.scrollTop / maxScroll));
  const approxIndex = Math.min(
    orderedMessageIds.length - 1,
    Math.round(progress * (orderedMessageIds.length - 1))
  );
  return orderedMessageIds[approxIndex] ?? null;
}
