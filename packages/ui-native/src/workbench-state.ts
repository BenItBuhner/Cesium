import type {
  AgentConversationRecord,
  AgentSocketServerMessage,
  AgentStoredEvent,
  FileNode,
} from "@cesium/core";

export type ConversationFeedState = {
  conversation: AgentConversationRecord | null;
  events: AgentStoredEvent[];
};

export type VisibleFileRow = {
  depth: number;
  node: FileNode;
  path: string;
};

export function dedupeAgentEvents(events: AgentStoredEvent[]): AgentStoredEvent[] {
  const bySequence = new Map<number, AgentStoredEvent>();
  for (const event of events) {
    bySequence.set(event.seq, event);
  }
  return [...bySequence.values()].sort((left, right) => left.seq - right.seq);
}

export function reduceConversationFeed(
  state: ConversationFeedState,
  message: AgentSocketServerMessage,
  conversationId: string
): ConversationFeedState {
  switch (message.type) {
    case "conversation":
    case "conversation_upserted":
      return message.conversation.id === conversationId
        ? { ...state, conversation: message.conversation }
        : state;
    case "snapshot":
    case "snapshot_head":
      return message.snapshot.conversation.id === conversationId
        ? {
            conversation: message.snapshot.conversation,
            events: dedupeAgentEvents([...state.events, ...message.snapshot.events]),
          }
        : state;
    case "event":
      return message.conversationId === conversationId
        ? { ...state, events: dedupeAgentEvents([...state.events, message.event]) }
        : state;
    case "event_batch":
      return message.conversationId === conversationId
        ? { ...state, events: dedupeAgentEvents([...state.events, ...message.events]) }
        : state;
    case "conversation_deleted":
      return message.conversationId === conversationId
        ? { conversation: null, events: [] }
        : state;
    default:
      return state;
  }
}

export function joinWorkspacePath(parentPath: string, name: string): string {
  return parentPath ? `${parentPath}/${name}` : name;
}

export function flattenVisibleFileTree(
  nodes: FileNode[] | undefined,
  expandedPaths: ReadonlySet<string>,
  parentPath = "",
  depth = 0
): VisibleFileRow[] {
  if (!nodes) {
    return [];
  }
  const rows: VisibleFileRow[] = [];
  for (const node of nodes) {
    const path = joinWorkspacePath(parentPath, node.name);
    rows.push({ depth, node, path });
    if (node.type === "folder" && expandedPaths.has(path)) {
      rows.push(...flattenVisibleFileTree(node.children, expandedPaths, path, depth + 1));
    }
  }
  return rows;
}
