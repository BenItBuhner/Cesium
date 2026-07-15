import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  filterSlashMenuSectionsForDisplay,
  filterSlashMenuSections,
  getSlashMenuSections,
} from "../src/lib/composer-suggestions.ts";

describe("composer slash menu", () => {
  test("lists Cesium Agent modes in product order", () => {
    const sections = getSlashMenuSections({
      activeBackend: {
        id: "cesium-agent",
        label: "Cesium Agent",
        available: true,
        capabilities: { supportsModeSelection: true, supportsModelSelection: true },
      },
      modeOptions: [
        { id: "agent", label: "Agent" },
        { id: "plan", label: "Plan" },
        { id: "orchestration", label: "Orchestration" },
        { id: "burn", label: "Burn" },
        { id: "ask", label: "Ask" },
      ],
    });

    const modes = sections.find((section) => section.id === "modes");
    assert.deepEqual(modes?.items.map((item) => item.label), [
      "Agent",
      "Plan",
      "Orchestration",
      "Burn",
      "Ask",
    ]);
  });

  test("filters slash menu modes by slash alias", () => {
    const sections = getSlashMenuSections({
      activeBackend: {
        id: "cesium-agent",
        label: "Cesium Agent",
        available: true,
        capabilities: { supportsModeSelection: true, supportsModelSelection: true },
      },
      modeOptions: [
        { id: "agent", label: "Agent" },
        { id: "plan", label: "Plan" },
        { id: "orchestration", label: "Orchestration" },
        { id: "burn", label: "Burn" },
        { id: "ask", label: "Ask" },
      ],
    });

    const filtered = filterSlashMenuSections(sections, "plan");
    const modes = filtered.find((section) => section.id === "modes");
    assert.deepEqual(
      modes?.items.map((item) => item.action),
      [{ kind: "mode", modeId: "plan" }]
    );
  });

  test("caps visible slash results while preserving total match metadata", () => {
    const models = Array.from({ length: 125 }, (_, index) => ({
      id: `proxy-model-${index}`,
      name: `Proxy Model ${index}`,
      provider: "fixture" as const,
    }));
    const sections = getSlashMenuSections({
      activeBackend: {
        id: "cesium-agent",
        label: "Cesium Agent",
        available: true,
        capabilities: { supportsModeSelection: true, supportsModelSelection: true },
      },
      models,
    });

    const result = filterSlashMenuSectionsForDisplay(sections, "proxy", 40);

    assert.equal(result.totalCount, 125);
    assert.equal(result.visibleCount, 40);
    assert.equal(result.truncated, true);
    assert.equal(
      result.sections.reduce((count, section) => count + section.items.length, 0),
      40
    );
  });
});
