import type { ChatFolderState } from "@/lib/global-settings";

/** Synthetic folder scope for standalone (no-workspace) chats in the Chats rail section. */
export const STANDALONE_CHATS_FOLDER_SCOPE = "__agentStandaloneChats__";

export type ChatFolderPlacement = "before" | "after";

export function isStandaloneChatFolderScope(scopeId: string): boolean {
  return scopeId === STANDALONE_CHATS_FOLDER_SCOPE;
}

export function compareConversationsByRecency<T extends { updatedAt: number; title: string }>(
  a: T,
  b: T
): number {
  return b.updatedAt - a.updatedAt || a.title.localeCompare(b.title);
}

export function getChatFoldersForScope(
  folders: ChatFolderState[],
  scopeId: string
): ChatFolderState[] {
  return folders
    .filter((folder) => folder.workspaceId === scopeId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/** Order conversations by an explicit id list; unknown ids append by recency. */
export function orderConversationsByIds<T extends { id: string; updatedAt: number; title: string }>(
  conversations: T[],
  orderedIds: readonly string[] | undefined
): T[] {
  if (!orderedIds || orderedIds.length === 0) {
    return [...conversations].sort(compareConversationsByRecency);
  }
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const id of orderedIds) {
    const conversation = byId.get(id);
    if (!conversation || seen.has(id)) {
      continue;
    }
    ordered.push(conversation);
    seen.add(id);
  }
  const rest = conversations
    .filter((conversation) => !seen.has(conversation.id))
    .sort(compareConversationsByRecency);
  return [...ordered, ...rest];
}

export function partitionConversationsByFolders<
  T extends { id: string; updatedAt: number; title: string },
>(
  conversations: T[],
  folders: ChatFolderState[],
  rootOrderIds: readonly string[] | undefined
): {
  folderConversations: Map<string, T[]>;
  rootConversations: T[];
  folderIdByConversationId: Map<string, string>;
} {
  const folderIdByConversationId = new Map<string, string>();
  for (const folder of folders) {
    for (const conversationId of folder.conversationIds) {
      if (!folderIdByConversationId.has(conversationId)) {
        folderIdByConversationId.set(conversationId, folder.id);
      }
    }
  }

  const conversationsById = new Map(
    conversations.map((conversation) => [conversation.id, conversation])
  );
  const folderConversations = new Map<string, T[]>();
  for (const folder of folders) {
    const items = folder.conversationIds
      .map((conversationId) => conversationsById.get(conversationId))
      .filter((conversation): conversation is T => Boolean(conversation));
    folderConversations.set(folder.id, items);
  }

  const rootConversations = orderConversationsByIds(
    conversations.filter((conversation) => !folderIdByConversationId.has(conversation.id)),
    rootOrderIds
  );

  return { folderConversations, rootConversations, folderIdByConversationId };
}

export function placeIdAmongIds(
  ids: readonly string[],
  sourceId: string,
  targetId: string | null | undefined,
  placement: ChatFolderPlacement = "after"
): string[] {
  const withoutSource = ids.filter((id) => id !== sourceId);
  if (!targetId || targetId === sourceId) {
    return [...withoutSource, sourceId];
  }
  const targetIndex = withoutSource.indexOf(targetId);
  if (targetIndex < 0) {
    return [...withoutSource, sourceId];
  }
  const insertIndex = targetIndex + (placement === "after" ? 1 : 0);
  const next = [...withoutSource];
  next.splice(insertIndex, 0, sourceId);
  return next;
}

export function createChatFolderState(input: {
  id: string;
  scopeId: string;
  existingFolders: ChatFolderState[];
  conversationId?: string;
  name?: string;
  color?: string;
  icon?: string;
}): ChatFolderState {
  const sortOrder =
    input.existingFolders.reduce((max, folder) => Math.max(max, folder.sortOrder), -1) + 1;
  return {
    id: input.id,
    workspaceId: input.scopeId,
    name: input.name?.trim().slice(0, 80) || "New folder",
    color: input.color ?? "#7c3aed",
    icon: input.icon ?? "Folder",
    sortOrder,
    conversationIds: input.conversationId ? [input.conversationId] : [],
  };
}

export function upsertChatFoldersWithNewFolder(
  folders: ChatFolderState[],
  nextFolder: ChatFolderState,
  conversationId?: string
): ChatFolderState[] {
  const scopeId = nextFolder.workspaceId;
  const cleared = folders.map((folder) => {
    if (folder.workspaceId !== scopeId || !conversationId) {
      return folder;
    }
    return {
      ...folder,
      conversationIds: folder.conversationIds.filter((id) => id !== conversationId),
    };
  });
  return [...cleared, nextFolder];
}

export function moveConversationInChatFolders(
  folders: ChatFolderState[],
  input: {
    scopeId: string;
    conversationId: string;
    folderId: string | null;
    targetConversationId?: string | null;
    placement?: ChatFolderPlacement;
  }
): ChatFolderState[] {
  const { scopeId, conversationId, folderId } = input;
  const placement = input.placement ?? "after";
  return folders.map((folder) => {
    if (folder.workspaceId !== scopeId) {
      return folder;
    }
    const withoutConversation = folder.conversationIds.filter((id) => id !== conversationId);
    if (folder.id !== folderId) {
      return {
        ...folder,
        conversationIds: withoutConversation,
      };
    }
    return {
      ...folder,
      conversationIds: placeIdAmongIds(
        withoutConversation,
        conversationId,
        input.targetConversationId,
        placement
      ),
    };
  });
}

export function updateRootOrderForMove(
  rootOrderByScope: Record<string, string[]>,
  input: {
    scopeId: string;
    conversationId: string;
    /** null folder => conversation is at root */
    folderId: string | null;
    targetConversationId?: string | null;
    placement?: ChatFolderPlacement;
    knownRootIds: readonly string[];
  }
): Record<string, string[]> {
  const previous = rootOrderByScope[input.scopeId] ?? [];
  const known = new Set(input.knownRootIds);
  // Seed from known root ids so first custom reorder preserves current visual order.
  const seeded =
    previous.length === 0
      ? [...input.knownRootIds]
      : [
          ...previous.filter((id) => known.has(id) || id === input.conversationId),
          ...input.knownRootIds.filter((id) => !previous.includes(id)),
        ];

  if (input.folderId !== null) {
    const nextForScope = seeded.filter((id) => id !== input.conversationId);
    if (nextForScope.length === 0) {
      const { [input.scopeId]: _removed, ...rest } = rootOrderByScope;
      return rest;
    }
    return {
      ...rootOrderByScope,
      [input.scopeId]: nextForScope,
    };
  }

  const withoutSource = seeded.filter((id) => id !== input.conversationId);
  const nextForScope = placeIdAmongIds(
    withoutSource,
    input.conversationId,
    input.targetConversationId,
    input.placement ?? "after"
  );
  return {
    ...rootOrderByScope,
    [input.scopeId]: nextForScope,
  };
}

export function reorderChatFolders(
  folders: ChatFolderState[],
  input: {
    scopeId: string;
    sourceFolderId: string;
    targetFolderId: string;
    placement: ChatFolderPlacement;
  }
): ChatFolderState[] {
  const scoped = getChatFoldersForScope(folders, input.scopeId);
  const scopedIds = scoped.map((folder) => folder.id);
  if (
    !scopedIds.includes(input.sourceFolderId) ||
    !scopedIds.includes(input.targetFolderId) ||
    input.sourceFolderId === input.targetFolderId
  ) {
    return folders;
  }
  const nextScopedIds = placeIdAmongIds(
    scopedIds,
    input.sourceFolderId,
    input.targetFolderId,
    input.placement
  );
  const sortOrderById = new Map(nextScopedIds.map((id, index) => [id, index]));
  return folders.map((folder) => {
    if (folder.workspaceId !== input.scopeId) {
      return folder;
    }
    const sortOrder = sortOrderById.get(folder.id);
    return typeof sortOrder === "number" ? { ...folder, sortOrder } : folder;
  });
}
