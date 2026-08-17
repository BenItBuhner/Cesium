import assert from "node:assert/strict";
import test from "node:test";
import { scrollTopForVirtualUserTurnAnchor } from "../src/components/chat/MessageThreadContent";
import { buildMessageThreadSegments } from "../src/components/chat/message-thread-rows";
import type { ChatMessage } from "../src/lib/types";

test("virtual anchor restore follows the same user turn after prepends shift indexes", () => {
  const makeTurns = (start: number, end: number): ChatMessage[] => {
    const out: ChatMessage[] = [];
    for (let i = start; i <= end; i += 1) {
      out.push(
        { id: `u${i}`, type: "user", content: `user ${i}` },
        { id: `a${i}`, type: "assistant", content: `answer ${i}` }
      );
    }
    return out;
  };
  const beforeSegments = buildMessageThreadSegments(makeTurns(27, 122));
  const afterMessages = makeTurns(1, 122);
  const afterSegments = buildMessageThreadSegments(afterMessages);
  const anchor = { messageId: "u111", delta: 37 };

  assert.equal(
    scrollTopForVirtualUserTurnAnchor(beforeSegments, makeTurns(27, 122), anchor, (index) => index * 500),
    84 * 500 + 37
  );
  assert.equal(
    scrollTopForVirtualUserTurnAnchor(afterSegments, afterMessages, anchor, (index) => index * 500),
    110 * 500 + 37
  );
});
