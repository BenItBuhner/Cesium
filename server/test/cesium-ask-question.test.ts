import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseAskQuestionArgs,
  parseQuestionOptions,
} from "../src/lib/agents/cesium/cesium-ask-question.js";

test("legacy prompt + {id,label} options still parse", () => {
  const parsed = parseAskQuestionArgs({
    prompt: "Which approach?",
    options: [
      { id: "a", label: "Refactor now" },
      { id: "b", label: "Ship as-is" },
    ],
  });
  assert.equal(parsed.prompt, "Which approach?");
  assert.deepEqual(
    parsed.questions[0]?.options.map((option) => option.label),
    ["Refactor now", "Ship as-is"]
  );
});

test("question/choices aliases and plain-string options parse", () => {
  const parsed = parseAskQuestionArgs({
    question: "Pick a color",
    choices: ["Red", "Blue"],
  });
  assert.equal(parsed.prompt, "Pick a color");
  assert.deepEqual(
    parsed.options.map((option) => option.label),
    ["Red", "Blue"]
  );
});

test("prompt alone is a valid open-ended question (empty options)", () => {
  const parsed = parseAskQuestionArgs({ prompt: "What should the app be called?" });
  assert.equal(parsed.questions.length, 1);
  assert.deepEqual(parsed.questions[0]?.options, []);
});

test("questions array of plain strings parses as open-ended steps", () => {
  const parsed = parseAskQuestionArgs({
    questions: ["What framework?", "What database?"],
  });
  assert.equal(parsed.questions.length, 2);
  assert.equal(parsed.questions[1]?.prompt, "What database?");
  assert.equal(parsed.prompt, "Questions");
});

test("questions items accept question/title keys and choices arrays", () => {
  const parsed = parseAskQuestionArgs({
    questions: [
      { question: "Tabs or spaces?", choices: ["Tabs", "Spaces"] },
      { title: "Semicolons?", options: [{ value: "Yes" }, { name: "No" }] },
    ],
  });
  assert.equal(parsed.questions.length, 2);
  assert.deepEqual(
    parsed.questions[0]?.options.map((option) => option.label),
    ["Tabs", "Spaces"]
  );
  assert.deepEqual(
    parsed.questions[1]?.options.map((option) => option.label),
    ["Yes", "No"]
  );
});

test("nested single-question object under `question` parses", () => {
  const parsed = parseAskQuestionArgs({
    question: { prompt: "Deploy now?", options: ["Yes", "No"] },
  });
  assert.equal(parsed.prompt, "Deploy now?");
  assert.deepEqual(
    parsed.questions[0]?.options.map((option) => option.label),
    ["Yes", "No"]
  );
});

test("allowMultiple accepts boolean-ish strings and aliases", () => {
  assert.equal(
    parseAskQuestionArgs({ prompt: "Pick", options: ["A"], allowMultiple: "true" })
      .allowMultiple,
    true
  );
  assert.equal(
    parseAskQuestionArgs({ prompt: "Pick", options: ["A"], multiple: true }).allowMultiple,
    true
  );
  assert.equal(
    parseAskQuestionArgs({ prompt: "Pick", options: ["A"] }).allowMultiple,
    false
  );
});

test("empty args throw an actionable error with an example", () => {
  assert.throws(() => parseAskQuestionArgs({}), /Provide `prompt`.*open-ended/s);
});

test("parseQuestionOptions tolerates numbers and skips empty entries", () => {
  assert.deepEqual(parseQuestionOptions(["A", 2, "", { label: "B" }, {}]), [
    { id: "option-1", label: "A" },
    { id: "option-2", label: "2" },
    { id: "option-4", label: "B" },
  ]);
});
