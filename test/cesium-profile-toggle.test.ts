import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  shouldShowCesiumProfileToggle,
  visibleCesiumProfiles,
} from "../src/hooks/useCesiumProfileCatalog.ts";

describe("cesium profile toggle visibility", () => {
  const catalog = [
    { id: "code", name: "Code" },
    { id: "work", name: "Work" },
  ];

  test("first-install defaults hide Work and therefore the toggle", () => {
    const visible = visibleCesiumProfiles(catalog, { code: true, work: false });
    assert.deepEqual(
      visible.map((profile) => profile.id),
      ["code"]
    );
    assert.equal(shouldShowCesiumProfileToggle(visible.length), false);
  });

  test("enabling Work brings the new-chat toggle back", () => {
    const visible = visibleCesiumProfiles(catalog, { code: true, work: true });
    assert.deepEqual(
      visible.map((profile) => profile.id),
      ["code", "work"]
    );
    assert.equal(shouldShowCesiumProfileToggle(visible.length), true);
  });

  test("a missing enable map keeps every catalog profile visible", () => {
    const visible = visibleCesiumProfiles(catalog, undefined);
    assert.equal(visible.length, 2);
    assert.equal(shouldShowCesiumProfileToggle(visible.length), true);
  });
});
