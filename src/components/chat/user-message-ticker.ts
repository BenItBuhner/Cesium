import type { ChatMessage } from "@/lib/types";

export type UserMessageTickerItem = {
  id: string;
  preview: string;
  ordinal: number;
};

const PREVIEW_MAX_LENGTH = 280;
export const USER_MESSAGE_TICKER_MARKER_WIDTH_PX = 10;
export const USER_MESSAGE_TICKER_MARKER_MAX_WIDTH_PX = 24;
export const USER_MESSAGE_TICKER_MARKER_PITCH_PX = 5;
export const USER_MESSAGE_TICKER_MIN_RAIL_HEIGHT_PX = 24;
export const USER_MESSAGE_TICKER_MAX_RAIL_HEIGHT_PX = 360;
export const USER_MESSAGE_TICKER_HOVER_RADIUS_PX = 22;

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

export function userMessageTickerRailHeight(itemCount: number): number {
  if (itemCount <= 0) {
    return 0;
  }
  return Math.min(
    USER_MESSAGE_TICKER_MAX_RAIL_HEIGHT_PX,
    Math.max(
      USER_MESSAGE_TICKER_MIN_RAIL_HEIGHT_PX,
      itemCount * USER_MESSAGE_TICKER_MARKER_PITCH_PX
    )
  );
}

export function userMessageTickerMarkerCenter(
  index: number,
  itemCount: number,
  railHeight: number
): number {
  if (itemCount <= 0 || railHeight <= 0) {
    return 0;
  }
  return ((Math.max(0, Math.min(itemCount - 1, index)) + 0.5) / itemCount) * railHeight;
}

export function nearestUserMessageTickerIndex(
  pointerY: number,
  itemCount: number,
  railHeight: number
): number | null {
  if (itemCount <= 0 || railHeight <= 0 || !Number.isFinite(pointerY)) {
    return null;
  }
  const clampedY = Math.max(0, Math.min(railHeight - Number.EPSILON, pointerY));
  return Math.min(itemCount - 1, Math.floor((clampedY / railHeight) * itemCount));
}

export function userMessageTickerHoverWidth(
  markerCenterY: number,
  pointerY: number | null
): number {
  if (pointerY == null || !Number.isFinite(pointerY)) {
    return USER_MESSAGE_TICKER_MARKER_WIDTH_PX;
  }
  const distance = Math.abs(markerCenterY - pointerY);
  if (distance >= USER_MESSAGE_TICKER_HOVER_RADIUS_PX) {
    return USER_MESSAGE_TICKER_MARKER_WIDTH_PX;
  }
  const proximity = 1 - distance / USER_MESSAGE_TICKER_HOVER_RADIUS_PX;
  const easedProximity = 0.5 - Math.cos(Math.PI * proximity) / 2;
  return (
    USER_MESSAGE_TICKER_MARKER_WIDTH_PX +
    (USER_MESSAGE_TICKER_MARKER_MAX_WIDTH_PX -
      USER_MESSAGE_TICKER_MARKER_WIDTH_PX) *
      easedProximity
  );
}
