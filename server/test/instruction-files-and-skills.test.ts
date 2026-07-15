import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadWorkspaceInstructionFiles,
  NO_INSTRUCTION_FILES_PLACEHOLDER,
} from "../src/lib/agents/instruction-files.js";
import {
  discoverWorkspaceSkills,
  formatWorkspaceSkillsCatalog,
  parseSkillFrontmatter,
} from "../src/lib/agents/workspace-skills.js";
import { buildCesiumModeReminder } from "../src/lib/agents/cesium-mode-reminders.js";
import { buildCesiumSystemPrompt } from "@cesium/core/mcp";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-skills-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("loadWorkspaceInstructionFiles returns placeholder when neither file exists", async () => {
  await withTempDir(async (dir) => {
    const content = await loadWorkspaceInstructionFiles(dir);
    assert.equal(content, NO_INSTRUCTION_FILES_PLACEHOLDER);
  });
});

test("loadWorkspaceInstructionFiles loads AGENTS.md alone", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "AGENTS.md"), "# Agents\nUse bun.\n", "utf8");
    const content = await loadWorkspaceInstructionFiles(dir);
    assert.match(content, /### AGENTS\.md/);
    assert.match(content, /Use bun\./);
    assert.doesNotMatch(content, /CLAUDE\.md/);
  });
});

test("loadWorkspaceInstructionFiles appends CLAUDE.md under AGENTS.md", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "AGENTS.md"), "Agents rules", "utf8");
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "Claude-only rules", "utf8");
    const content = await loadWorkspaceInstructionFiles(dir);
    assert.match(content, /### AGENTS\.md/);
    assert.match(content, /Agents rules/);
    assert.match(content, /### CLAUDE\.md/);
    assert.match(content, /Claude-only rules/);
    assert.ok(content.indexOf("Agents rules") < content.indexOf("Claude-only rules"));
  });
});

test("loadWorkspaceInstructionFiles prefers root CLAUDE.md over .claude/CLAUDE.md", async () => {
  await withTempDir(async (dir) => {
    await fs.mkdir(path.join(dir, ".claude"), { recursive: true });
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "root claude", "utf8");
    await fs.writeFile(path.join(dir, ".claude", "CLAUDE.md"), "nested claude", "utf8");
    const content = await loadWorkspaceInstructionFiles(dir);
    assert.match(content, /root claude/);
    assert.doesNotMatch(content, /nested claude/);
    assert.match(content, /### CLAUDE\.md/);
  });
});

test("loadWorkspaceInstructionFiles falls back to .claude/CLAUDE.md", async () => {
  await withTempDir(async (dir) => {
    await fs.mkdir(path.join(dir, ".claude"), { recursive: true });
    await fs.writeFile(path.join(dir, ".claude", "CLAUDE.md"), "nested only", "utf8");
    const content = await loadWorkspaceInstructionFiles(dir);
    assert.match(content, /\.claude\/CLAUDE\.md/);
    assert.match(content, /nested only/);
  });
});

test("parseSkillFrontmatter reads Agent Skills required fields", () => {
  const parsed = parseSkillFrontmatter(`---
name: pdf-processing
description: Extract PDF text and merge files. Use when handling PDFs.
disable-model-invocation: true
---

# Body
`);
  assert.equal(parsed.name, "pdf-processing");
  assert.match(parsed.description ?? "", /Extract PDF text/);
  assert.equal(parsed.disableModelInvocation, true);
});

test("discoverWorkspaceSkills finds .cursor/skills SKILL.md catalog entries", async () => {
  await withTempDir(async (dir) => {
    const skillDir = path.join(dir, ".cursor", "skills", "demo-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: demo-skill
description: Demo skill for tests. Use when verifying skill discovery.
---

# Demo
Do the thing.
`,
      "utf8"
    );
    const skills = await discoverWorkspaceSkills(dir);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, "demo-skill");
    assert.equal(skills[0].relativePath, ".cursor/skills/demo-skill/SKILL.md");
    assert.equal(skills[0].source, "cursor");
    assert.equal(skills[0].disableModelInvocation, false);

    const catalog = formatWorkspaceSkillsCatalog(skills);
    assert.match(catalog, /progressive disclosure/i);
    assert.match(catalog, /demo-skill/);
    assert.match(catalog, /\.cursor\/skills\/demo-skill\/SKILL\.md/);
    assert.doesNotMatch(catalog, /Do the thing/);
  });
});

test("discoverWorkspaceSkills prefers .agents/skills over .cursor on name collision", async () => {
  await withTempDir(async (dir) => {
    for (const root of [
      path.join(dir, ".agents", "skills", "shared"),
      path.join(dir, ".cursor", "skills", "shared"),
    ]) {
      await fs.mkdir(root, { recursive: true });
    }
    await fs.writeFile(
      path.join(dir, ".agents", "skills", "shared", "SKILL.md"),
      `---
name: shared
description: From agents root.
---
`,
      "utf8"
    );
    await fs.writeFile(
      path.join(dir, ".cursor", "skills", "shared", "SKILL.md"),
      `---
name: shared
description: From cursor root.
---
`,
      "utf8"
    );
    const skills = await discoverWorkspaceSkills(dir);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].source, "agents");
    assert.match(skills[0].description, /From agents root/);
  });
});

test("buildCesiumSystemPrompt uses Project Instruction Files naming", () => {
  const prompt = buildCesiumSystemPrompt({
    agentsMarkdown: "### AGENTS.md\n\nHello\n\n### CLAUDE.md\n\nClaude bits",
    skillsList: "- demo: Test skill\n  Location: .cursor/skills/demo/SKILL.md",
  });
  assert.match(prompt, /## Project Instruction Files/);
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /CLAUDE\.md/);
  assert.match(prompt, /progressive disclosure/i);
  assert.match(prompt, /demo: Test skill/);
  assert.doesNotMatch(prompt, /## Your AGENTS\.md File/);
});

test("buildCesiumModeReminder uses Project Instruction Files section", () => {
  const reminder = buildCesiumModeReminder({
    mode: "agent",
    workspaceRoot: "/tmp/workspace",
    dateLabel: "Wednesday, July 15, 2026",
    gitSummary: "a git repository on branch `main`",
    agentsMarkdown: "### AGENTS.md\n\nrules",
    skillsList: "- demo: Skill\n  Location: .agents/skills/demo/SKILL.md",
    mcpSummaries: [],
  });
  assert.match(reminder, /## Project Instruction Files/);
  assert.doesNotMatch(reminder, /## AGENTS\.md\n\n```markdown/);
  assert.match(reminder, /## Skills/);
  assert.match(reminder, /\.agents\/skills\/demo\/SKILL\.md/);
});
