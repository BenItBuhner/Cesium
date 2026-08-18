import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInfo } from "../src/lib/types";
import {
  applySelectedToGroup,
  buildBaseModelPickerGroups,
  canSelectBooleanValue,
  selectVariantForParameter,
} from "../src/components/chat/model-picker-variants";

function model(
  id: string,
  name: string,
  parameters?: ModelInfo["variantParameters"]
): ModelInfo {
  return {
    id,
    modelValue: id,
    name,
    provider: "cursor",
    backendId: "cursor-sdk",
    variantGroupId: id.split("[", 1)[0],
    variantGroupName: id.startsWith("fable") ? "Claude Fable 5" : "GPT-5.6 Soul",
    variantParameters: parameters,
  };
}

test("keeps Cursor effort and reasoning controls distinct without inventing Fast", () => {
  const models = [
    model("fable[context=300k,effort=low,thinking=false]", "Claude Fable 5 Low", [
      { id: "context", name: "Context", value: "300k" },
      { id: "effort", name: "Effort", value: "low" },
      { id: "thinking", name: "Reasoning", value: "false" },
    ]),
    model("fable[context=1m,effort=high,thinking=true]", "Claude Fable 5 High True", [
      { id: "context", name: "Context", value: "1m" },
      { id: "effort", name: "Effort", value: "high" },
      { id: "thinking", name: "Reasoning", value: "true" },
    ]),
  ];

  const group = buildBaseModelPickerGroups(models)[0]!;
  assert.deepEqual(
    group.parameters.map((parameter) => parameter.label),
    ["Context", "Effort", "Reasoning"]
  );
  assert.equal(group.parameters.some((parameter) => parameter.label === "Fast"), false);
});

test("does not infer Fast from a trailing true in legacy Cursor display names", () => {
  const models = [
    model(
      "fable[context=300k,reasoning_effort=low,thinking=false]",
      "Claude Fable 5 Low"
    ),
    model(
      "fable[context=300k,reasoning_effort=high,thinking=true]",
      "Claude Fable 5 High True"
    ),
  ].map((entry) => ({ ...entry, variantParameters: undefined }));

  const group = buildBaseModelPickerGroups(models)[0]!;
  assert.deepEqual(
    group.parameters.map((parameter) => parameter.label),
    ["Reasoning Effort", "Reasoning"]
  );
  assert.equal(group.parameters.some((parameter) => parameter.label === "Fast"), false);
});

test("blocks Fast at 1M while preserving valid lower-context variants", () => {
  const variants = [
    model("soul[context=272k,fast=false]", "GPT-5.6 Soul", [
      { id: "context", value: "272k" },
      { id: "fast", value: "false" },
    ]),
    model("soul[context=272k,fast=true]", "GPT-5.6 Soul Fast", [
      { id: "context", value: "272k" },
      { id: "fast", value: "true" },
    ]),
    model("soul[context=1m,fast=false]", "GPT-5.6 Soul 1M", [
      { id: "context", value: "1m" },
      { id: "fast", value: "false" },
    ]),
  ];
  const base = buildBaseModelPickerGroups(variants)[0]!;
  const at272kFast = applySelectedToGroup(base, variants[1]!);
  const at1mVariant = selectVariantForParameter(at272kFast, "context", "1m");
  const at1m = applySelectedToGroup(base, at1mVariant.model);

  assert.equal(at1mVariant.parameters.get("fast")?.value, "false");
  assert.equal(canSelectBooleanValue(at1m, "fast", "true"), false);
  assert.equal(
    canSelectBooleanValue(applySelectedToGroup(base, variants[0]!), "fast", "true"),
    true
  );
});
