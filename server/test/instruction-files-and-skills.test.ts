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
  parseSkillFrontmatter,
} from "../src/lib/agents/workspace-skills.js";
import {
  formatAgentSkillsPromptSection,
  refreshWorkspaceSkillsMirror,
  writeAgentSkillsWorkspaceMirror,
} from "../src/lib/agents/skills-mirror.js";
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

test("writeAgentSkillsWorkspaceMirror mirrors skills for on-demand reads like mcp-servers", async () => {
  await withTempDir(async (dir) => {
    const skillDir = path.join(dir, ".cursor", "skills", "demo-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: demo-skill
description: Demo skill for mirror tests.
disable-model-invocation: true
---

# Demo
Secret body content for read_file.
`,
      "utf8"
    );
    await fs.writeFile(path.join(skillDir, "references-note.txt"), "extra ref\n", "utf8");

    const skills = await refreshWorkspaceSkillsMirror({
      workspaceRoot: dir,
      pluginSkills: [
        {
          id: "plugin-docs",
          title: "Use Plugin Docs",
          description: "Plugin skill for docs.",
          body: "Always call the docs tool first.",
          pluginId: "demo-plugin",
          pluginName: "Demo Plugin",
        },
      ],
    });

    const index = await fs.readFile(path.join(dir, "agent-skills", "_index.md"), "utf8");
    assert.match(index, /demo-skill/);
    assert.match(index, /Use Plugin Docs/);
    assert.match(index, /Read `_index\.md` first/);

    const mirroredSkill = await fs.readFile(
      path.join(dir, "agent-skills", "demo-skill", "SKILL.md"),
      "utf8"
    );
    assert.match(mirroredSkill, /Secret body content for read_file/);
    const mirroredRef = await fs.readFile(
      path.join(dir, "agent-skills", "demo-skill", "references-note.txt"),
      "utf8"
    );
    assert.match(mirroredRef, /extra ref/);

    const pluginSkill = await fs.readFile(
      path.join(dir, "agent-skills", "plugin-docs", "SKILL.md"),
      "utf8"
    );
    assert.match(pluginSkill, /Always call the docs tool first/);

    assert.match(skills.skillsList, /agent-skills\/_index\.md/);
    assert.match(skills.skillsList, /demo-skill/);
    assert.doesNotMatch(skills.skillsList, /Secret body content for read_file/);
    assert.doesNotMatch(skills.skillsList, /Always call the docs tool first/);

    const gitignore = await fs.readFile(path.join(dir, ".gitignore"), "utf8").catch(() => "");
    // ensureAgentSkillsGitignore no-ops when no .gitignore exists; create one and refresh again
    await fs.writeFile(path.join(dir, ".gitignore"), "node_modules/\n", "utf8");
    await refreshWorkspaceSkillsMirror({ workspaceRoot: dir });
    const updatedIgnore = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    assert.match(updatedIgnore, /agent-skills\//);
  });
});

test("writeAgentSkillsWorkspaceMirror removes stale skill directories", async () => {
  await withTempDir(async (dir) => {
    await fs.mkdir(path.join(dir, "agent-skills", "stale"), { recursive: true });
    await fs.writeFile(path.join(dir, "agent-skills", "stale", "SKILL.md"), "old\n", "utf8");
    await writeAgentSkillsWorkspaceMirror({
      workspaceRoot: dir,
      workspaceSkills: [],
      pluginSkills: [],
    });
    await assert.rejects(fs.stat(path.join(dir, "agent-skills", "stale")));
  });
});

test("formatAgentSkillsPromptSection empty state points at mirror path", () => {
  const section = formatAgentSkillsPromptSection([]);
  assert.match(section, /agent-skills\//);
  assert.match(section, /_index\.md/);
});

test("buildCesiumSystemPrompt uses Project Instruction Files naming and agent-skills mirror", () => {
  const prompt = buildCesiumSystemPrompt({
    agentsMarkdown: "### AGENTS.md\n\nHello\n\n### CLAUDE.md\n\nClaude bits",
    skillsList: formatAgentSkillsPromptSection([
      {
        id: "demo",
        name: "demo",
        description: "Test skill",
        disableModelInvocation: false,
        sourceKind: "workspace",
      },
    ]),
  });
  assert.match(prompt, /## Project Instruction Files/);
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /CLAUDE\.md/);
  assert.match(prompt, /agent-skills\//);
  assert.match(prompt, /agent-skills\/_index\.md/);
  assert.match(prompt, /demo/);
  assert.doesNotMatch(prompt, /## Your AGENTS\.md File/);
});

test("buildCesiumModeReminder uses Project Instruction Files section and mirror read guidance", () => {
  const reminder = buildCesiumModeReminder({
    mode: "agent",
    workspaceRoot: "/tmp/workspace",
    dateLabel: "Wednesday, July 15, 2026",
    gitSummary: "a git repository on branch `main`",
    agentsMarkdown: "### AGENTS.md\n\nrules",
    skillsList: formatAgentSkillsPromptSection([
      {
        id: "demo",
        name: "demo",
        description: "Skill",
        disableModelInvocation: false,
        sourceKind: "workspace",
      },
    ]),
    mcpSummaries: [],
  });
  assert.match(reminder, /## Project Instruction Files/);
  assert.doesNotMatch(reminder, /## AGENTS\.md\n\n```markdown/);
  assert.match(reminder, /## Skills/);
  assert.match(reminder, /agent-skills\/_index\.md/);
  assert.match(reminder, /same discover-then-read pattern as `mcp-servers\/`/);
});
