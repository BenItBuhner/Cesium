import fs from "node:fs/promises";
import path from "node:path";

export const NO_INSTRUCTION_FILES_PLACEHOLDER =
  "(No AGENTS.md or CLAUDE.md file is present in this workspace.)";

const INSTRUCTION_CANDIDATES = [
  { label: "AGENTS.md", relativePath: "AGENTS.md" },
  { label: "CLAUDE.md", relativePath: "CLAUDE.md" },
  { label: "CLAUDE.md", relativePath: path.join(".claude", "CLAUDE.md") },
] as const;

async function readOptionalTextFile(absolutePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(absolutePath, "utf8");
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Load project instruction files for Cesium prompt injection.
 * AGENTS.md is the open cross-agent standard; CLAUDE.md is Claude Code's
 * equivalent. When both exist, CLAUDE.md content is appended under AGENTS.md.
 * Root CLAUDE.md wins over `.claude/CLAUDE.md` when both are present.
 */
export async function loadWorkspaceInstructionFiles(workspaceRoot: string): Promise<string> {
  const agents = await readOptionalTextFile(path.join(workspaceRoot, "AGENTS.md"));

  const rootClaude = await readOptionalTextFile(path.join(workspaceRoot, "CLAUDE.md"));
  const nestedClaude =
    rootClaude === null
      ? await readOptionalTextFile(path.join(workspaceRoot, ".claude", "CLAUDE.md"))
      : null;
  const claude = rootClaude ?? nestedClaude;
  const claudeLabel =
    rootClaude !== null
      ? "CLAUDE.md"
      : nestedClaude !== null
        ? ".claude/CLAUDE.md"
        : "CLAUDE.md";

  if (!agents && !claude) {
    return NO_INSTRUCTION_FILES_PLACEHOLDER;
  }

  const sections: string[] = [];
  if (agents) {
    sections.push(`### AGENTS.md\n\n${agents}`);
  }
  if (claude) {
    sections.push(`### ${claudeLabel}\n\n${claude}`);
  }
  return sections.join("\n\n");
}

export function instructionFilesSectionTitle(): string {
  return "Project Instruction Files";
}

/** Exported for tests / docs — discovery order for instruction files. */
export function listInstructionFileCandidates(): ReadonlyArray<{
  label: string;
  relativePath: string;
}> {
  return INSTRUCTION_CANDIDATES;
}
