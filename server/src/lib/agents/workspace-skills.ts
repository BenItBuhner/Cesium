import fs from "node:fs/promises";
import path from "node:path";

/**
 * Workspace Agent Skills discovery (agentskills.io / SKILL.md open standard).
 *
 * Progressive disclosure: catalog only name + description + path here.
 * The agent should read SKILL.md on demand via read_file when relevant.
 */

export type WorkspaceSkillCatalogEntry = {
  name: string;
  description: string;
  /** Workspace-relative path to SKILL.md */
  relativePath: string;
  /** Absolute path to the skill directory (parent of SKILL.md) */
  skillDir: string;
  source: "agents" | "cursor" | "claude" | "codex";
  /** When true, skill is user-invoked only (Cursor disable-model-invocation). */
  disableModelInvocation: boolean;
};

const PROJECT_SKILL_ROOTS: Array<{
  relativeDir: string;
  source: WorkspaceSkillCatalogEntry["source"];
}> = [
  { relativeDir: path.join(".agents", "skills"), source: "agents" },
  { relativeDir: path.join(".cursor", "skills"), source: "cursor" },
  { relativeDir: path.join(".claude", "skills"), source: "claude" },
  { relativeDir: path.join(".codex", "skills"), source: "codex" },
];

const SKIP_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "__pycache__",
]);

const MAX_SKILLS = 200;
const MAX_WALK_DEPTH = 6;

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "yes" || normalized === "1";
}

/**
 * Minimal YAML frontmatter parser for Agent Skills SKILL.md files.
 * Supports scalar string/boolean fields used by the open spec + Cursor extensions.
 */
export function parseSkillFrontmatter(raw: string): {
  name?: string;
  description?: string;
  disableModelInvocation: boolean;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return { disableModelInvocation: false };
  }
  const block = match[1];
  const fields: Record<string, string> = {};
  let currentKey: string | null = null;
  let currentValue: string[] = [];

  const flush = () => {
    if (!currentKey) return;
    fields[currentKey] = currentValue.join(" ").trim();
    currentKey = null;
    currentValue = [];
  };

  for (const line of block.split(/\r?\n/)) {
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
      flush();
      currentKey = keyMatch[1];
      const rest = keyMatch[2].trim();
      if (
        (rest.startsWith('"') && rest.endsWith('"')) ||
        (rest.startsWith("'") && rest.endsWith("'"))
      ) {
        currentValue = [rest.slice(1, -1)];
      } else {
        currentValue = rest ? [rest] : [];
      }
      continue;
    }
    if (currentKey && (line.startsWith(" ") || line.startsWith("\t"))) {
      currentValue.push(line.trim());
    }
  }
  flush();

  return {
    name: fields.name?.trim() || undefined,
    description: fields.description?.trim() || undefined,
    disableModelInvocation:
      parseBoolean(fields["disable-model-invocation"]) ||
      parseBoolean(fields.disableModelInvocation),
  };
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function walkForSkillMd(
  absoluteDir: string,
  depth: number,
  out: string[]
): Promise<void> {
  if (depth > MAX_WALK_DEPTH || out.length >= MAX_SKILLS) return;
  let entries;
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_SKILLS) return;
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      await walkForSkillMd(full, depth + 1, out);
      continue;
    }
    if (entry.isFile() && entry.name === "SKILL.md") {
      out.push(full);
    }
  }
}

function toPosixRelative(workspaceRoot: string, absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath).split(path.sep).join("/");
}

export async function discoverWorkspaceSkills(
  workspaceRoot: string
): Promise<WorkspaceSkillCatalogEntry[]> {
  const found: WorkspaceSkillCatalogEntry[] = [];
  const seenNames = new Set<string>();

  for (const root of PROJECT_SKILL_ROOTS) {
    const absoluteRoot = path.join(workspaceRoot, root.relativeDir);
    if (!(await pathExists(absoluteRoot))) continue;
    const skillFiles: string[] = [];
    await walkForSkillMd(absoluteRoot, 0, skillFiles);

    for (const skillFile of skillFiles) {
      if (found.length >= MAX_SKILLS) break;
      let raw: string;
      try {
        raw = await fs.readFile(skillFile, "utf8");
      } catch {
        continue;
      }
      const meta = parseSkillFrontmatter(raw);
      const dirName = path.basename(path.dirname(skillFile));
      const name = (meta.name || dirName).trim().toLowerCase();
      if (!name || seenNames.has(name)) continue;
      const description = (meta.description || "").trim();
      if (!description) continue;

      seenNames.add(name);
      found.push({
        name,
        description,
        relativePath: toPosixRelative(workspaceRoot, skillFile),
        skillDir: path.dirname(skillFile),
        source: root.source,
        disableModelInvocation: meta.disableModelInvocation,
      });
    }
  }

  return found;
}

export function formatWorkspaceSkillsCatalog(
  skills: WorkspaceSkillCatalogEntry[]
): string {
  if (skills.length === 0) {
    return "";
  }

  const lines = [
    "Workspace Agent Skills (SKILL.md catalog — progressive disclosure):",
    "When a task matches a skill description, or the user cites/tags a skill, read that skill's SKILL.md with the read_file tool before acting. Resolve relative paths from the skill directory (the parent of SKILL.md). Do not guess skill instructions from memory.",
    "",
  ];

  for (const skill of skills) {
    const manual = skill.disableModelInvocation
      ? " [manual only — use when the user explicitly requests this skill]"
      : "";
    lines.push(`- ${skill.name}: ${skill.description}${manual}`);
    lines.push(`  Location: ${skill.relativePath}`);
  }

  return lines.join("\n");
}

export async function resolveWorkspaceSkillsList(workspaceRoot: string): Promise<string> {
  const skills = await discoverWorkspaceSkills(workspaceRoot);
  return formatWorkspaceSkillsCatalog(skills);
}
