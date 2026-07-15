import fs from "node:fs/promises";
import path from "node:path";
import {
  discoverWorkspaceSkills,
  type WorkspaceSkillCatalogEntry,
} from "./workspace-skills.js";

export const AGENT_SKILLS_MIRROR_DIR = "agent-skills";

export type PluginSkillMirrorInput = {
  id: string;
  title: string;
  description: string;
  body: string;
  triggerHints?: string[];
  pluginId: string;
  pluginName: string;
};

export type MirroredSkillSummary = {
  id: string;
  name: string;
  description: string;
  disableModelInvocation: boolean;
  sourceKind: "workspace" | "plugin";
};

function resolveMirrorPath(workspaceRoot: string, relativePath: string): string {
  const resolved = path.resolve(workspaceRoot, relativePath);
  const rel = path.relative(workspaceRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Mirror path escapes workspace: ${relativePath}`);
  }
  return resolved;
}

export function slugifySkillId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "skill"
  );
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(from, to);
      continue;
    }
    if (entry.isFile()) {
      await fs.copyFile(from, to);
    }
  }
}

function buildPluginSkillMarkdown(skill: PluginSkillMirrorInput): string {
  const triggers =
    skill.triggerHints && skill.triggerHints.length > 0
      ? `\n\n## Triggers\n\n${skill.triggerHints.map((hint) => `- ${hint}`).join("\n")}`
      : "";
  return `---
name: ${slugifySkillId(skill.id || skill.title)}
description: ${skill.description.replace(/\n/g, " ").trim()}
metadata:
  pluginId: ${skill.pluginId}
  pluginName: ${skill.pluginName}
---

# ${skill.title}

${skill.body.trim()}${triggers}
`;
}

/**
 * Write an MCP-style discovery mirror under `agent-skills/`.
 * The agent should read `agent-skills/_index.md` then
 * `agent-skills/<skill-id>/SKILL.md` on demand — not guess instructions.
 */
export async function writeAgentSkillsWorkspaceMirror(input: {
  workspaceRoot: string;
  workspaceSkills?: WorkspaceSkillCatalogEntry[];
  pluginSkills?: PluginSkillMirrorInput[];
}): Promise<MirroredSkillSummary[]> {
  const root = resolveMirrorPath(input.workspaceRoot, AGENT_SKILLS_MIRROR_DIR);
  await fs.mkdir(root, { recursive: true });

  const workspaceSkills =
    input.workspaceSkills ?? (await discoverWorkspaceSkills(input.workspaceRoot));
  const pluginSkills = input.pluginSkills ?? [];

  const summaries: MirroredSkillSummary[] = [];
  const activeIds = new Set<string>();

  for (const skill of workspaceSkills) {
    const id = slugifySkillId(skill.name);
    if (activeIds.has(id)) continue;
    activeIds.add(id);
    const skillDir = path.join(root, id);
    await fs.rm(skillDir, { recursive: true, force: true });
    await copyDirRecursive(skill.skillDir, skillDir);
    await fs.writeFile(
      path.join(skillDir, "summary.txt"),
      `${skill.description}\n`,
      "utf8"
    );
    await fs.writeFile(
      path.join(skillDir, "source.json"),
      `${JSON.stringify(
        {
          kind: "workspace",
          name: skill.name,
          originRelativePath: skill.relativePath,
          originDir: path.relative(input.workspaceRoot, skill.skillDir).split(path.sep).join("/"),
          source: skill.source,
          disableModelInvocation: skill.disableModelInvocation,
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    summaries.push({
      id,
      name: skill.name,
      description: skill.description,
      disableModelInvocation: skill.disableModelInvocation,
      sourceKind: "workspace",
    });
  }

  for (const skill of pluginSkills) {
    const id = slugifySkillId(skill.id || skill.title);
    if (activeIds.has(id)) continue;
    activeIds.add(id);
    const skillDir = path.join(root, id);
    await fs.rm(skillDir, { recursive: true, force: true });
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), buildPluginSkillMarkdown(skill), "utf8");
    await fs.writeFile(path.join(skillDir, "summary.txt"), `${skill.description}\n`, "utf8");
    await fs.writeFile(
      path.join(skillDir, "source.json"),
      `${JSON.stringify(
        {
          kind: "plugin",
          pluginId: skill.pluginId,
          pluginName: skill.pluginName,
          skillId: skill.id,
          title: skill.title,
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    summaries.push({
      id,
      name: skill.title,
      description: skill.description,
      disableModelInvocation: false,
      sourceKind: "plugin",
    });
  }

  for (const dirent of await fs.readdir(root, { withFileTypes: true })) {
    if (!dirent.isDirectory() || activeIds.has(dirent.name)) continue;
    await fs.rm(path.join(root, dirent.name), { recursive: true, force: true });
  }

  const indexLines = [
    "# Agent Skills",
    "",
    `Last refreshed: ${new Date().toISOString()}`,
    "",
    "Each subdirectory contains one Agent Skill (`SKILL.md`) plus a short `summary.txt`.",
    "Read `_index.md` first, then the relevant `agent-skills/<skill-id>/SKILL.md` before following a skill.",
    "Resolve relative paths inside a skill against that skill subdirectory.",
    "Do not infer or assume skill instructions from memory.",
    "",
  ];

  if (summaries.length === 0) {
    indexLines.push("No skills are currently mirrored for this workspace.");
  } else {
    for (const skill of summaries) {
      const manual = skill.disableModelInvocation ? " _(manual only)_" : "";
      const origin = skill.sourceKind === "plugin" ? "plugin" : "workspace";
      indexLines.push(
        `- **${skill.name}** (\`${skill.id}\`): ${skill.description} _(${origin})${manual}_`
      );
    }
  }

  await fs.writeFile(path.join(root, "_index.md"), `${indexLines.join("\n")}\n`, "utf8");
  return summaries;
}

export async function ensureAgentSkillsGitignore(workspaceRoot: string): Promise<void> {
  const gitignorePath = resolveMirrorPath(workspaceRoot, ".gitignore");
  try {
    const existing = await fs.readFile(gitignorePath, "utf8");
    if (existing.includes(`${AGENT_SKILLS_MIRROR_DIR}/`)) {
      return;
    }
    await fs.appendFile(gitignorePath, `\n${AGENT_SKILLS_MIRROR_DIR}/\n`, "utf8");
  } catch {
    // no .gitignore — skip
  }
}

/** MCP-style short prompt list pointing at the filesystem mirror. */
export function formatAgentSkillsPromptSection(skills: MirroredSkillSummary[]): string {
  if (skills.length === 0) {
    return [
      "No Agent Skills are currently mirrored under `agent-skills/`.",
      "",
      "When skills are available, they are discoverable as files under the workspace `agent-skills/` directory.",
      "Read `agent-skills/_index.md` and the relevant `agent-skills/<skill-id>/SKILL.md` before following a skill.",
      "You cannot infer or assume skill instructions from memory.",
    ].join("\n");
  }

  const bullets = skills
    .map((skill) => {
      const manual = skill.disableModelInvocation
        ? " (manual only — use when the user explicitly requests this skill)"
        : "";
      return `- ${skill.name} (\`${skill.id}\`): ${skill.description}${manual}`;
    })
    .join("\n");

  return [
    "Agent Skills are discoverable as files under the workspace `agent-skills/` directory (same progressive-disclosure pattern as `mcp-servers/`).",
    "",
    "As configured, you currently have the following skills visible under that directory:",
    "",
    bullets,
    "",
    "When a skill is relevant — or the user cites/tags one — read `agent-skills/_index.md`, then the relevant `agent-skills/<skill-id>/summary.txt` and `agent-skills/<skill-id>/SKILL.md` before acting.",
    "Resolve relative paths from that skill subdirectory. You cannot infer or assume skill instructions from memory.",
    "Skills marked manual-only should only be used when the user explicitly requests them.",
  ].join("\n");
}

export async function refreshWorkspaceSkillsMirror(input: {
  workspaceRoot: string;
  pluginSkills?: PluginSkillMirrorInput[];
}): Promise<{ skills: MirroredSkillSummary[]; skillsList: string }> {
  const workspaceSkills = await discoverWorkspaceSkills(input.workspaceRoot);
  const skills = await writeAgentSkillsWorkspaceMirror({
    workspaceRoot: input.workspaceRoot,
    workspaceSkills,
    pluginSkills: input.pluginSkills,
  });
  await ensureAgentSkillsGitignore(input.workspaceRoot);
  return {
    skills,
    skillsList: formatAgentSkillsPromptSection(skills),
  };
}
