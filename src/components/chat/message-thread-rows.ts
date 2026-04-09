import type { ChatMessage } from "@/lib/types";

export type MessageThreadRow =
  | {
      kind: "user_todo";
      key: string;
      userIndex: number;
      todoIndex: number;
      stackOrder: number;
    }
  | { kind: "user"; key: string; index: number; stackOrder: number }
  | { kind: "message"; key: string; index: number };

export function buildMessageThreadRows(messages: ChatMessage[]): MessageThreadRow[] {
  const rows: MessageThreadRow[] = [];
  let userStickyStack = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    const next = messages[i + 1];
    if (!msg) {
      continue;
    }
    if (msg.type === "user" && next?.type === "todo-status") {
      rows.push({
        kind: "user_todo",
        key: `${msg.id}-${next.id}`,
        userIndex: i,
        todoIndex: i + 1,
        stackOrder: userStickyStack++,
      });
      i += 1;
      continue;
    }
    if (msg.type === "user") {
      rows.push({
        kind: "user",
        key: msg.id,
        index: i,
        stackOrder: userStickyStack++,
      });
      continue;
    }
    rows.push({ kind: "message", key: msg.id, index: i });
  }
  return rows;
}
