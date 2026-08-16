import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-proactive-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;

const [
  { parseCronExpression, nextCronRunAfter },
  {
    CESIUM_TRIGGER_MIN_INTERVAL_MS,
    CESIUM_TRIGGERS_MAX_PER_WORKSPACE,
    attachCesiumTriggerConversation,
    computeNextRunAt,
    createCesiumTrigger,
    deleteCesiumTrigger,
    formatTriggerPromptPreamble,
    listCesiumTriggers,
    markCesiumTriggerFired,
    normalizeTriggerSchedule,
    updateCesiumTrigger,
  },
  {
    CESIUM_AUTHORED_SKILLS_DIR,
    createAuthoredSkill,
    deleteAuthoredSkill,
    listAuthorableSkills,
    readSkillById,
    updateAuthoredSkill,
  },
  { parseSkillFrontmatter },
  {
    CESIUM_WORK_PROFILE,
    CESIUM_PROFILE_TOOL_GROUPS,
    filterCesiumToolsForProfile,
  },
  { resolveCesiumTools },
  { resolveCesiumModeToolPolicy },
] = await Promise.all([
  import("../src/lib/agents/cesium-cron.js"),
  import("../src/lib/agents/cesium-triggers.js"),
  import("../src/lib/agents/cesium-skill-authoring.js"),
  import("../src/lib/agents/workspace-skills.js"),
  import("../src/lib/agents/cesium-profiles.js"),
  import("../src/lib/agents/cesium/cesium-tools.js"),
  import("../src/lib/agents/cesium-mode-policy.js"),
]);

