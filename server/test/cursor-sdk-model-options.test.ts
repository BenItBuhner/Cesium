import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeCursorSdkModelValue,
  encodeCursorSdkModelValue,
} from "../src/lib/agents/cursor-sdk-model-selection.js";
import { cursorSdkModelSelectionFromConfig } from "../src/lib/agents/cursor-sdk-provider.js";
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

test("Cursor SDK preserves independent parameter identities and effective defaults", () => {
  const options = cursorSdkConfigOptionsFromModels([
    {
      id: "claude-fable-5",
      displayName: "Claude Fable 5",
      parameters: [
        {
          id: "context",
          displayName: "Context",
          values: [{ value: "300k" }, { value: "1m" }],
        },
        {
          id: "reasoning_effort",
          displayName: "Effort",
          values: [{ value: "low" }, { value: "high" }],
        },
        {
          id: "thinking",
          displayName: "Reasoning",
          values: [{ value: "false", displayName: "Off" }, { value: "true", displayName: "On" }],
        },
      ],
      variants: [
        {
          displayName: "Low",
          isDefault: true,
          params: [
            { id: "context", value: "300k" },
            { id: "reasoning_effort", value: "low" },
          ],
        },
        {
          displayName: "High Thinking",
          params: [
            { id: "context", value: "1m" },
            { id: "reasoning_effort", value: "high" },
            { id: "thinking", value: "true" },
          ],
        },
      ],
    },
  ]);
  const rows = options.find((option) => option.id === "model")?.options;
  assert.ok(rows);
  assert.deepEqual(rows[0]?.modelParameters, [
    { id: "context", name: "Context", value: "300k" },
    { id: "reasoning_effort", name: "Effort", value: "low" },
    { id: "thinking", name: "Reasoning", value: "false", valueName: "Off" },
  ]);
  assert.deepEqual(
    rows[1]?.modelParameters?.map(({ id, value }) => ({ id, value })),
    [
      { id: "context", value: "1m" },
      { id: "reasoning_effort", value: "high" },
      { id: "thinking", value: "true" },
    ]
  );
  assert.equal(rows.some((row) => row.modelParameters?.some((param) => param.id === "fast")), false);
});

test("Cursor SDK does not synthesize Fast combinations at a 1M context", () => {
  const options = cursorSdkConfigOptionsFromModels([
    {
      id: "gpt-5.6-soul",
      displayName: "GPT-5.6 Soul",
      parameters: [
        {
          id: "context",
          values: [{ value: "272k" }, { value: "1m" }],
        },
        {
          id: "fast",
          values: [{ value: "false" }, { value: "true" }],
        },
      ],
    },
  ]);
  const values = options.find((option) => option.id === "model")?.options.map((row) => row.value);
  assert.deepEqual(values, [
    "gpt-5.6-soul[context=272k,fast=false]",
    "gpt-5.6-soul[context=272k,fast=true]",
    "gpt-5.6-soul[context=1m,fast=false]",
  ]);
});

test("Cursor SDK rejects stale model combinations before sending them", () => {
  const selection = cursorSdkModelSelectionFromConfig(
    {
      config: {
        modelId: "gpt-5.6-soul[context=1m,fast=true]",
      },
    } as never,
    [
      {
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "gpt-5.6-soul[context=1m,fast=false]",
        options: [
          {
            value: "gpt-5.6-soul[context=1m,fast=false]",
            name: "GPT-5.6 Soul",
          },
        ],
      },
    ]
  );
  assert.deepEqual(selection, {
    id: "gpt-5.6-soul",
    params: [
      { id: "context", value: "1m" },
      { id: "fast", value: "false" },
    ],
  });
});
