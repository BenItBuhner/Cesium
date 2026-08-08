import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildArtifactEmbedTag,
  matchArtifactEmbedLine,
} from "../src/lib/artifact-embed";

test("matchArtifactEmbedLine matches [[artifact:id]] lines", () => {
  assert.equal(matchArtifactEmbedLine("[[artifact:sales-chart-a1b2c3]]"), "sales-chart-a1b2c3");
  assert.equal(matchArtifactEmbedLine("  [[artifact:demo-1]]  "), "demo-1");
  assert.equal(matchArtifactEmbedLine("[[ARTIFACT:Demo-1]]"), "demo-1");
});

test("matchArtifactEmbedLine matches <artifact id=…/> tag lines", () => {
  assert.equal(matchArtifactEmbedLine('<artifact id="mini-site-9f" />'), "mini-site-9f");
  assert.equal(matchArtifactEmbedLine("<artifact id='mini-site-9f'/>"), "mini-site-9f");
  assert.equal(
    matchArtifactEmbedLine('<artifact id="mini-site-9f"></artifact>'),
    "mini-site-9f"
  );
});

test("matchArtifactEmbedLine is streaming-safe: partial or inline tags do not match", () => {
  assert.equal(matchArtifactEmbedLine("[[artifact:demo"), null);
  assert.equal(matchArtifactEmbedLine("[[artifact:demo-1]] plus trailing prose"), null);
  assert.equal(matchArtifactEmbedLine("see [[artifact:demo-1]]"), null);
  assert.equal(matchArtifactEmbedLine("[[artifact:]]"), null);
  assert.equal(matchArtifactEmbedLine("[[artifact:bad id with spaces]]"), null);
  assert.equal(matchArtifactEmbedLine(""), null);
});

test("buildArtifactEmbedTag round-trips through the matcher", () => {
  const tag = buildArtifactEmbedTag("inflation-vs-rates-0a1b2c");
  assert.equal(matchArtifactEmbedLine(tag), "inflation-vs-rates-0a1b2c");
});
