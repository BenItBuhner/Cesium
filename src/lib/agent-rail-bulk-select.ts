import type { AgentRailConversationSummary } from "@/lib/agent-types";

export type RailBulkSectionKind = "pinned" | "workspace-root" | "workspace-folder";

export type RailBulkClickModifier = "none" | "shift" | "toggle";

export function getRailConversationKey(
  conversation: AgentRailConversationSummary
): string {
  return conversation.conversationKey ?? conversation.id;
}

export function buildRailBulkSectionId(input: {
  inPinnedSection?: boolean;
  workspaceId: string;
  folderId?: string | null;
}): string {
  if (input.inPinnedSection) {
    return "pinned";
  }
  if (input.folderId) {
    return `ws:${input.workspaceId}:folder:${input.folderId}`;
  }
  return `ws:${input.workspaceId}:root`;
}

export function orderedRailConversationKeys(
  conversations: AgentRailConversationSummary[]
): string[] {
  return conversations.map(getRailConversationKey);
}

export function applyRailBulkClick(input: {
  orderedKeys: readonly string[];
  selectedKeys: ReadonlySet<string>;
  anchorIndex: number | null;
  targetIndex: number;
  modifier: RailBulkClickModifier;
}): { selectedKeys: Set<string>; anchorIndex: number } {
  const { orderedKeys, selectedKeys, anchorIndex, targetIndex, modifier } = input;
  const targetKey = orderedKeys[targetIndex];
  if (!targetKey) {
    return { selectedKeys: new Set(selectedKeys), anchorIndex: anchorIndex ?? targetIndex };
  }

  if (modifier === "shift" && anchorIndex !== null) {
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    const next = new Set(selectedKeys);
    for (let index = start; index <= end; index += 1) {
      const key = orderedKeys[index];
      if (key) {
        next.add(key);
      }
    }
    return { selectedKeys: next, anchorIndex: targetIndex };
  }

  if (modifier === "toggle") {
    const next = new Set(selectedKeys);
    if (next.has(targetKey)) {
      next.delete(targetKey);
    } else {
      next.add(targetKey);
    }
    return { selectedKeys: next, anchorIndex: targetIndex };
  }

  return { selectedKeys: new Set([targetKey]), anchorIndex: targetIndex };
}

export function railBulkClickModifierFromMouseEvent(event: {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}): RailBulkClickModifier {
  if (event.shiftKey) {
    return "shift";
  }
  if (event.metaKey || event.ctrlKey) {
    return "toggle";
  }
  return "none";
}
