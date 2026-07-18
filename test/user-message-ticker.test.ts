import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "../src/lib/types";
import {
  buildUserMessageTickerItems,
  plainTextForTickerPreview,
  shouldShowUserMessageTicker,
  truncateTickerText,
  userMessagePreviewText,
} from "../src/lib/user-message-ticker";

test("userMessagePreviewText prefers text segments then rawContent", () => {
  assert.equal(
    userMessagePreviewText({
      id: "u1",
      type: "user",
      content: "summary",
      rawContent: "full raw prompt",
      segments: [
        { type: "text", text: "Hello " },
        { type: "file", text: "app.tsx" },
        { type: "text", text: "world" },
      ],
    }),
    "Hello world"
  );
  assert.equal(
    userMessagePreviewText({
      id: "u2",
      type: "user",
      content: "shown",
      rawContent: "raw only",
    }),
    "raw only"
  );
});

test("truncateTickerText ellipsizes long previews", () => {
  const long = "x".repeat(140);
  const truncated = truncateTickerText(long, 40);
  assert.equal(truncated.length, 40);
  assert.ok(truncated.endsWith("…"));
});

test("plainTextForTickerPreview strips markdown noise", () => {
  assert.equal(
    plainTextForTickerPreview("**Done.** Keep `cursor` and [link](https://x.test)."),
    "Done. Keep cursor and link."
  );
});

test("buildUserMessageTickerItems maps user turns with assistant + attachment chips", () => {
  const messages: ChatMessage[] = [
    {
      id: "u1",
      type: "user",
      content: "Shrink the circle",
      attachments: [{ mimeType: "image/png", data: "abc", name: "CleanShot 2026.png" }],
      segments: [
        { type: "text", text: "Shrink the circle" },
        { type: "file", text: "highlight_cursor.ts" },
      ],
    },
    {
      id: "a1",
      type: "assistant",
      content: "Done. I kept every cursor position unchanged and reduced the circle diameter.",
    },
    { id: "u2", type: "user", content: "You did such a good job on that." },
    { id: "a2", type: "assistant", content: "Glad it helped." },
  ];

  const items = buildUserMessageTickerItems(messages);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.messageId, "u1");
  assert.equal(items[0]!.userPreview, "Shrink the circle");
  assert.match(items[0]!.assistantPreview ?? "", /kept every cursor position/);
  assert.deepEqual(
    items[0]!.attachments.map((chip) => chip.label),
    ["CleanShot 2026.png", "highlight_cursor.ts"]
  );
  assert.equal(items[1]!.messageId, "u2");
  assert.equal(items[1]!.assistantPreview, "Glad it helped.");
  assert.equal(shouldShowUserMessageTicker(items.length), true);
  assert.equal(shouldShowUserMessageTicker(1), false);
});

test("buildUserMessageTickerItems skips empty non-user preamble noise", () => {
  const messages: ChatMessage[] = [
    { id: "sys", type: "activity-label", content: "Working" },
    { id: "u1", type: "user", content: "first" },
    { id: "a1", type: "assistant", content: "ok" },
    { id: "u2", type: "user", content: "second" },
  ];
  const items = buildUserMessageTickerItems(messages);
  assert.deepEqual(
    items.map((item) => item.messageId),
    ["u1", "u2"]
  );
});
