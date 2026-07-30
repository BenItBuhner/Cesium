import assert from "node:assert/strict";
import test from "node:test";
import {
  generateGauntletScript,
  gauntletToFlatTurns,
  gauntletToScenario,
} from "../bench/compaction/gauntlet.js";

test("gauntlet generation is deterministic per seed and differs across seeds", () => {
  const a1 = generateGauntletScript({ preset: "s", seed: 1 });
  const a2 = generateGauntletScript({ preset: "s", seed: 1 });
  const b = generateGauntletScript({ preset: "s", seed: 2 });
  assert.deepEqual(
    a1.probes.map((probe) => probe.id),
    a2.probes.map((probe) => probe.id)
  );
  assert.deepEqual(gauntletToFlatTurns(a1), gauntletToFlatTurns(a2));
  assert.notDeepEqual(
    a1.probes.map((probe) => probe.id),
    b.probes.map((probe) => probe.id)
  );
});

test("gauntlet presets scale and terminate (bounded entity namespaces)", () => {
  for (const preset of ["s", "m", "l"] as const) {
    const script = generateGauntletScript({ preset, seed: 7 });
    assert.ok(script.facts.length > 0);
    assert.ok(script.turns.length > 0);
    assert.ok(script.probes.length >= 30);
  }
  const large = generateGauntletScript({ preset: "l", seed: 7 });
  assert.ok(large.facts.length >= 1400);
});

test("gauntlet probes are answerable from planted material", () => {
  const script = generateGauntletScript({ preset: "s", seed: 11 });
  const flat = gauntletToFlatTurns(script).join("\n");
  for (const probe of script.probes) {
    if (probe.category === "absent") {
      // Absent probes must NOT be answerable.
      for (const expected of probe.expected) {
        assert.equal(expected, "unknown");
      }
      continue;
    }
    // At least one accepted answer must literally appear in the fed text.
    assert.ok(
      probe.expected.some((expected) => flat.includes(expected)),
      `probe ${probe.id} (${probe.category}) has no planted answer: ${probe.expected.join(", ")}`
    );
  }
});

test("latest-value probes expect the final revision, not an earlier one", () => {
  const script = generateGauntletScript({ preset: "m", seed: 13 });
  const factById = new Map(script.facts.map((fact) => [fact.id, fact]));
  for (const probe of script.probes) {
    if (probe.category !== "latest-value") continue;
    const factId = probe.id.replace(/^latest-/, "");
    const fact = factById.get(factId);
    assert.ok(fact, `no fact for ${probe.id}`);
    assert.ok(fact!.values.length > 1, "latest-value probes must target revised facts");
    assert.deepEqual(probe.expected, [fact!.values[fact!.values.length - 1]]);
  }
});

test("event and flat materializations carry the same planted answers", () => {
  const script = generateGauntletScript({ preset: "s", seed: 17 });
  const scenario = gauntletToScenario(script);
  const eventText = scenario.events
    .map((event) => JSON.stringify(event))
    .join("\n");
  const flatText = gauntletToFlatTurns(script).join("\n");
  for (const probe of script.probes) {
    if (probe.category === "absent") continue;
    const inEvents = probe.expected.some((expected) => eventText.includes(expected));
    const inFlat = probe.expected.some((expected) => flatText.includes(expected));
    assert.ok(inEvents, `probe ${probe.id} answer missing from event materialization`);
    assert.ok(inFlat, `probe ${probe.id} answer missing from flat materialization`);
  }
});
