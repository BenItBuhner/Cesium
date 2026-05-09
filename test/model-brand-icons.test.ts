import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ModelInfo } from "../src/lib/types";
import {
  isAutoModel,
  modelIconHaystack,
  resolveModelBrandIcon,
} from "../src/lib/model-brand-icons";

function m(partial: Partial<ModelInfo> & Pick<ModelInfo, "name" | "id">): ModelInfo {
  return {
    provider: "openai",
    ...partial,
  };
}

describe("model-brand-icons", () => {
  test("auto and efficiency/performance yield no icon", () => {
    assert.equal(
      resolveModelBrandIcon(m({ name: "Auto", id: "auto", modelValue: "auto" })).kind,
      "none"
    );
    assert.ok(isAutoModel(m({ name: "Auto", id: "x", modelValue: "auto" })));
    assert.equal(resolveModelBrandIcon(m({ name: "Foo Efficiency", id: "a" })).kind, "none");
    assert.equal(resolveModelBrandIcon(m({ name: "Foo", id: "performance-tier" })).kind, "none");
  });

  test("openai gpt and anthropic claude", () => {
    assert.deepEqual(resolveModelBrandIcon(m({ name: "ChatGPT 4", id: "a" })), {
      kind: "brand",
      brand: "openai",
    });
    assert.deepEqual(resolveModelBrandIcon(m({ name: "opus-4", id: "anthropic/x", provider: "anthropic" })), {
      kind: "brand",
      brand: "anthropic",
    });
  });

  test("meta: muse spark and llama; codex spark is not meta", () => {
    assert.deepEqual(resolveModelBrandIcon(m({ name: "Muse Spark Fast", id: "a" })), {
      kind: "brand",
      brand: "meta",
    });
    assert.deepEqual(resolveModelBrandIcon(m({ name: "LLaMA 3", id: "a" })), {
      kind: "brand",
      brand: "meta",
    });
    assert.deepEqual(resolveModelBrandIcon(m({ name: "GPT-5.3 Codex Spark", id: "a" })), {
      kind: "brand",
      brand: "openai",
    });
  });

  test("earliest keyword in string wins over later families", () => {
    assert.deepEqual(
      resolveModelBrandIcon(
        m({ name: "DeepSeek R1 Distilled Llama 70B", id: "a" })
      ),
      { kind: "brand", brand: "deepseek" }
    );
    assert.deepEqual(
      resolveModelBrandIcon(
        m({ name: "Franken", id: "x", modelValue: "gpt-4 with claude backup" })
      ),
      { kind: "brand", brand: "openai" }
    );
  });

  test("hunyuan: Hy3 series matches hy+digit, not whole-word hy (hybrid stays default)", () => {
    assert.deepEqual(resolveModelBrandIcon(m({ name: "Openrouter/Hy3 preview", id: "a" })), {
      kind: "brand",
      brand: "hunyuan",
    });
    assert.deepEqual(
      resolveModelBrandIcon(m({ name: "Some Hybrid Model", id: "b" })),
      { kind: "default" }
    );
  });

  test("default box when nothing matches", () => {
    assert.deepEqual(resolveModelBrandIcon(m({ name: "Custom Local", id: "local/7b" })), {
      kind: "default",
    });
  });

  test("modelIconHaystack folds id and modelValue", () => {
    const h = modelIconHaystack(m({ name: "X", id: "y", modelValue: "z-grok-beta" }));
    assert.ok(h.includes("grok"));
  });
});
