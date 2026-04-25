import assert from "node:assert/strict";
import { test } from "node:test";

const { extractInlineReasoning } = await import("../src/lib/agents/parse-inline-reasoning.js");

/**
 * Mirrors ACP agent_message_chunk handling: each delta runs through extractInlineReasoning
 * before appendEvents(assistant_message_chunk).
 */
function simulateAcpStream(fullText: string, chunkSizes: number[]): string {
  let offset = 0;
  let out = "";
  for (const size of chunkSizes) {
    const chunk = fullText.slice(offset, offset + size);
    offset += size;
    const { text } = extractInlineReasoning(chunk, { normalizeEdges: false });
    out += text;
  }
  assert.equal(offset, fullText.length, "chunk plan must cover full string");
  return out;
}

test("simulated ACP stream preserves markdown across arbitrary chunk boundaries", () => {
  const md = [
    "## Summary\n",
    "\n",
    "- First item\n",
    "- Second item\n",
    "\n",
    "Paragraph after list.\n",
  ].join("");

  const sum = (sizes: number[]) => sizes.reduce((a, b) => a + b, 0);
  const partitions: number[][] = [
    [md.length],
    [1, md.length - 1],
    [Math.floor(md.length / 2), md.length - Math.floor(md.length / 2)],
  ];
  const cyclic: number[] = [];
  let remaining = md.length;
  for (let i = 0; remaining > 0; i += 1) {
    const take = Math.min((i % 5) + 1, remaining);
    cyclic.push(take);
    remaining -= take;
  }
  partitions.push(cyclic);

  for (const sizes of partitions) {
    assert.equal(sum(sizes), md.length, `bad partition: ${sizes.join(",")}`);
    assert.equal(simulateAcpStream(md, sizes), md);
  }
});

test("newline-only chunk is preserved in stream mode (not trimmed away)", () => {
  assert.equal(
    extractInlineReasoning("\n\n", { normalizeEdges: false }).text,
    "\n\n"
  );
  assert.equal(extractInlineReasoning("\n\n").text, "");
});
