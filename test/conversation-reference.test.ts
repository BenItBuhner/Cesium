import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildConversationReferenceBlock,
  findComposerConversationReferenceTokens,
  makeComposerConversationReferenceToken,
  splitContentByConversationReferenceBlocks,
  type ConversationReference,
} from "@cesium/core";
import {
  filterAtSuggestions,
  getAllAtSuggestions,
} from "../src/lib/composer-suggestions";

test("conversation reference tokens are discoverable in composer text", () => {
  const token = makeComposerConversationReferenceToken("conv-1");
  assert.equal(token, "\u27E6conv:conv-1\u27E7");
  assert.deepEqual(findComposerConversationReferenceTokens(`before ${token} after`), [
    { start: 7, end: 20, conversationId: "conv-1" },
  ]);
});

test("conversation reference blocks expand with id, title, and tool guidance", () => {
  const reference: ConversationReference = {
    id: "abc-123",
    title: 'Fix "flux" <capacitor>',
    workspaceId: "ws-1",
    workspaceName: "Time Machine",
  };
  const block = buildConversationReferenceBlock(reference);
  assert.match(block, /^<conversation-reference /);
  assert.match(block, /id="abc-123"/);
  assert.match(block, /title="Fix &quot;flux&quot; &lt;capacitor&gt;"/);
  assert.match(block, /workspace-id="ws-1"/);
  assert.match(block, /workspace-name="Time Machine"/);
  assert.match(block, /read_conversation/);
  assert.match(block, /search_conversations/);
});

test("conversation reference blocks parse back into chat chips", () => {
  const reference: ConversationReference = {
    id: "abc-123",
    title: "Prior investigation",
    workspaceName: "Time Machine",
  };
  const segments = splitContentByConversationReferenceBlocks(
    `Use ${buildConversationReferenceBlock(reference)} for context`
  );
  assert.ok(segments);
  assert.deepEqual(segments![0], { type: "text", text: "Use " });
  assert.equal(segments![1]!.type, "conversation");
  assert.equal(segments![1]!.text, "Prior investigation");
  assert.equal(segments![1]!.conversationId, "abc-123");
  assert.equal(segments![1]!.conversationWorkspaceName, "Time Machine");
  assert.deepEqual(segments![2], { type: "text", text: " for context" });
  assert.equal(splitContentByConversationReferenceBlocks("no blocks here"), null);
});

test("composer @ suggestions include conversations and stay searchable", () => {
  const suggestions = getAllAtSuggestions(
    {
      name: "",
      type: "folder",
      children: [{ name: "readme.md", type: "file" }],
    },
    [
      { id: "conv-old", title: "Ancient debugging notes", workspaceName: "Alpha", updatedAt: 1 },
      { id: "conv-new", title: "Fresh rollout plan", workspaceName: "Beta", updatedAt: 2 },
    ]
  );
  const conversationEntries = suggestions.filter((s) => s.category === "conversation");
  assert.equal(
    suggestions.some((s) => s.id === "docs" || s.insert === "@Docs"),
    false
  );
  assert.equal(conversationEntries.length, 2);
  // Newest first, pill-token insert.
  assert.equal(conversationEntries[0]!.label, "Fresh rollout plan");
  assert.equal(conversationEntries[0]!.insert, "\u27E6conv:conv-new\u27E7");
  assert.equal(conversationEntries[0]!.subtitle, "Chat · Beta");

  const filtered = filterAtSuggestions(suggestions, "ancient");
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.id, "conversation:conv-old");

  // Files remain reachable alongside conversations.
  const files = filterAtSuggestions(suggestions, "readme");
  assert.equal(files[0]!.category, "file");
});

test("empty-query popup caps conversation suggestions so files stay visible", () => {
  const manyConversations = Array.from({ length: 30 }, (_, i) => ({
    id: `conv-${i}`,
    title: `Chat number ${i}`,
    updatedAt: i,
  }));
  const suggestions = getAllAtSuggestions(
    {
      name: "",
      type: "folder",
      children: [{ name: "app.ts", type: "file" }],
    },
    manyConversations
  );
  const unfiltered = filterAtSuggestions(suggestions, "");
  const conversationCount = unfiltered.filter((s) => s.category === "conversation").length;
  assert.ok(conversationCount <= 8, `expected <= 8 conversation rows, got ${conversationCount}`);
  assert.ok(unfiltered.some((s) => s.category === "file"));
  // A specific title query still reaches beyond the unfiltered cap.
  const deepHit = filterAtSuggestions(suggestions, "Chat number 3");
  assert.ok(deepHit.some((s) => s.id === "conversation:conv-3"));
});
