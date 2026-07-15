import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  planMarkdownFromEntries,
  providerPlanEvents,
  writeProviderPlanArtifact,
} from "../src/lib/agents/plan-artifacts.js";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("planMarkdownFromEntries writes checklist markdown", () => {
  assert.equal(
    planMarkdownFromEntries({
      title: "Harness plan",
      overview: "Tighten provider contracts.",
      entries: [
        { id: "a", content: "Normalize tools", status: "in_progress" },
        { id: "b", content: "Add fixtures", status: "completed" },
        { id: "c", content: "Investigate auth", status: "blocked" },
      ],
    }),
    [
      "# Harness plan",
      "",
      "Tighten provider contracts.",
      "",
      "- [~] Normalize tools",
      "- [x] Add fixtures",
      "- [!] Investigate auth",
      "",
    ].join("\n")
  );
});

test("writeProviderPlanArtifact stores provider plans under .cesium/plans", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cesium-plan-artifact-"));
  roots.push(root);
  const artifact = await writeProviderPlanArtifact({
    workspaceRoot: root,
    backendId: "codex-app-server",
    title: "Codex sweep",
    entries: [{ id: "one", content: "Mirror plans", status: "pending" }],
  });

  assert.match(artifact.path, /^\.cesium\/plans\/codex\/codex-sweep.*\.plan\.md$/);
  assert.equal(
    await readFile(path.join(root, artifact.path), "utf8"),
    "# Codex sweep\n\n- [ ] Mirror plans\n"
  );
  assert.deepEqual(artifact.entries, [
    { id: "plan-item-3", content: "Mirror plans", status: "pending" },
  ]);
});

test("providerPlanEvents emits a plan_file and checklist plan", () => {
  const events = providerPlanEvents({
    conversationId: "c1",
    planId: "p1",
    artifact: {
      path: ".cesium/plans/cursor-sdk/example.plan.md",
      title: "Example",
      entries: [{ id: "e1", content: "Do it", status: "pending" }],
    },
  });

  assert.equal(events[0]?.kind, "plan_file");
  assert.equal(events[1]?.kind, "plan");
});
