import { Hono } from "hono";
import { buildPullRequestReview } from "../lib/pull-request-review.js";
import { getWorkspaceById } from "../lib/workspace-registry.js";

export const pullRequestRoutes = new Hono();

/**
 * Pull Request review for a workspace: local branch-vs-base commits and diffs,
 * plus best-effort GitHub PR metadata via the `gh` CLI. `?base=` overrides the
 * auto-detected comparison ref (e.g. `origin/main`).
 */
pullRequestRoutes.get("/api/workspaces/:workspaceId/pull-request", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    return c.json({ error: `Unknown workspace: ${workspaceId}` }, 404);
  }
  const baseRef = c.req.query("base") ?? undefined;
  const review = await buildPullRequestReview(workspace, { baseRef });
  return c.json({ review });
});
