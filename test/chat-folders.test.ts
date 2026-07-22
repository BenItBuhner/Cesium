import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  STANDALONE_CHATS_FOLDER_SCOPE,
  createChatFolderState,
  getChatFoldersForScope,
  moveConversationInChatFolders,
  orderConversationsByIds,
  partitionConversationsByFolders,
  placeIdAmongIds,
  reorderChatFolders,
  updateRootOrderForMove,
  upsertChatFoldersWithNewFolder,
} from "../src/lib/chat-folders.ts";
import {
  createDefaultGlobalSettings,
  normalizeLoadedGlobalSettings,
  type ChatFolderState,
} from "../src/lib/global-settings.ts";

function folder(
  partial: Partial<ChatFolderState> & Pick<ChatFolderState, "id" | "workspaceId">
): ChatFolderState {
  return {
    name: partial.name ?? "Folder",
    color: partial.color ?? "#2563eb",
    icon: partial.icon ?? "Folder",
    sortOrder: partial.sortOrder ?? 0,
    conversationIds: partial.conversationIds ?? [],
    ...partial,
  };
}

describe("chat folders", () => {
  test("orders conversations by explicit ids then recency", () => {
    const ordered = orderConversationsByIds(
      [
        { id: "a", title: "A", updatedAt: 1 },
        { id: "b", title: "B", updatedAt: 3 },
        { id: "c", title: "C", updatedAt: 2 },
      ],
      ["c", "a"]
    );
    assert.deepEqual(
      ordered.map((item) => item.id),
      ["c", "a", "b"]
    );
  });

  test("partitions standalone chats across shared folder scope", () => {
    const folders = [
      folder({
        id: "f1",
        workspaceId: STANDALONE_CHATS_FOLDER_SCOPE,
        conversationIds: ["c2"],
        sortOrder: 0,
      }),
    ];
    const { rootConversations, folderConversations } = partitionConversationsByFolders(
      [
        { id: "c1", title: "One", updatedAt: 10 },
        { id: "c2", title: "Two", updatedAt: 20 },
        { id: "c3", title: "Three", updatedAt: 30 },
      ],
      folders,
      ["c1", "c3"]
    );
    assert.deepEqual(
      rootConversations.map((item) => item.id),
      ["c1", "c3"]
    );
    assert.deepEqual(
      (folderConversations.get("f1") ?? []).map((item) => item.id),
      ["c2"]
    );
  });

  test("moves conversations between folders with placement", () => {
    const folders = [
      folder({
        id: "f1",
        workspaceId: "ws-1",
        conversationIds: ["a", "b"],
        sortOrder: 0,
      }),
      folder({
        id: "f2",
        workspaceId: "ws-1",
        conversationIds: ["c"],
        sortOrder: 1,
      }),
    ];
    const next = moveConversationInChatFolders(folders, {
      scopeId: "ws-1",
      conversationId: "a",
      folderId: "f2",
      targetConversationId: "c",
      placement: "before",
    });
    assert.deepEqual(getChatFoldersForScope(next, "ws-1")[0]?.conversationIds, ["b"]);
    assert.deepEqual(getChatFoldersForScope(next, "ws-1")[1]?.conversationIds, ["a", "c"]);
  });

  test("updates root custom order when moving to and from root", () => {
    const intoFolder = updateRootOrderForMove(
      { "ws-1": ["a", "b", "c"] },
      {
        scopeId: "ws-1",
        conversationId: "b",
        folderId: "f1",
        knownRootIds: ["a", "b", "c"],
      }
    );
    assert.deepEqual(intoFolder["ws-1"], ["a", "c"]);

    const toRoot = updateRootOrderForMove(
      { "ws-1": ["a", "c"] },
      {
        scopeId: "ws-1",
        conversationId: "b",
        folderId: null,
        targetConversationId: "a",
        placement: "after",
        knownRootIds: ["a", "c", "b"],
      }
    );
    assert.deepEqual(toRoot["ws-1"], ["a", "b", "c"]);
  });

  test("reorders folders within a scope", () => {
    const folders = [
      folder({ id: "f1", workspaceId: "ws-1", sortOrder: 0 }),
      folder({ id: "f2", workspaceId: "ws-1", sortOrder: 1 }),
      folder({ id: "f3", workspaceId: "ws-1", sortOrder: 2 }),
      folder({ id: "other", workspaceId: "ws-2", sortOrder: 0 }),
    ];
    const next = reorderChatFolders(folders, {
      scopeId: "ws-1",
      sourceFolderId: "f3",
      targetFolderId: "f1",
      placement: "before",
    });
    assert.deepEqual(
      getChatFoldersForScope(next, "ws-1").map((item) => item.id),
      ["f3", "f1", "f2"]
    );
    assert.equal(getChatFoldersForScope(next, "ws-2")[0]?.sortOrder, 0);
  });

  test("creates folders under the standalone chats scope", () => {
    const created = createChatFolderState({
      id: "f-new",
      scopeId: STANDALONE_CHATS_FOLDER_SCOPE,
      existingFolders: [],
      conversationId: "c1",
    });
    const folders = upsertChatFoldersWithNewFolder([], created, "c1");
    assert.equal(folders[0]?.workspaceId, STANDALONE_CHATS_FOLDER_SCOPE);
    assert.deepEqual(folders[0]?.conversationIds, ["c1"]);
  });

  test("placeIdAmongIds inserts before and after targets", () => {
    assert.deepEqual(placeIdAmongIds(["a", "b", "c"], "c", "a", "before"), ["c", "a", "b"]);
    assert.deepEqual(placeIdAmongIds(["a", "b", "c"], "a", "c", "after"), ["b", "c", "a"]);
  });

  test("normalizes chatRootOrderByScope in global settings", () => {
    const base = createDefaultGlobalSettings();
    assert.deepEqual(base.general.chatRootOrderByScope, {});
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      general: {
        ...base.general,
        chatRootOrderByScope: {
          [STANDALONE_CHATS_FOLDER_SCOPE]: ["c1", "c1", "", "c2"],
          "ws-1": ["a"],
          "": ["nope"],
        },
        chatFolders: [
          {
            id: "f1",
            workspaceId: STANDALONE_CHATS_FOLDER_SCOPE,
            name: "Ideas",
            color: "#2563eb",
            icon: "Folder",
            sortOrder: 0,
            conversationIds: ["c9"],
          },
        ],
      },
    });
    assert.deepEqual(settings.general.chatRootOrderByScope, {
      [STANDALONE_CHATS_FOLDER_SCOPE]: ["c1", "c2"],
      "ws-1": ["a"],
    });
    assert.equal(settings.general.chatFolders[0]?.workspaceId, STANDALONE_CHATS_FOLDER_SCOPE);
  });
});
