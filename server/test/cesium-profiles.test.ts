import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-profiles-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GOOGLE_API_KEY;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;

const [
  {
    CESIUM_CODE_PROFILE,
    CESIUM_WORK_PROFILE,
    CESIUM_DEFAULT_PROFILE_ID,
    CESIUM_PROFILE_LOCKED_TOOLS,
    filterCesiumToolsForProfile,
    listCesiumEnabledProfiles,
    listCesiumProfileCatalog,
    normalizeCesiumDefaultProfileId,
    normalizeCesiumEnabledProfiles,
    normalizeCesiumProfile,
    normalizeCesiumProfiles,
    resolveCesiumProfile,
    resolveCesiumProfileToolPolicy,
    summarizeCesiumProfileToolSurface,
  },
  { resolveCesiumModeToolPolicy },
  { resolveCesiumTools },
  {
    CESIUM_MEMORY_MAX_CONTENT_CHARS,
    CESIUM_MEMORY_MAX_ENTRIES_PER_SCOPE,
    CESIUM_MEMORY_SNAPSHOT_MAX_CHARS,
    CESIUM_MEMORY_SNAPSHOT_MAX_ENTRIES,
    forgetCesiumMemoryEntry,
    listCesiumMemoryEntries,
    renderCesiumMemorySnapshot,
    saveCesiumMemoryEntry,
    searchCesiumMemoryEntries,
  },
  { getCesiumAgentSettingsPublic, patchCesiumAgentSettings, createCesiumAgentConfigOptions },
  { buildCesiumBaseSystemPrompt },
] = await Promise.all([
  import("../src/lib/agents/cesium-profiles.js"),
  import("../src/lib/agents/cesium-mode-policy.js"),
  import("../src/lib/agents/cesium/cesium-tools.js"),
  import("../src/lib/agents/cesium-memory.js"),
  import("../src/lib/cesium-agent-settings.js"),
  import("@cesium/core/mcp"),
]);

