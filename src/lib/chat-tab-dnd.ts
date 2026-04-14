export const CHAT_TAB_DND_MIME = "application/x-opencursor-chat-tab";

export type ChatTabDragPayload = {
  tabId: string;
  title?: string;
  workspaceId?: string;
};

export function parseChatTabDragPayload(raw: string): ChatTabDragPayload | null {
  try {
    const parsed = JSON.parse(raw) as {
      tabId?: string;
      title?: string;
      workspaceId?: string;
    };
    if (parsed?.tabId && typeof parsed.tabId === "string") {
      return {
        tabId: parsed.tabId,
        title: typeof parsed.title === "string" ? parsed.title : undefined,
        workspaceId:
          typeof parsed.workspaceId === "string" ? parsed.workspaceId : undefined,
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}
