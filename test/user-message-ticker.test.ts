import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMessageThreadSegments,
  findUserTurnSegmentIndex,
} from "../src/components/chat/message-thread-rows";
import {
  buildUserMessageTickerItems,
  userMessagePreview,
  userMessageTickerMarkerWidth,
} from "../src/components/chat/user-message-ticker";
import type { ChatMessage } from "../src/lib/types";

test("ticker includes only user turns and preserves transcript order", () => {
  const messages: ChatMessage[] = [
    { id: "preamble", type: "assistant", content: "Intro" },
    { id: "u1", type: "user", content: "  First\nmessage  " },
    { id: "a1", type: "assistant", content: "Answer" },
    {
      id: "u2",
      type: "user",
      segments: [
        { type: "text", text: "Review " },
        { type: "file", text: "src/app.ts" },
      ],
    },
  ];

  assert.deepEqual(buildUserMessageTickerItems(messages), [
    { id: "u1", preview: "First message", ordinal: 1 },
    { id: "u2", preview: "Review src/app.ts", ordinal: 2 },
  ]);
});

test("ticker preview truncates long prompts and describes attachment-only turns", () => {
  const longMessage: ChatMessage = {
    id: "long",
    type: "user",
    content: "a".repeat(400),
  };
  const attachmentMessage: ChatMessage = {
    id: "image",
    type: "user",
    attachments: [
      { mimeType: "image/png", data: "one" },
      { mimeType: "image/png", data: "two" },
    ],
  };

  const preview = userMessagePreview(longMessage);
  assert.equal(preview.length, 280);
  assert.ok(preview.endsWith("…"));
  assert.equal(userMessagePreview(attachmentMessage), "2 image attachments");
});

test("marker width remains compact while reflecting preview length", () => {
  assert.equal(userMessageTickerMarkerWidth(""), 8);
  assert.ok(userMessageTickerMarkerWidth("A reasonably descriptive prompt") > 8);
  assert.equal(userMessageTickerMarkerWidth("x".repeat(1000)), 20);
});

test("turn lookup resolves virtualized user rows across preamble and todo turns", () => {
  const messages: ChatMessage[] = [
    { id: "preamble", type: "assistant", content: "Intro" },
    { id: "u1", type: "user", content: "First" },
    { id: "todo1", type: "todo-status", content: "Working" },
    { id: "a1", type: "assistant", content: "Answer" },
    { id: "u2", type: "user", content: "Second" },
    { id: "a2", type: "assistant", content: "Answer" },
  ];
  const segments = buildMessageThreadSegments(messages);

  assert.equal(findUserTurnSegmentIndex(segments, messages, "u1"), 1);
  assert.equal(findUserTurnSegmentIndex(segments, messages, "u2"), 2);
  assert.equal(findUserTurnSegmentIndex(segments, messages, "missing"), -1);
});
