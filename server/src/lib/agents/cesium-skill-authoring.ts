import fs from "node:fs/promises";
import path from "node:path";
import {
  discoverWorkspaceSkills,
  parseSkillFrontmatter,
  type WorkspaceSkillCatalogEntry,
} from "./workspace-skills.js";
import { refreshWorkspaceSkillsMirror, slugifySkillId } from "./skills-mirror.js";

/**
 * Agent-authored skills (agentskills.io SKILL.md standard).
 *
 * The agent documents reusable procedures as skills under the canonical
 * `.agents/skills/<id>/SKILL.md` root. Discovery/mirroring reuses the
 * existing workspace-skills pipeline, so authored skills appear in the
 * `agent-skills/` mirror and the per-turn skills list immediately.
 * Skills sourced from other roots (.cursor/.claude/.codex) are read-only.
 */

export const CESIUM_AUTHORED_SKILLS_DIR = path.join(".agents", "skills");
export const CESIUM_SKILL_MAX_DESCRIPTION_CHARS = 500;
export const CESIUM_SKILL_MAX_INSTRUCTIONS_CHARS = 24_000;

function authoredSkillDir(workspaceRoot: string, id: string): string {
  const dir = path.resolve(workspaceRoot, CESIUM_AUTHORED_SKILLS_DIR, id);
  const rel = path.relative(workspaceRoot, dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Skill id escapes the workspace: ${id}`);
  }
  return dir;
}

function buildSkillMarkdown(input: {
  id: string;
  name: string;
  description: string;
  instructions: string;
}): string {
  const description = input.description.replace(/\r?\n/g, " ").trim();
  return `---
name: ${input.id}
description: ${description}
---

# ${input.name.trim()}

${input.instructions.trim()}
`;
}

export type AuthoredSkillResult = {
  id: string;
  name: string;
  description: string;
  relativePath: string;
};

function validateSkillFields(input: { description: string; instructions: string }): void {
  if (!input.description.trim()) {
    throw new Error("Skill description must not be empty.");
  }
  if (input.description.trim().length > CESIUM_SKILL_MAX_DESCRIPTION_CHARS) {
    throw new Error(
      `Skill description is limited to ${CESIUM_SKILL_MAX_DESCRIPTION_CHARS} characters.`
    );
  }
  if (!input.instructions.trim()) {
    throw new Error("Skill instructions must not be empty.");
  }
  if (input.instructions.trim().length > CESIUM_SKILL_MAX_INSTRUCTIONS_CHARS) {
    throw new Error(
      `Skill instructions are limited to ${CESIUM_SKILL_MAX_INSTRUCTIONS_CHARS} characters.`
    );
  }
}

export async function listAuthorableSkills(
  workspaceRoot: string
): Promise<Array<WorkspaceSkillCatalogEntry & { authored: boolean }>> {
  const skills = await discoverWorkspaceSkills(workspaceRoot);
  const authoredRoot = path.resolve(workspaceRoot, CESIUM_AUTHORED_SKILLS_DIR);
  return skills.map((skill) => ({
    ...skill,
    authored: skill.skillDir.startsWith(authoredRoot + path.sep) || skill.skillDir === authoredRoot,
  }));
}

async function findSkillById(
  workspaceRoot: string,
  id: string
): Promise<(WorkspaceSkillCatalogEntry & { authored: boolean }) | null> {
  const normalized = slugifySkillId(id);
  const skills = await listAuthorableSkills(workspaceRoot);
  return (
    skills.find((skill) => slugifySkillId(skill.name) === normalized) ??
    skills.find((skill) => path.basename(skill.skillDir) === normalized) ??
    null
  );
}

export async function createAuthoredSkill(input: {
  workspaceRoot: string;
  name: string;
  description: string;
  instructions: string;
  id?: string;
}): Promise<AuthoredSkillResult> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("Skill name must not be empty.");
  }
  validateSkillFields(input);
  const id = slugifySkillId(input.id?.trim() || name);
  const existing = await findSkillById(input.workspaceRoot, id);
  if (existing) {
    throw new Error(
      `A skill with id "${id}" already exists (${existing.relativePath}). Use skill update, or pick a different id.`
    );
  }
  const dir = authoredSkillDir(input.workspaceRoot, id);
  await fs.mkdir(dir, { recursive: true });
  const markdown = buildSkillMarkdown({
    id,
    name,
    description: input.description,
    instructions: input.instructions,
  });
  await fs.writeFile(path.join(dir, "SKILL.md"), markdown, "utf8");
  await refreshWorkspaceSkillsMirror({ workspaceRoot: input.workspaceRoot });
  return {
    id,
    name,
    description: input.description.trim(),
    relativePath: path
      .join(CESIUM_AUTHORED_SKILLS_DIR, id, "SKILL.md")
      .split(path.sep)
      .join("/"),
  };
}

export async function updateAuthoredSkill(input: {
  workspaceRoot: string;
  id: string;
  name?: string;
  description?: string;
  instructions?: string;
}): Promise<AuthoredSkillResult> {
  const skill = await findSkillById(input.workspaceRoot, input.id);
  if (!skill) {
    throw new Error(`No skill with id "${input.id}". Use skill list to see current skills.`);
  }
  if (!skill.authored) {
    throw new Error(
      `Skill "${input.id}" comes from ${skill.relativePath} and is read-only here. Only skills under ${CESIUM_AUTHORED_SKILLS_DIR}/ can be edited by the agent.`
    );
  }
  const skillFile = path.join(skill.skillDir, "SKILL.md");
  const raw = await fs.readFile(skillFile, "utf8");
  const frontmatter = parseSkillFrontmatter(raw);
  const bodyMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  const currentBody = (bodyMatch?.[1] ?? raw).trim();
  // Body layout is "# Title\n\n<instructions>"; keep the title in sync with name.
  const currentInstructions = currentBody.replace(/^#[^\n]*\r?\n+/, "").trim();

  const id = path.basename(skill.skillDir);
  const name = input.name?.trim() || frontmatter.name || id;
  const description = input.description?.trim() || frontmatter.description || "";
  const instructions = input.instructions?.trim() || currentInstructions;
  validateSkillFields({ description, instructions });

  await fs.writeFile(
    skillFile,
    buildSkillMarkdown({ id, name, description, instructions }),
    "utf8"
  );
  await refreshWorkspaceSkillsMirror({ workspaceRoot: input.workspaceRoot });
  return {
    id,
    name,
    description,
    relativePath: skill.relativePath,
  };
}

export async function deleteAuthoredSkill(input: {
  workspaceRoot: string;
  id: string;
}): Promise<AuthoredSkillResult> {
  const skill = await findSkillById(input.workspaceRoot, input.id);
  if (!skill) {
    throw new Error(`No skill with id "${input.id}". Use skill list to see current skills.`);
  }
  if (!skill.authored) {
    throw new Error(
      `Skill "${input.id}" comes from ${skill.relativePath} and cannot be deleted by the agent. Only skills under ${CESIUM_AUTHORED_SKILLS_DIR}/ are agent-managed.`
    );
  }
  await fs.rm(skill.skillDir, { recursive: true, force: true });
  await refreshWorkspaceSkillsMirror({ workspaceRoot: input.workspaceRoot });
  return {
    id: path.basename(skill.skillDir),
    name: skill.name,
    description: skill.description,
    relativePath: skill.relativePath,
  };
}

export async function readSkillById(input: {
  workspaceRoot: string;
  id: string;
}): Promise<{ skill: WorkspaceSkillCatalogEntry & { authored: boolean }; markdown: string }> {
  const skill = await findSkillById(input.workspaceRoot, input.id);
  if (!skill) {
    throw new Error(`No skill with id "${input.id}". Use skill list to see current skills.`);
  }
  const markdown = await fs.readFile(path.join(skill.skillDir, "SKILL.md"), "utf8");
  return { skill, markdown };
}
