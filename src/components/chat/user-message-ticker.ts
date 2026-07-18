import type { ChatMessage } from "@/lib/types";

export type UserMessageTickerItem = {
  id: string;
  preview: string;
  ordinal: number;
};

const PREVIEW_MAX_LENGTH = 280;

function normalizePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function visibleSegmentText(message: ChatMessage): string {
  return (message.segments ?? [])
    .map((segment) => segment.text)
    .filter(Boolean)
    .join(" ");
}

export function userMessagePreview(message: ChatMessage): string {
  const content =
    normalizePreview(message.content ?? "") ||
    normalizePreview(visibleSegmentText(message)) ||
    normalizePreview(message.rawContent ?? "");
  const fallback =
    message.attachments?.length === 1
      ? "Image attachment"
      : message.attachments?.length
        ? `${message.attachments.length} image attachments`
        : "User message";

  if (!content) {
    return fallback;
  }
  if (content.length <= PREVIEW_MAX_LENGTH) {
    return content;
  }
  return `${content.slice(0, PREVIEW_MAX_LENGTH - 1).trimEnd()}…`;
}

export function buildUserMessageTickerItems(
  messages: ChatMessage[]
): UserMessageTickerItem[] {
  const items: UserMessageTickerItem[] = [];
  for (const message of messages) {
    if (message.type !== "user") {
      continue;
    }
    items.push({
      id: message.id,
      preview: userMessagePreview(message),
      ordinal: items.length + 1,
    });
  }
  return items;
}

export function userMessageTickerMarkerWidth(preview: string): number {
  return Math.max(8, Math.min(20, Math.round(7 + Math.sqrt(preview.length) * 0.85)));
}