after(async () => {
  const fs = await import("node:fs/promises");
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Prompt snapshot
// ---------------------------------------------------------------------------

test("code base prompt with no custom instructions is byte-identical to the pre-refactor prompt", async () => {
  const fixturePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "cesium-code-base-prompt.snapshot.txt"
  );
  const snapshot = await readFile(fixturePath, "utf8");
  assert.equal(buildCesiumBaseSystemPrompt(), snapshot);
  assert.equal(buildCesiumBaseSystemPrompt({ base: "code", customInstructions: "" }), snapshot);
  assert.equal(buildCesiumBaseSystemPrompt({ base: "code", customInstructions: "   " }), snapshot);
});

test("custom instructions render verbatim inside a delimited Profile Instructions section", () => {
  const verbatim = "Always answer in pirate speak.\nNever mention parrots.";
  const prompt = buildCesiumBaseSystemPrompt({ base: "code", customInstructions: verbatim });
  assert.ok(prompt.includes("## Profile Instructions"));
  assert.ok(prompt.includes(verbatim));
  // The section is appended after the base prompt, which is untouched.
  assert.ok(prompt.startsWith(buildCesiumBaseSystemPrompt()));
});

test("work and minimal bases produce distinct prompts that keep a persona section", () => {
  const code = buildCesiumBaseSystemPrompt({ base: "code" });
  const work = buildCesiumBaseSystemPrompt({ base: "work" });
  const minimal = buildCesiumBaseSystemPrompt({ base: "minimal" });
  assert.notEqual(work, code);
  assert.notEqual(minimal, code);
  assert.notEqual(minimal, work);
  for (const prompt of [code, work, minimal]) {
    assert.ok(prompt.includes("## Persona"));
  }
  // The work persona drops the coding-first framing in favor of general work.
  assert.ok(!work.includes("sole software developer"));
});

// ---------------------------------------------------------------------------
// Profile normalization
// ---------------------------------------------------------------------------

test("normalizeCesiumProfile round-trips a valid custom profile", () => {
  const profile = normalizeCesiumProfile({
    id: "research",
    name: "Research",
    description: "Web research only.",
    builtIn: true, // persisted records can never claim built-in status
    prompt: { base: "work", customInstructions: "Cite sources." },
    tools: { allowed: ["call_mcp_tool", "memory"], mcpServers: ["browser", "Notion"] },
    permissionOverrides: { terminal: "deny", editFile: "ask" },
  });
  assert.ok(profile);
  assert.equal(profile!.id, "research");
  assert.equal(profile!.builtIn, false);
  assert.equal(profile!.prompt.base, "work");
  assert.equal(profile!.prompt.customInstructions, "Cite sources.");
  assert.ok(Array.isArray(profile!.tools.allowed));
  const allowed = new Set(profile!.tools.allowed as string[]);
  assert.ok(allowed.has("call_mcp_tool"));
  assert.ok(allowed.has("memory"));
  // MCP server ids are lowercased for stable comparison.
  assert.deepEqual([...(profile!.tools.mcpServers as string[])].sort(), ["browser", "notion"]);
  assert.deepEqual(profile!.permissionOverrides, { terminal: "deny", editFile: "ask" });
});

test("normalizeCesiumProfile drops unknown tools and always re-adds locked core tools", () => {
  const profile = normalizeCesiumProfile({
    id: "hostile",
    name: "Hostile",
    prompt: { base: "minimal", customInstructions: "" },
    // Hostile allowlist: junk names, and none of the locked core tools.
    tools: { allowed: ["not_a_tool", "rm_rf", "terminal"], mcpServers: "all" },
  });
  assert.ok(profile);
  const allowed = new Set(profile!.tools.allowed as string[]);
  assert.ok(!allowed.has("not_a_tool"));
  assert.ok(!allowed.has("rm_rf"));
  assert.ok(allowed.has("terminal"));
  for (const locked of CESIUM_PROFILE_LOCKED_TOOLS) {
    assert.ok(allowed.has(locked), `locked tool ${locked} must survive a hostile allowlist`);
  }
});

test("normalizeCesiumProfile preserves tools declared by harness plugins", () => {
  const profile = normalizeCesiumProfile(
    {
      id: "plugin-profile",
      name: "Plugin profile",
      prompt: { base: "minimal", customInstructions: "" },
      tools: {
        allowed: ["plugin_lookup", "still_not_a_tool"],
        mcpServers: "all",
      },
    },
    ["plugin_lookup"]
  );
  assert.ok(profile);
  const allowed = new Set(profile!.tools.allowed as string[]);
  assert.equal(allowed.has("plugin_lookup"), true);
  assert.equal(allowed.has("still_not_a_tool"), false);
});

test("normalizeCesiumProfile rejects records shadowing built-in ids or missing id/name", () => {
  assert.equal(
    normalizeCesiumProfile({ id: "code", name: "Fake Code", tools: { allowed: "all" } }),
    null
  );
  assert.equal(
    normalizeCesiumProfile({ id: "work", name: "Fake Work", tools: { allowed: "all" } }),
    null
  );
  assert.equal(normalizeCesiumProfile({ name: "No id" }), null);
  assert.equal(normalizeCesiumProfile({ id: "no-name" }), null);
  assert.equal(normalizeCesiumProfile("garbage"), null);
});

test("normalizeCesiumProfile clamps name, description, instructions, and falls back to minimal base", () => {
  const profile = normalizeCesiumProfile({
    id: "clamped",
    name: "n".repeat(500),
    description: "d".repeat(5_000),
    prompt: { base: "hax", customInstructions: "i".repeat(50_000) },
    permissionOverrides: { terminal: "sudo", mcpCall: "allow", bogusCategory: "deny" },
  });
  assert.ok(profile);
  assert.equal(profile!.name.length, 60);
  assert.equal(profile!.description.length, 240);
  assert.equal(profile!.prompt.base, "minimal");
  assert.equal(profile!.prompt.customInstructions.length, 8_000);
  // Invalid override values and unknown categories are dropped.
  assert.deepEqual(profile!.permissionOverrides, { mcpCall: "allow" });
});

test("normalizeCesiumProfiles dedupes ids and caps the custom profile count", () => {
  const raw = Array.from({ length: 50 }, (_, index) => ({
    id: index < 2 ? "dupe" : `custom-${index}`,
    name: `Custom ${index}`,
    tools: { allowed: "all", mcpServers: "all" },
  }));
  const profiles = normalizeCesiumProfiles(raw);
  assert.equal(profiles.filter((profile) => profile.id === "dupe").length, 1);
  assert.equal(profiles.length, 32);
  assert.deepEqual(normalizeCesiumProfiles("junk"), []);
});

test("default profile id normalization falls back to code for unknown ids", () => {
  assert.equal(normalizeCesiumDefaultProfileId("work", []), "work");
  assert.equal(normalizeCesiumDefaultProfileId("missing", []), CESIUM_DEFAULT_PROFILE_ID);
  const custom = normalizeCesiumProfiles([
    { id: "mine", name: "Mine", tools: { allowed: "all", mcpServers: "all" } },
  ]);
  assert.equal(normalizeCesiumDefaultProfileId("mine", custom), "mine");
});

test("first-install profile visibility hides Work and keeps Code on", () => {
  assert.deepEqual(normalizeCesiumEnabledProfiles({ code: true, work: false }, []), {
    code: true,
    work: false,
  });
  assert.deepEqual(listCesiumEnabledProfiles([], { code: true, work: false }).map((p) => p.id), [
    "code",
  ]);
  assert.equal(
    normalizeCesiumDefaultProfileId("work", [], { code: true, work: false }),
    "code"
  );
});

test("missing enabledProfiles map is treated as legacy all-on", () => {
  assert.deepEqual(normalizeCesiumEnabledProfiles(undefined, []), {
    code: true,
    work: true,
  });
  const custom = normalizeCesiumProfiles([
    { id: "mine", name: "Mine", tools: { allowed: "all", mcpServers: "all" } },
  ]);
  assert.deepEqual(normalizeCesiumEnabledProfiles(undefined, custom), {
    code: true,
    work: true,
    mine: true,
  });
});

test("enabledProfiles refuses to disable the last remaining profile", () => {
  assert.deepEqual(normalizeCesiumEnabledProfiles({ code: false, work: false }, []), {
    code: true,
    work: false,
  });
});

test("resolveCesiumProfile falls back requested -> default -> code", () => {
  const custom = normalizeCesiumProfiles([
    { id: "mine", name: "Mine", tools: { allowed: "all", mcpServers: "all" } },
  ]);
  assert.equal(
    resolveCesiumProfile({ profileId: "mine", customProfiles: custom }).id,
    "mine"
  );
  assert.equal(
    resolveCesiumProfile({
      profileId: "missing",
      customProfiles: custom,
      defaultProfileId: "work",
    }).id,
    "work"
  );
  assert.equal(
    resolveCesiumProfile({ profileId: "missing", customProfiles: [], defaultProfileId: "gone" })
      .id,
    "code"
  );
  const catalog = listCesiumProfileCatalog(custom);
  assert.deepEqual(
    catalog.map((profile) => profile.id),
    ["code", "work", "mine"]
  );
});

// ---------------------------------------------------------------------------
// Policy layering
// ---------------------------------------------------------------------------

test("Work profile blocks terminal at the dispatch layer and hides it from schemas", () => {
  // Layer 2: dispatch-time profile policy.
  const decision = resolveCesiumProfileToolPolicy({
    profile: CESIUM_WORK_PROFILE,
    toolName: "terminal",
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /Work/);
  // Layer 1: schema filtering — the model never sees terminal or git tools.
  const harness = resolveCesiumTools({ features: { subagents: { version: 2 } } });
  const advertised = filterCesiumToolsForProfile(harness.tools, CESIUM_WORK_PROFILE);
  const names = new Set(advertised.map((tool) => tool.name));
  assert.ok(!names.has("terminal"));
  assert.ok(!names.has("switch_branch"));
  assert.ok(!names.has("create_worktree"));
  assert.ok(names.has("memory"));
  assert.ok(names.has("call_mcp_tool"));
  for (const locked of CESIUM_PROFILE_LOCKED_TOOLS) {
    assert.ok(names.has(locked), `locked tool ${locked} must stay advertised`);
  }
  // Layer 3 (defense in depth): the Work preset also denies the terminal
  // permission category outright.
  assert.equal(CESIUM_WORK_PROFILE.permissionOverrides.terminal, "deny");
});

test("Code profile passes everything through and filters nothing", () => {
  const harness = resolveCesiumTools({ features: { subagents: { version: 1 } } });
  assert.equal(
    filterCesiumToolsForProfile(harness.tools, CESIUM_CODE_PROFILE).length,
    harness.tools.length
  );
  for (const toolName of ["terminal", "write_file", "call_mcp_tool", "switch_branch"]) {
    assert.equal(
      resolveCesiumProfileToolPolicy({ profile: CESIUM_CODE_PROFILE, toolName }).allowed,
      true
    );
  }
});

test("locked core tools survive an empty hostile allowlist end to end", () => {
  const hostile = normalizeCesiumProfile({
    id: "empty",
    name: "Empty",
    prompt: { base: "minimal", customInstructions: "" },
    tools: { allowed: [], mcpServers: "all" },
  });
  assert.ok(hostile);
  const harness = resolveCesiumTools({ features: { subagents: { version: 1 } } });
  const advertised = filterCesiumToolsForProfile(harness.tools, hostile!);
  const names = new Set(advertised.map((tool) => tool.name));
  for (const locked of CESIUM_PROFILE_LOCKED_TOOLS) {
    assert.ok(names.has(locked));
    assert.equal(
      resolveCesiumProfileToolPolicy({ profile: hostile!, toolName: locked }).allowed,
      true
    );
  }
  // Everything else is both hidden and blocked.
  assert.ok(!names.has("terminal"));
  assert.equal(
    resolveCesiumProfileToolPolicy({ profile: hostile!, toolName: "write_file" }).allowed,
    false
  );
});

test("call_mcp_tool serverId gating enforces the MCP server allowlist", () => {
  const gated = normalizeCesiumProfile({
    id: "gated",
    name: "Gated",
    prompt: { base: "minimal", customInstructions: "" },
    tools: { allowed: ["call_mcp_tool"], mcpServers: ["notion"] },
  });
  assert.ok(gated);
  assert.equal(
    resolveCesiumProfileToolPolicy({
      profile: gated!,
      toolName: "call_mcp_tool",
      arguments: { serverId: "notion" },
    }).allowed,
    true
  );
  const blocked = resolveCesiumProfileToolPolicy({
    profile: gated!,
    toolName: "call_mcp_tool",
    arguments: { serverId: "browser" },
  });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason ?? "", /browser/);
  // Server ids compare case-insensitively (allowlist is lowercased).
  assert.equal(
    resolveCesiumProfileToolPolicy({
      profile: gated!,
      toolName: "call_mcp_tool",
      arguments: { serverId: "Notion" },
    }).allowed,
    true
  );
  // Direct browser_* tools (subagents) are policy-equivalent to the browser server.
  assert.equal(
    resolveCesiumProfileToolPolicy({ profile: gated!, toolName: "browser_navigate" }).allowed,
    false
  );
});

test("goal/workflow/orchestration families follow their canonical allowlist entries", () => {
  const planner = normalizeCesiumProfile({
    id: "planner",
    name: "Planner",
    prompt: { base: "minimal", customInstructions: "" },
    tools: {
      allowed: ["goal_set", "workflow_run", "orchestration_board_snapshot"],
      mcpServers: "all",
    },
  });
  assert.ok(planner);
  for (const toolName of ["goal_resume", "burn_goal_set", "workflow_await", "orchestration_wait"]) {
    assert.equal(
      resolveCesiumProfileToolPolicy({ profile: planner!, toolName }).allowed,
      true,
      `${toolName} should follow its family's canonical entry`
    );
  }
  const noFamilies = normalizeCesiumProfile({
    id: "no-families",
    name: "No families",
    prompt: { base: "minimal", customInstructions: "" },
    tools: { allowed: [], mcpServers: "all" },
  });
  assert.equal(
    resolveCesiumProfileToolPolicy({ profile: noFamilies!, toolName: "goal_resume" }).allowed,
    false
  );
});

test("mode policy layers after profile policy: Work+Ask still blocks writes the profile allows", () => {
  // write_file is inside the Work envelope...
  assert.equal(
    resolveCesiumProfileToolPolicy({ profile: CESIUM_WORK_PROFILE, toolName: "write_file" })
      .allowed,
    true
  );
  // ...but ask mode (posture) still blocks it, unchanged by profiles.
  assert.equal(
    resolveCesiumModeToolPolicy({ mode: "ask", toolName: "write_file" }).allowed,
    false
  );
  assert.equal(
    resolveCesiumModeToolPolicy({ mode: "agent", toolName: "write_file" }).allowed,
    true
  );
});

test("mode reminder never contradicts the profile envelope", async () => {
  const { buildCesiumModeReminder, applyCesiumProfileExclusionsToModePolicy } = await import(
    "../src/lib/agents/cesium-mode-reminders.js"
  );
  const { listCesiumProfileExcludedTools } = await import(
    "../src/lib/agents/cesium-profiles.js"
  );
  const excluded = listCesiumProfileExcludedTools(CESIUM_WORK_PROFILE);
  assert.ok(excluded.includes("terminal"));
  assert.ok(excluded.includes("switch_branch"));
  assert.deepEqual(listCesiumProfileExcludedTools(CESIUM_CODE_PROFILE), []);

  const adjusted = applyCesiumProfileExclusionsToModePolicy(
    { allowed: ["read_file", "terminal"], restricted: ["switch_branch"], blocked: ["x"] },
    excluded,
    CESIUM_WORK_PROFILE.name
  );
  assert.deepEqual(adjusted.allowed, ["read_file"]);
  assert.deepEqual(adjusted.restricted, []);
  assert.ok(adjusted.blocked.some((entry) => entry.includes('"Work" agent profile')));

  const reminder = buildCesiumModeReminder({
    mode: "agent",
    profileName: CESIUM_WORK_PROFILE.name,
    profileSummary: summarizeCesiumProfileToolSurface(CESIUM_WORK_PROFILE),
    profileExcludedTools: excluded,
    workspaceRoot: "/tmp/ws",
    dateLabel: "today",
    gitSummary: "not a git repository",
    mcpSummaries: [],
  });
  // "terminal" must not be listed as allowed; it appears only in the blocked
  // aggregation and the profile summary's unavailable list.
  const allowedSection = reminder.split("Allowed:")[1]?.split("Restricted:")[0] ?? "";
  assert.ok(!allowedSection.includes("terminal"));
  assert.match(reminder, /excluded by the active "Work" agent profile/);
});

test("profile tool-surface summary names available groups and unavailable tools", () => {
  assert.match(summarizeCesiumProfileToolSurface(CESIUM_CODE_PROFILE), /All harness tools/);
  const workSummary = summarizeCesiumProfileToolSurface(CESIUM_WORK_PROFILE);
  assert.match(workSummary, /Memory/);
  assert.match(workSummary, /Unavailable tools:.*terminal/);
  assert.match(workSummary, /switch_branch/);
});

// ---------------------------------------------------------------------------
// Settings round-trip + config options
// ---------------------------------------------------------------------------

test("settings persist custom profiles and default profile id through the public payload", async () => {
  const publicSettings = await patchCesiumAgentSettings({
    profiles: normalizeCesiumProfiles([
      {
        id: "custom-writer",
        name: "Writer",
        description: "Docs only.",
        prompt: { base: "minimal", customInstructions: "Write concisely." },
        tools: { allowed: ["write_file", "edit_file", "not_real"], mcpServers: ["artifacts"] },
        permissionOverrides: { terminal: "deny" },
      },
    ]),
    defaultProfileId: "custom-writer",
  });
  assert.equal(publicSettings.defaultProfileId, "custom-writer");
  assert.deepEqual(
    publicSettings.profileCatalog.map((profile) => profile.id),
    ["code", "work", "custom-writer"]
  );
  const custom = publicSettings.profileCatalog.find((p) => p.id === "custom-writer");
  assert.ok(custom);
  assert.equal(custom!.builtIn, false);
  const allowed = new Set(custom!.tools.allowed as string[]);
  assert.ok(!allowed.has("not_real"));
  assert.ok(allowed.has("write_file"));
  assert.ok(publicSettings.profileLockedTools.length > 0);
  assert.ok(publicSettings.profileToolGroups.some((group) => group.id === "memory"));

  // Reload from disk to prove the round-trip.
  const reloaded = await getCesiumAgentSettingsPublic();
  assert.equal(reloaded.defaultProfileId, "custom-writer");
  assert.equal(reloaded.profileCatalog.length, 3);

  // Fresh installs hide Work from the live picker; the full catalog stays intact.
  assert.equal(publicSettings.enabledProfiles.work, false);
  assert.equal(publicSettings.enabledProfiles.code, true);
  const options = await createCesiumAgentConfigOptions();
  const profileOption = options.find((option) => option.id === "profile");
  assert.ok(profileOption, "profile config option must exist");
  assert.equal(profileOption!.currentValue, "custom-writer");
  assert.deepEqual(
    profileOption!.options.map((value) => value.value),
    ["code", "custom-writer"]
  );

  const withWork = await patchCesiumAgentSettings({ enabledProfiles: { work: true } });
  assert.equal(withWork.enabledProfiles.work, true);
  const enabledOptions = await createCesiumAgentConfigOptions();
  assert.deepEqual(
    enabledOptions.find((option) => option.id === "profile")?.options.map((value) => value.value),
    ["code", "work", "custom-writer"]
  );

  const asWorkDefault = await patchCesiumAgentSettings({ defaultProfileId: "work" });
  assert.equal(asWorkDefault.defaultProfileId, "work");
  const hiddenWork = await patchCesiumAgentSettings({ enabledProfiles: { work: false } });
  assert.equal(hiddenWork.enabledProfiles.work, false);
  assert.equal(hiddenWork.defaultProfileId, "code");
  assert.deepEqual(
    (await createCesiumAgentConfigOptions())
      .find((option) => option.id === "profile")
      ?.options.map((value) => value.value),
    ["code", "custom-writer"]
  );

  // An unknown default falls back to code on the next patch.
  const fallback = await patchCesiumAgentSettings({ profiles: [], defaultProfileId: "custom-writer" });
  assert.equal(fallback.defaultProfileId, "code");
});

// ---------------------------------------------------------------------------
// Curated memory
// ---------------------------------------------------------------------------

test("memory save/list/search/forget round-trip across scopes", async () => {
  const workspaceId = "ws-memory-roundtrip";
  const saved = await saveCesiumMemoryEntry({
    workspaceId,
    scope: "workspace",
    category: "preference",
    content: "User prefers tabs over spaces.",
    sourceConversationId: "conv-1",
  });
  const userScoped = await saveCesiumMemoryEntry({
    workspaceId,
    scope: "user",
    category: "fact",
    content: "User's favorite color is teal.",
  });

  const all = await listCesiumMemoryEntries({ workspaceId });
  assert.equal(all.length, 2);
  const workspaceOnly = await listCesiumMemoryEntries({ workspaceId, scope: "workspace" });
  assert.deepEqual(
    workspaceOnly.map((entry) => entry.id),
    [saved.id]
  );

  const found = await searchCesiumMemoryEntries({ workspaceId, query: "tabs spaces" });
  assert.equal(found.length, 1);
  assert.equal(found[0]!.id, saved.id);
  assert.deepEqual(await searchCesiumMemoryEntries({ workspaceId, query: "zebra unicorn" }), []);

  // Update in place via id keeps the entry count stable.
  const updated = await saveCesiumMemoryEntry({
    workspaceId,
    scope: "workspace",
    category: "constraint",
    content: "User prefers tabs; never reformat whole files.",
    id: saved.id,
  });
  assert.equal(updated.id, saved.id);
  assert.equal(updated.category, "constraint");
  assert.equal((await listCesiumMemoryEntries({ workspaceId })).length, 2);
  await assert.rejects(
    saveCesiumMemoryEntry({
      workspaceId,
      scope: "workspace",
      category: "fact",
      content: "x",
      id: "missing-id",
    }),
    /No memory entry/
  );

  const forgotten = await forgetCesiumMemoryEntry({ workspaceId, id: userScoped.id });
  assert.equal(forgotten?.id, userScoped.id);
  assert.equal(await forgetCesiumMemoryEntry({ workspaceId, id: userScoped.id }), null);
  assert.equal((await listCesiumMemoryEntries({ workspaceId })).length, 1);
});

test("memory content is clamped and the per-scope store is bounded", async () => {
  const workspaceId = "ws-memory-bounds";
  const long = await saveCesiumMemoryEntry({
    workspaceId,
    scope: "workspace",
    category: "fact",
    content: "y".repeat(CESIUM_MEMORY_MAX_CONTENT_CHARS * 3),
  });
  assert.equal(long.content.length, CESIUM_MEMORY_MAX_CONTENT_CHARS);
  await assert.rejects(
    saveCesiumMemoryEntry({ workspaceId, scope: "workspace", category: "fact", content: "   " }),
    /must not be empty/
  );

  for (let index = 0; index < CESIUM_MEMORY_MAX_ENTRIES_PER_SCOPE + 10; index++) {
    await saveCesiumMemoryEntry({
      workspaceId,
      scope: "workspace",
      category: "fact",
      content: `bounded entry ${index}`,
    });
  }
  const entries = await listCesiumMemoryEntries({ workspaceId, scope: "workspace" });
  assert.equal(entries.length, CESIUM_MEMORY_MAX_ENTRIES_PER_SCOPE);
});

test("memory reminder snapshot respects entry and character caps", async () => {
  const workspaceId = "ws-memory-snapshot";
  for (let index = 0; index < CESIUM_MEMORY_SNAPSHOT_MAX_ENTRIES + 15; index++) {
    await saveCesiumMemoryEntry({
      workspaceId,
      scope: "workspace",
      category: "fact",
      content: `snapshot entry ${index} ${"z".repeat(120)}`,
    });
  }
  const entries = await listCesiumMemoryEntries({ workspaceId });
  const snapshot = renderCesiumMemorySnapshot(entries);
  const lines = snapshot.split("\n");
  assert.ok(lines.length <= CESIUM_MEMORY_SNAPSHOT_MAX_ENTRIES);
  assert.ok(snapshot.length <= CESIUM_MEMORY_SNAPSHOT_MAX_CHARS + 200);
  assert.equal(renderCesiumMemorySnapshot([]), "");
});
