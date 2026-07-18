import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMessageThreadSegments,
  findUserTurnSegmentIndex,
} from "../src/components/chat/message-thread-rows";
import {
  buildUserMessageTickerItems,
  nearestUserMessageTickerIndex,
  USER_MESSAGE_TICKER_MARKER_MAX_WIDTH_PX,
  USER_MESSAGE_TICKER_MARKER_WIDTH_PX,
  userMessageTickerHoverWidth,
  userMessageTickerMarkerCenter,
  userMessagePreview,
  userMessageTickerRailHeight,
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

test("resting ticker markers use compact uniform spacing", () => {
  assert.equal(userMessageTickerRailHeight(0), 0);
  assert.equal(userMessageTickerRailHeight(1), 24);
  assert.equal(userMessageTickerRailHeight(10), 50);
  assert.equal(userMessageTickerRailHeight(100), 360);

  const centers = Array.from({ length: 10 }, (_, index) =>
    userMessageTickerMarkerCenter(index, 10, 50)
  );
  assert.deepEqual(centers, [2.5, 7.5, 12.5, 17.5, 22.5, 27.5, 32.5, 37.5, 42.5, 47.5]);
});

test("cursor position selects the nearest uniformly spaced marker", () => {
  assert.equal(nearestUserMessageTickerIndex(0, 10, 50), 0);
  assert.equal(nearestUserMessageTickerIndex(4.9, 10, 50), 0);
  assert.equal(nearestUserMessageTickerIndex(5, 10, 50), 1);
  assert.equal(nearestUserMessageTickerIndex(49.9, 10, 50), 9);
  assert.equal(nearestUserMessageTickerIndex(500, 10, 50), 9);
  assert.equal(nearestUserMessageTickerIndex(10, 0, 50), null);
});

test("hover scaling is smooth, local, and independent of message content", () => {
  assert.equal(
    userMessageTickerHoverWidth(20, null),
    USER_MESSAGE_TICKER_MARKER_WIDTH_PX
  );
  assert.equal(
    userMessageTickerHoverWidth(20, 20),
    USER_MESSAGE_TICKER_MARKER_MAX_WIDTH_PX
  );
  const nearWidth = userMessageTickerHoverWidth(20, 26);
  const fartherWidth = userMessageTickerHoverWidth(20, 34);
  assert.ok(nearWidth > fartherWidth);
  assert.ok(fartherWidth > USER_MESSAGE_TICKER_MARKER_WIDTH_PX);
  assert.equal(
    userMessageTickerHoverWidth(20, 42),
    USER_MESSAGE_TICKER_MARKER_WIDTH_PX
  );
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
