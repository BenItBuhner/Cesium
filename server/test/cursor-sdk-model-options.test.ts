import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeCursorSdkModelValue,
  encodeCursorSdkModelValue,
} from "../src/lib/agents/cursor-sdk-model-selection.js";
import { cursorSdkConfigOptionsFromModels } from "../src/lib/agents/provider-cache-store.js";

test("Cursor SDK model variants become concrete selectable rows", () => {
  const options = cursorSdkConfigOptionsFromModels([
    {
      id: "composer-2",
      displayName: "Composer 2",
      variants: [
        {
          displayName: "Default",
          params: [],
          isDefault: true,
        },
        {
          displayName: "Fast",
          params: [{ id: "speed", value: "fast" }],
        },
      ],
    },
    {
      id: "codex-5.3",
      displayName: "Codex 5.3",
      variants: [
        {
          displayName: "Low Fast",
          params: [
            { id: "reasoning_effort", value: "low" },
            { id: "speed", value: "fast" },
          ],
        },
        {
          displayName: "Extra High",
          params: [{ id: "reasoning_effort", value: "xhigh" }],
        },
      ],
    },
    {
      id: "gpt-5.5",
      displayName: "GPT-5.5",
      variants: [
        {
          displayName: "(272k, Fast, None)",
          params: [
            { id: "context", value: "272k" },
            { id: "speed", value: "fast" },
            { id: "reasoning_effort", value: "none" },
          ],
        },
        {
          displayName: "(272k, Fast, Low)",
          params: [
            { id: "context", value: "272k" },
            { id: "speed", value: "fast" },
            { id: "reasoning_effort", value: "low" },
          ],
        },
      ],
    },
  ]);

  const modelOption = options.find((option) => option.id === "model");
  assert.ok(modelOption);
  assert.deepEqual(
    modelOption.options.map((option) => option.name),
    [
      "Composer 2",
      "Composer 2 Fast",
      "Codex 5.3 Low Fast",
      "Codex 5.3 Extra High",
      "GPT-5.5 Fast",
      "GPT-5.5 Low Fast",
    ]
  );
  assert.deepEqual(
    modelOption.options.map((option) => option.value),
    [
      "composer-2",
      "composer-2[speed=fast]",
      "codex-5.3[reasoning_effort=low,speed=fast]",
      "codex-5.3[reasoning_effort=xhigh]",
      "gpt-5.5[context=272k,reasoning_effort=none,speed=fast]",
      "gpt-5.5[context=272k,reasoning_effort=low,speed=fast]",
    ]
  );
});

test("Cursor SDK aliases become selectable model rows", () => {
  const options = cursorSdkConfigOptionsFromModels([
    {
      id: "composer-2.5",
      displayName: "Composer 2.5",
      aliases: ["composer-latest"],
    },
  ]);
  const modelOption = options.find((option) => option.id === "model");
  assert.ok(modelOption);
  assert.equal(modelOption.currentValue, "composer-2.5");
  assert.deepEqual(
    modelOption.options.map((option) => option.value),
    ["composer-2.5", "composer-latest"]
  );
});

test("Cursor SDK encoded model values decode into ModelSelection params", () => {
  const encoded = encodeCursorSdkModelValue("codex-5.3", [
    { id: "reasoning_effort", value: "high" },
    { id: "speed", value: "fast" },
  ]);
  assert.equal(encoded, "codex-5.3[reasoning_effort=high,speed=fast]");
  assert.deepEqual(decodeCursorSdkModelValue(encoded), {
    id: "codex-5.3",
    params: [
      { id: "reasoning_effort", value: "high" },
      { id: "speed", value: "fast" },
    ],
  });
});