after(async () => {
  const fs = await import("node:fs/promises");
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Cron engine
// ---------------------------------------------------------------------------

test("parseCronExpression accepts classic syntax and rejects garbage", () => {
  assert.ok(parseCronExpression("* * * * *"));
  assert.ok(parseCronExpression("*/5 0-12 1,15 jan-jun mon-fri"));
  assert.ok(parseCronExpression("30 14 * * 7")); // 7 == Sunday
  assert.throws(() => parseCronExpression("* * * *"), /5 fields/);
  assert.throws(() => parseCronExpression("60 * * * *"), /out of range/);
  assert.throws(() => parseCronExpression("* * * * 8"), /out of range/);
  assert.throws(() => parseCronExpression("*/0 * * * *"), /step/i);
  assert.throws(() => parseCronExpression("a * * * *"), /Invalid cron value/);
  assert.throws(() => parseCronExpression("5-1 * * * *"), /out of range/);
});

test("nextCronRunAfter computes the next occurrence in local time", () => {
  // Wednesday 2026-08-19 10:30 local.
  const from = new Date(2026, 7, 19, 10, 30, 0).getTime();

  // Every 15 minutes -> 10:45.
  assert.equal(
    nextCronRunAfter(parseCronExpression("*/15 * * * *"), from),
    new Date(2026, 7, 19, 10, 45, 0).getTime()
  );

  // Daily 09:00 -> tomorrow 09:00.
  assert.equal(
    nextCronRunAfter(parseCronExpression("0 9 * * *"), from),
    new Date(2026, 7, 20, 9, 0, 0).getTime()
  );

  // Weekdays 09:00 from Friday 12:00 -> Monday 09:00.
  const friday = new Date(2026, 7, 21, 12, 0, 0).getTime();
  assert.equal(
    nextCronRunAfter(parseCronExpression("0 9 * * mon-fri"), friday),
    new Date(2026, 7, 24, 9, 0, 0).getTime()
  );

  // First of the month 00:00 -> September 1st.
  assert.equal(
    nextCronRunAfter(parseCronExpression("0 0 1 * *"), from),
    new Date(2026, 8, 1, 0, 0, 0).getTime()
  );

  // A time exactly on the boundary fires at the NEXT occurrence, not now.
  const onBoundary = new Date(2026, 7, 19, 9, 0, 0).getTime();
  assert.equal(
    nextCronRunAfter(parseCronExpression("0 9 * * *"), onBoundary),
    new Date(2026, 7, 20, 9, 0, 0).getTime()
  );
});

test("cron dom/dow follow classic OR semantics when both are restricted", () => {
  // "0 0 13 * fri": fires on the 13th OR any Friday.
  const schedule = parseCronExpression("0 0 13 * fri");
  // From Wed 2026-08-12: next is Thu 13th (dom match), not Friday.
  const from = new Date(2026, 7, 12, 12, 0, 0).getTime();
  assert.equal(
    nextCronRunAfter(schedule, from),
    new Date(2026, 7, 13, 0, 0, 0).getTime()
  );
  // From the 13th: next is Friday the 14th (dow match).
  const fromThe13th = new Date(2026, 7, 13, 12, 0, 0).getTime();
  assert.equal(
    nextCronRunAfter(schedule, fromThe13th),
    new Date(2026, 7, 14, 0, 0, 0).getTime()
  );
});

// ---------------------------------------------------------------------------
// Trigger store
// ---------------------------------------------------------------------------

test("normalizeTriggerSchedule validates all three kinds", () => {
  assert.deepEqual(normalizeTriggerSchedule({ kind: "cron", expression: "0 9 * * *" }), {
    kind: "cron",
    expression: "0 9 * * *",
  });
  assert.deepEqual(normalizeTriggerSchedule({ kind: "interval", everyMs: 120_000 }), {
    kind: "interval",
    everyMs: 120_000,
  });
  assert.throws(
    () => normalizeTriggerSchedule({ kind: "interval", everyMs: 5_000 }),
    /one minute/
  );
  assert.throws(() => normalizeTriggerSchedule({ kind: "cron", expression: "nope" }), /5 fields/);
  assert.throws(() => normalizeTriggerSchedule({ kind: "once", atMs: -5 }), /atMs/);
  assert.throws(() => normalizeTriggerSchedule({ kind: "quantum" }), /must be/);
});

test("trigger CRUD round-trip with fire bookkeeping", async () => {
  const workspaceId = "ws-triggers";
  const created = await createCesiumTrigger({
    workspaceId,
    name: "Morning briefing",
    prompt: "Summarize what changed overnight.",
    schedule: { kind: "interval", everyMs: CESIUM_TRIGGER_MIN_INTERVAL_MS },
    profileId: "work",
    mode: "agent",
    modelId: "techlit/kimi-k3",
    modelName: "Techlit/Kimi K3",
  });
  assert.ok(created.id);
  assert.equal(created.enabled, true);
  assert.equal(created.runCount, 0);
  assert.ok(created.nextRunAt != null && created.nextRunAt > Date.now() - 1000);

  const listed = await listCesiumTriggers(workspaceId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.profileId, "work");
  // Model pinning survives the persistence round-trip so scheduled fires
  // reuse the creating conversation's provider instead of a static default.
  assert.equal(listed[0]!.modelId, "techlit/kimi-k3");
  assert.equal(listed[0]!.modelName, "Techlit/Kimi K3");

  // Fire: runCount increments exactly once; nextRunAt re-arms.
  const firedAt = Date.now();
  const fired = await markCesiumTriggerFired({ workspaceId, id: created.id, firedAt });
  assert.equal(fired!.runCount, 1);
  assert.equal(fired!.lastFiredAt, firedAt);
  assert.ok(fired!.nextRunAt != null && fired!.nextRunAt > firedAt);

  // Attaching the conversation id must NOT bump runCount.
  await attachCesiumTriggerConversation({
    workspaceId,
    id: created.id,
    conversationId: "conv-123",
  });
  const attached = (await listCesiumTriggers(workspaceId)).find((t) => t.id === created.id);
  assert.equal(attached!.runCount, 1);
  assert.equal(attached!.lastConversationId, "conv-123");

  // Pause via update; re-enable re-arms nextRunAt.
  const paused = await updateCesiumTrigger({
    workspaceId,
    id: created.id,
    patch: { enabled: false },
  });
  assert.equal(paused.enabled, false);
  const resumed = await updateCesiumTrigger({
    workspaceId,
    id: created.id,
    patch: { enabled: true },
  });
  assert.equal(resumed.enabled, true);
  assert.ok(resumed.nextRunAt != null);

  const removed = await deleteCesiumTrigger({ workspaceId, id: created.id });
  assert.equal(removed!.id, created.id);
  assert.deepEqual(await listCesiumTriggers(workspaceId), []);
});

test("one-shot triggers disable themselves after firing and maxRuns caps fires", async () => {
  const workspaceId = "ws-oneshot";
  const atMs = Date.now() + 60_000;
  const once = await createCesiumTrigger({
    workspaceId,
    name: "One-time reminder",
    prompt: "Follow up on the report.",
    schedule: { kind: "once", atMs },
  });
  assert.equal(once.maxRuns, 1);
  assert.equal(once.nextRunAt, atMs);
  const fired = await markCesiumTriggerFired({ workspaceId, id: once.id, firedAt: atMs });
  assert.equal(fired!.enabled, false);
  assert.equal(fired!.nextRunAt, null);

  const capped = await createCesiumTrigger({
    workspaceId,
    name: "Twice only",
    prompt: "Do the thing.",
    schedule: { kind: "interval", everyMs: 60_000 },
    maxRuns: 2,
  });
  const first = await markCesiumTriggerFired({ workspaceId, id: capped.id, firedAt: Date.now() });
  assert.equal(first!.enabled, true);
  const second = await markCesiumTriggerFired({ workspaceId, id: capped.id, firedAt: Date.now() });
  assert.equal(second!.enabled, false);
  assert.equal(second!.runCount, 2);
});

test("trigger store enforces caps and clamps", async () => {
  const workspaceId = "ws-caps";
  const longName = "n".repeat(500);
  const longPrompt = "p".repeat(10_000);
  const created = await createCesiumTrigger({
    workspaceId,
    name: longName,
    prompt: longPrompt,
    schedule: { kind: "interval", everyMs: 60_000 },
  });
  assert.equal(created.name.length, 80);
  assert.equal(created.prompt.length, 4_000);
  assert.throws(
    () => normalizeTriggerSchedule({ kind: "once", atMs: Number.NaN }),
    /atMs/
  );
  // A "once" schedule in the past has no future occurrence.
  assert.equal(computeNextRunAt({ kind: "once", atMs: Date.now() - 1000 }, Date.now()), null);
  await assert.rejects(
    createCesiumTrigger({
      workspaceId,
      name: "past",
      prompt: "x",
      schedule: { kind: "once", atMs: Date.now() - 1000 },
    }),
    /no future occurrence/
  );
  assert.ok(CESIUM_TRIGGERS_MAX_PER_WORKSPACE >= 10);
});

test("trigger prompt preamble carries provenance and the trigger id", async () => {
  const workspaceId = "ws-preamble";
  const trigger = await createCesiumTrigger({
    workspaceId,
    name: "Digest",
    prompt: "Compile the digest.",
    schedule: { kind: "interval", everyMs: 60_000 },
  });
  const text = formatTriggerPromptPreamble(trigger, Date.now());
  assert.match(text, /Scheduled trigger "Digest" fired at/);
  assert.match(text, /woken by the trigger scheduler/);
  assert.ok(text.includes(trigger.id));
  assert.ok(text.endsWith("Compile the digest."));
});

// ---------------------------------------------------------------------------
// Skill authoring
// ---------------------------------------------------------------------------

async function makeWorkspaceRoot(label: string): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), `cesium-skills-${label}-`));
}

