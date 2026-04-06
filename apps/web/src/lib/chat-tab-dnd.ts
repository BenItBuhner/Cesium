export const CHAT_TAB_DND_MIME = "application/x-opencursor-chat-tab";

export function parseChatTabDragPayload(raw: string): { tabId: string } | null {
  try {
    const parsed = JSON.parse(raw) as { tabId?: string };
    if (parsed?.tabId && typeof parsed.tabId === "string") {
      return { tabId: parsed.tabId };
    }
  } catch {
    /* ignore */
  }
  return null;
}
