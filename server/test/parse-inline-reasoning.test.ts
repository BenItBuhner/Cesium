import assert from "node:assert/strict";
import { test } from "node:test";

const { extractInlineReasoning } = await import("../src/lib/agents/parse-inline-reasoning.js");

test("extractInlineReasoning returns empty reasoning for plain text", () => {
  const result = extractInlineReasoning("Hello world");
  assert.deepEqual(result.reasoning, []);
  assert.equal(result.text, "Hello world");
});

test("extractInlineReasoning extracts <thinking> tags", () => {
  const result = extractInlineReasoning(
    "Let me think...\n<thinking>\nI should analyze this carefully.\n</thinking>\nHere is my answer."
  );
  assert.equal(result.reasoning.length, 1);
  assert.equal(result.reasoning[0].text, "I should analyze this carefully.");
  assert.equal(result.reasoning[0].raw, "<thinking>\nI should analyze this carefully.\n</thinking>");
  assert.equal(result.text, "Let me think...\n\nHere is my answer.");
});

test("extractInlineReasoning extracts <reason> tags", () => {
  const result = extractInlineReasoning(
    "<reason>Step 1: Check X</reason>The result is 42."
  );
  assert.equal(result.reasoning.length, 1);
  assert.equal(result.reasoning[0].text, "Step 1: Check X");
  assert.equal(result.text, "The result is 42.");
});

test("extractInlineReasoning extracts <thought> tags", () => {
  const result = extractInlineReasoning(
    "Some text<thought>Inner monologue</thought>More text"
  );
  assert.equal(result.reasoning.length, 1);
  assert.equal(result.reasoning[0].text, "Inner monologue");
  assert.equal(result.text, "Some text\nMore text");
});

test("extractInlineReasoning extracts <reflection> tags", () => {
  const result = extractInlineReasoning(
    "<reflection>Self-correction here</reflection>Final answer"
  );
  assert.equal(result.reasoning.length, 1);
  assert.equal(result.reasoning[0].text, "Self-correction here");
  assert.equal(result.text, "Final answer");
});

test("extractInlineReasoning extracts <mindset> tags", () => {
  const result = extractInlineReasoning(
    "<mindset>Reasoning process</mindset>Output"
  );
  assert.equal(result.reasoning.length, 1);
  assert.equal(result.reasoning[0].text, "Reasoning process");
  assert.equal(result.text, "Output");
});

test("extractInlineReasoning handles multiple reasoning blocks", () => {
  const result = extractInlineReasoning(
    "<thinking>First thought</thinking>Mid text<thinking>Second thought</thinking>End text"
  );
  assert.equal(result.reasoning.length, 2);
  assert.equal(result.reasoning[0].text, "First thought");
  assert.equal(result.reasoning[1].text, "Second thought");
  assert.equal(result.text, "Mid text\nEnd text");
});

test("extractInlineReasoning is case-insensitive", () => {
  const result = extractInlineReasoning(
    "<THINKING>Upper case</THINKING>Result"
  );
  assert.equal(result.reasoning.length, 1);
  assert.equal(result.reasoning[0].text, "Upper case");
  assert.equal(result.text, "Result");
});

test("extractInlineReasoning handles whitespace inside tags", () => {
  const result = extractInlineReasoning(
    "<thinking >  \n  Spaced content  \n  </thinking >Answer"
  );
  assert.equal(result.reasoning.length, 1);
  assert.equal(result.reasoning[0].text, "Spaced content");
  assert.equal(result.text, "Answer");
});

test("extractInlineReasoning preserves tool-typed tags", () => {
  const result = extractInlineReasoning(
    '<thinking type="tool">This is a tool call</thinking>Answer'
  );
  assert.equal(result.reasoning.length, 0);
  assert.equal(result.text, '<thinking type="tool">This is a tool call</thinking>Answer');
});

test("extractInlineReasoning preserves tool_call-typed tags", () => {
  const result = extractInlineReasoning(
    "<thinking type='tool_call'>Tool invocation</thinking>Answer"
  );
  assert.equal(result.reasoning.length, 0);
  assert.equal(result.text, "<thinking type='tool_call'>Tool invocation</thinking>Answer");
});

test("extractInlineReasoning skips empty reasoning blocks", () => {
  const result = extractInlineReasoning(
    "<thinking>   </thinking>Just text"
  );
  assert.equal(result.reasoning.length, 0);
  assert.equal(result.text, "Just text");
});

test("extractInlineReasoning collapses excessive newlines after extraction", () => {
  const result = extractInlineReasoning(
    "Start\n\n\n\n\n<thinking>Reasoning</thinking>\n\n\n\n\nEnd"
  );
  assert.equal(result.reasoning.length, 1);
  assert.equal(result.text, "Start\n\nEnd");
});

test("extractInlineReasoning returns empty text when all content is reasoning", () => {
  const result = extractInlineReasoning(
    "<thinking>Only reasoning here</thinking>"
  );
  assert.equal(result.reasoning.length, 1);
  assert.equal(result.text, "");
});

test("extractInlineReasoning handles tags with extra attributes", () => {
  const result = extractInlineReasoning(
    '<thinking confidence="high">Confident reasoning</thinking>Output'
  );
  assert.equal(result.reasoning.length, 1);
  assert.equal(result.reasoning[0].text, "Confident reasoning");
  assert.equal(result.text, "Output");
});

test("extractInlineReasoning does not match unclosed tags", () => {
  const result = extractInlineReasoning(
    "<thinking>Never closed... the rest of the text"
  );
  assert.equal(result.reasoning.length, 0);
  assert.equal(result.text, "<thinking>Never closed... the rest of the text");
});

test("extractInlineReasoning handles multiline reasoning content", () => {
  const input = `<thinking>
Line 1
Line 2
Line 3
</thinking>

Here is the answer.`;

  const result = extractInlineReasoning(input);
  assert.equal(result.reasoning.length, 1);
  assert.equal(result.reasoning[0].text, "Line 1\nLine 2\nLine 3");
  assert.equal(result.text, "Here is the answer.");
});

test("extractInlineReasoning handles mixed tag types in same text", () => {
  const result = extractInlineReasoning(
    "<thinking>Initial reasoning</thinking><reflection>Self-correction</reflection>Final output"
  );
  assert.equal(result.reasoning.length, 2);
  assert.equal(result.reasoning[0].text, "Initial reasoning");
  assert.equal(result.reasoning[1].text, "Self-correction");
  assert.equal(result.text, "Final output");
});

test("extractInlineReasoning preserves raw XML in raw field", () => {
  const result = extractInlineReasoning(
    "<thinking>\n  Detailed analysis\n</thinking>"
  );
  assert.equal(result.reasoning[0].raw, "<thinking>\n  Detailed analysis\n</thinking>");
});

test("extractInlineReasoning streaming mode preserves leading newlines on a chunk", () => {
  const chunk = "\n\nThat control lived only in the UI.";
  const streamed = extractInlineReasoning(chunk, { normalizeEdges: false });
  assert.deepEqual(streamed.reasoning, []);
  assert.equal(streamed.text, chunk);
  const defaultTrim = extractInlineReasoning(chunk);
  assert.equal(defaultTrim.text, "That control lived only in the UI.");
});

test("concatenated streamed chunks match full markdown when normalizeEdges is false", () => {
  const full = '**Removed "Cancel request"**\n\nThat control lived only in the UI.';
  const chunks = ['**Removed "Cancel request"**', "\n\nThat control lived only in the UI."];
  let acc = "";
  for (const c of chunks) {
    acc += extractInlineReasoning(c, { normalizeEdges: false }).text;
  }
  assert.equal(acc, full);
});
