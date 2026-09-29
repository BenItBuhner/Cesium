import { createAuthoredSkill, deleteAuthoredSkill, listAuthorableSkills, readSkillById, updateAuthoredSkill } from "../../cesium-skill-authoring.js";
import { slugifySkillId } from "../../skills-mirror.js";
import { asString } from "../cesium-coerce.js";
import type { CesiumToolContext } from "./types.js";

/** Agent Skills authoring: create/update/list/read/delete SKILL.md documents. */
export async function skillTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const action = asString(args.action)?.trim().toLowerCase();
  const workspaceRoot = ctx.workspace.root;
  switch (action) {
    case "create": {
      const name = asString(args.name)?.trim();
      const description = asString(args.description)?.trim();
      const instructions = asString(args.instructions)?.trim();
      if (!name || !description || !instructions) {
        throw new Error("skill.create requires name, description, and instructions.");
      }
      const created = await createAuthoredSkill({
        workspaceRoot,
        name,
        description,
        instructions,
        id: asString(args.id)?.trim() || undefined,
      });
      return (
        `Created skill "${created.name}" (id: ${created.id}) at ${created.relativePath}. ` +
        "It is mirrored under agent-skills/ and will appear in the skills list from the next turn."
      );
    }
    case "update": {
      const id = asString(args.id)?.trim();
      if (!id) {
        throw new Error("skill.id is required for update.");
      }
      const updated = await updateAuthoredSkill({
        workspaceRoot,
        id,
        name: asString(args.name)?.trim() || undefined,
        description: asString(args.description)?.trim() || undefined,
        instructions: asString(args.instructions)?.trim() || undefined,
      });
      return `Updated skill "${updated.name}" (id: ${updated.id}) at ${updated.relativePath}.`;
    }
    case "list": {
      const skills = await listAuthorableSkills(workspaceRoot);
      if (skills.length === 0) {
        return "No skills discovered in this workspace yet. Use skill create to author one.";
      }
      return [
        `${skills.length} skill${skills.length === 1 ? "" : "s"} discovered:`,
        ...skills.map(
          (skill) =>
            `- ${skill.name} (id: ${slugifySkillId(skill.name)}) - ${skill.description} [${
              skill.authored ? "agent-authored" : `read-only: ${skill.source}`
            }]`
        ),
      ].join("\n");
    }
    case "read": {
      const id = asString(args.id)?.trim();
      if (!id) {
        throw new Error("skill.id is required for read.");
      }
      const { skill, markdown } = await readSkillById({ workspaceRoot, id });
      return `# ${skill.relativePath}\n\n${markdown}`;
    }
    case "delete": {
      const id = asString(args.id)?.trim();
      if (!id) {
        throw new Error("skill.id is required for delete.");
      }
      const removed = await deleteAuthoredSkill({ workspaceRoot, id });
      return `Deleted skill "${removed.name}" (id: ${removed.id}).`;
    }
    default:
      throw new Error(
        'skill.action must be one of "create", "update", "list", "read", "delete".'
      );
  }
}
