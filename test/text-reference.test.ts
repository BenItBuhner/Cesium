import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTextReferenceBlock,
  findComposerTextReferenceTokens,
  makeComposerTextReferenceToken,
  splitContentByTextReferenceBlocks,
  type TextReference,
} from "../src/lib/text-reference";

test("text reference tokens are discoverable in composer text", () => {
  const token = makeComposerTextReferenceToken("ref-1");
  assert.equal(token, "\u27E6textref:ref-1\u27E7");
  assert.deepEqual(findComposerTextReferenceTokens(`before ${token} after`), [
    { start: 7, end: 22, referenceId: "ref-1" },
  ]);
});

test("text reference blocks parse into compact user message segments", () => {
  const reference: TextReference = {
    id: "ref-1",
    label: "Pasted text (10,001 chars)",
    text: "hello\nworld",
    charCount: 11,
  };
  const segments = splitContentByTextReferenceBlocks(
    `Please inspect ${buildTextReferenceBlock(reference)} thanks`
  );
  assert.deepEqual(segments, [
    { type: "text", text: "Please inspect " },
    {
      type: "text-reference",
      text: "Pasted text (10,001 chars)",
      referenceId: "ref-1",
      referenceCharCount: 11,
      referenceText: "hello\nworld",
    },
    { type: "text", text: " thanks" },
  ]);
});
