import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applyComposerDirectives,
  getActiveSlashQuery,
} from "../packages/core/src/composer-suggestions.ts";

describe("composer directives (shared core)", () => {
  test("applyComposerDirectives consumes bare mode and model lines", () => {
    const modes: string[] = [];
    const models: string[] = [];
    const remaining = applyComposerDirectives("/plan\n/model gpt-5.1\nShip it", {
      modeOptions: [
        { id: "agent", label: "Agent" },
        { id: "plan", label: "Plan" },
      ],
      models: [
        { id: "gpt-5.1", name: "GPT-5.1", provider: "openai", modelValue: "gpt-5.1" },
      ],
      backends: [],
      onModeChange: (modeId) => modes.push(modeId),
      onModelChange: (model) => models.push(model.id),
      onBackendChange: () => undefined,
    });
    assert.deepEqual(modes, ["plan"]);
    assert.deepEqual(models, ["gpt-5.1"]);
    assert.equal(remaining, "Ship it");
  });

  test("getActiveSlashQuery detects slash token on the current line", () => {
    assert.equal(getActiveSlashQuery("/pl"), "pl");
    assert.equal(getActiveSlashQuery("hello\n/model gp"), "gp");
    assert.equal(getActiveSlashQuery("no slash here"), null);
  });
});
