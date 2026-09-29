import { createWorkspaceWorktree, switchWorkspaceBranch } from "../../../git-worktrees.js";
import { listWorkspaces } from "../../../workspace-registry.js";
import { asString } from "../cesium-coerce.js";
import type { CesiumToolContext } from "./types.js";

/**
 * Self-relocation across git branches in the current workspace.
 *
 * NOTE(future): extend agent self-relocation beyond branches - the agent
 * could move this conversation to another repository, workspace, or
 * directory via `agentRuntimeManager.relocateConversation` with
 * `initiatedBy: "agent"`, letting it hop to a new project and keep working
 * there. Branch-only for now, on purpose.
 */
export async function switchBranchTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const branch = asString(args.branch)?.trim();
  if (!branch) {
    throw new Error("switch_branch.branch is required.");
  }
  const create = args.create === true;
  const workspaces = await listWorkspaces().catch(() => [ctx.workspace]);
  const result = await switchWorkspaceBranch({
    workspace: ctx.workspace,
    workspaces,
    branch,
    create,
  });
  if (result.checkedOutWorktree) {
    return (
      `Branch ${branch} is already checked out in worktree ${result.checkedOutWorktree.path}` +
      `${result.checkedOutWorktree.workspaceName ? ` (workspace "${result.checkedOutWorktree.workspaceName}")` : ""}. ` +
      "This checkout was left untouched - run terminal commands against that path, or ask the user to relocate this conversation there."
    );
  }
  return (
    `Switched ${ctx.workspace.root} to branch ${result.status.currentBranch ?? branch}` +
    `${result.created ? " (newly created)" : ""}. ` +
    "Files may differ on this branch - re-verify paths and re-read key files before editing."
  );
}

export async function createWorktreeTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const branch = asString(args.branch)?.trim();
  if (!branch) {
    throw new Error("create_worktree.branch is required.");
  }
  const baseBranch = asString(args.baseBranch)?.trim();
  const workspaces = await listWorkspaces().catch(() => [ctx.workspace]);
  const result = await createWorkspaceWorktree({
    workspace: ctx.workspace,
    workspaces,
    branch,
    ...(baseBranch ? { baseBranch } : {}),
    newBranch: true,
  });
  if (result.existingWorktree) {
    return (
      `Branch ${branch} already has a worktree at ${result.path}. Reuse it via terminal commands ` +
      "against that path instead of creating another checkout."
    );
  }
  return (
    `Worktree ready at ${result.path} on branch ${result.branch}` +
    `${result.setup.ran ? ` (setup commands ran: ${result.setup.commands.join("; ")})` : ""}. ` +
    "Keep one workstream per worktree: run its commands via terminal against that path, and when the work " +
    "is verified, merge the branch back (git merge/rebase from the main checkout) and remove the worktree."
  );
}