test("createAuthoredSkill writes a valid SKILL.md and refreshes the mirror", async () => {
  const root = await makeWorkspaceRoot("create");
  const created = await createAuthoredSkill({
    workspaceRoot: root,
    name: "Weekly Digest",
    description: "Use when compiling the weekly project digest.",
    instructions: "1. Search conversations from the last week.\n2. Compile highlights.",
  });
  assert.equal(created.id, "weekly-digest");
  assert.equal(created.relativePath, ".agents/skills/weekly-digest/SKILL.md");

  const markdown = await readFile(path.join(root, created.relativePath), "utf8");
  const frontmatter = parseSkillFrontmatter(markdown);
  assert.equal(frontmatter.name, "weekly-digest");
  assert.equal(frontmatter.description, "Use when compiling the weekly project digest.");
  assert.ok(markdown.includes("# Weekly Digest"));
  assert.ok(markdown.includes("Search conversations"));

  // Mirror refreshed: agent-skills/_index.md lists the new skill.
  const index = await readFile(path.join(root, "agent-skills", "_index.md"), "utf8");
  assert.ok(index.includes("weekly-digest"));
  await access(path.join(root, "agent-skills", "weekly-digest", "SKILL.md"));

  // Duplicate ids are refused.
  await assert.rejects(
    createAuthoredSkill({
      workspaceRoot: root,
      name: "Weekly Digest",
      description: "dupe",
      instructions: "dupe",
    }),
    /already exists/
  );
});

test("updateAuthoredSkill edits fields in place; read returns the markdown", async () => {
  const root = await makeWorkspaceRoot("update");
  await createAuthoredSkill({
    workspaceRoot: root,
    name: "Deploy Notes",
    description: "Use when writing deploy notes.",
    instructions: "Original body.",
  });
  const updated = await updateAuthoredSkill({
    workspaceRoot: root,
    id: "deploy-notes",
    instructions: "Refined body with more steps.",
  });
  assert.equal(updated.description, "Use when writing deploy notes.");
  const { skill, markdown } = await readSkillById({ workspaceRoot: root, id: "deploy-notes" });
  assert.equal(skill.authored, true);
  assert.ok(markdown.includes("Refined body with more steps."));
  assert.ok(!markdown.includes("Original body."));
});

