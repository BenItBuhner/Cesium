import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentConversationRecord,
  AgentSocketServerMessage,
  AgentStoredEvent,
  FileNode,
} from "@cesium/core";
import {
  dedupeAgentEvents,
  flattenVisibleFileTree,
  reduceConversationFeed,
} from "./workbench-state";

const conversation = {
  id: "conversation-1",
  workspaceId: "workspace-1",
  title: "Native parity",
} as AgentConversationRecord;

function userEvent(seq: number, content: string): AgentStoredEvent {
  return {
    seq,
    eventId: `event-${seq}`,
    conversationId: conversation.id,
    createdAt: seq,
    kind: "user_message",
    messageId: `message-${seq}`,
    content,
  };
}

test("dedupeAgentEvents keeps the latest payload and sequence order", () => {
  const events = dedupeAgentEvents([
    userEvent(2, "second-old"),
    userEvent(1, "first"),
    userEvent(2, "second-new"),
  ]);
  assert.deepEqual(
    events.map((event) => [event.seq, event.kind === "user_message" ? event.content : ""]),
    [
      [1, "first"],
      [2, "second-new"],
    ]
  );
});

test("reduceConversationFeed merges snapshots and incremental events", () => {
  const snapshot = {
    type: "snapshot",
    snapshot: { conversation, events: [userEvent(1, "first")] },
  } satisfies AgentSocketServerMessage;
  const incremental = {
    type: "event",
    workspaceId: conversation.workspaceId,
    conversationId: conversation.id,
    event: userEvent(2, "second"),
  } satisfies AgentSocketServerMessage;
  const initial = { conversation: null, events: [] };
  const withSnapshot = reduceConversationFeed(initial, snapshot, conversation.id);
  const withIncremental = reduceConversationFeed(
    withSnapshot,
    incremental,
    conversation.id
  );
  assert.equal(withIncremental.conversation?.title, "Native parity");
  assert.deepEqual(
    withIncremental.events.map((event) => event.seq),
    [1, 2]
  );
});

test("flattenVisibleFileTree only descends into expanded folders", () => {
  const tree: FileNode[] = [
    {
      name: "src",
      type: "folder",
      children: [{ name: "App.tsx", type: "file", language: "typescript" }],
    },
    { name: "package.json", type: "file", language: "json" },
  ];
  assert.deepEqual(
    flattenVisibleFileTree(tree, new Set()).map((row) => row.path),
    ["src", "package.json"]
  );
  assert.deepEqual(
    flattenVisibleFileTree(tree, new Set(["src"])).map((row) => row.path),
    ["src", "src/App.tsx", "package.json"]
  );
});