test("non-authored skills are readable but immutable to the agent", async () => {
  const root = await makeWorkspaceRoot("readonly");
  // Simulate a user-managed Cursor skill.
  const cursorSkillDir = path.join(root, ".cursor", "skills", "hand-made");
  await mkdir(cursorSkillDir, { recursive: true });
  await writeFile(
    path.join(cursorSkillDir, "SKILL.md"),
    `---\nname: hand-made\ndescription: A user-authored skill.\n---\n\n# Hand Made\n\nBody.\n`,
    "utf8"
  );
  const skills = await listAuthorableSkills(root);
  const handMade = skills.find((skill) => skill.name === "hand-made");
  assert.ok(handMade);
  assert.equal(handMade!.authored, false);
  await assert.rejects(
    updateAuthoredSkill({ workspaceRoot: root, id: "hand-made", instructions: "hijack" }),
    /read-only/
  );
  await assert.rejects(deleteAuthoredSkill({ workspaceRoot: root, id: "hand-made" }), /cannot be deleted/);
  // Reading still works.
  const { markdown } = await readSkillById({ workspaceRoot: root, id: "hand-made" });
  assert.ok(markdown.includes("Hand Made"));
});

test("deleteAuthoredSkill removes the skill and its mirror entry", async () => {
  const root = await makeWorkspaceRoot("delete");
  await createAuthoredSkill({
    workspaceRoot: root,
    name: "Ephemeral",
    description: "Use never.",
    instructions: "Body.",
  });
  await deleteAuthoredSkill({ workspaceRoot: root, id: "ephemeral" });
  const skills = await listAuthorableSkills(root);
  assert.equal(skills.find((skill) => skill.name === "ephemeral"), undefined);
  const index = await readFile(path.join(root, "agent-skills", "_index.md"), "utf8");
  assert.ok(!index.includes("ephemeral"));
  await assert.rejects(
    readSkillById({ workspaceRoot: root, id: "ephemeral" }),
    /No skill with id/
  );
});

test("skill validation clamps and rejects empty fields", async () => {
  const root = await makeWorkspaceRoot("validation");
  await assert.rejects(
    createAuthoredSkill({ workspaceRoot: root, name: "", description: "d", instructions: "i" }),
    /name/
  );
  await assert.rejects(
    createAuthoredSkill({ workspaceRoot: root, name: "x", description: "", instructions: "i" }),
    /description/
  );
  await assert.rejects(
    createAuthoredSkill({
      workspaceRoot: root,
      name: "x",
      description: "d".repeat(600),
      instructions: "i",
    }),
    /500/
  );
  await assert.rejects(
    createAuthoredSkill({
      workspaceRoot: root,
      name: "x",
      description: "d",
      instructions: "i".repeat(30_000),
    }),
    /24000|24,000/
  );
});

// ---------------------------------------------------------------------------
// Profile / policy wiring
// ---------------------------------------------------------------------------

test("skill and schedule are first-class tools in the Work envelope", () => {
  assert.ok(CESIUM_WORK_PROFILE.tools.allowed !== "all");
  const allowed = new Set(CESIUM_WORK_PROFILE.tools.allowed as string[]);
  assert.ok(allowed.has("skill"));
  assert.ok(allowed.has("schedule"));

  const groups = new Map(CESIUM_PROFILE_TOOL_GROUPS.map((group) => [group.id, group.tools]));
  assert.deepEqual(groups.get("skills"), ["skill"]);
  assert.deepEqual(groups.get("automation"), ["schedule"]);

  const harness = resolveCesiumTools({ features: { subagents: { version: 1 } } });
  const names = new Set(harness.tools.map((tool) => tool.name));
  assert.ok(names.has("skill"));
  assert.ok(names.has("schedule"));

  const advertised = new Set(
    filterCesiumToolsForProfile(harness.tools, CESIUM_WORK_PROFILE).map((tool) => tool.name)
  );
  assert.ok(advertised.has("skill"));
  assert.ok(advertised.has("schedule"));
});

test("mode policy: skill/schedule blocked in ask mode, allowed in agent and orchestration", () => {
  for (const toolName of ["skill", "schedule"]) {
    assert.equal(resolveCesiumModeToolPolicy({ mode: "ask", toolName }).allowed, false);
    assert.equal(resolveCesiumModeToolPolicy({ mode: "agent", toolName }).allowed, true);
    assert.equal(
      resolveCesiumModeToolPolicy({ mode: "orchestration", toolName }).allowed,
      true
    );
  }
});
