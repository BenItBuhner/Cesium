import { Hono } from "hono";
import { requireWorkspaceFromRequest } from "../lib/request-workspace.js";
import {
  exportConversationSnapshot,
  materializeCloudSnapshot,
} from "../lib/agents/cloud-snapshot.js";

/**
 * Cloud Context endpoints: portable conversation snapshots.
 *
 * The engine never talks to the cloud itself - the client exports a snapshot
 * here, pushes it to the user's cloud context (Convex), and later pulls it
 * down on any other engine and materializes it via the import chassis.
 */
export const cloudContextRoutes = new Hono();

cloudContextRoutes.get(
  "/api/agents/conversations/:conversationId/snapshot",
  async (c) => {
    const workspace = await requireWorkspaceFromRequest(c);
    const conversationId = c.req.param("conversationId");
    const snapshot = await exportConversationSnapshot(workspace, conversationId);
    if (!snapshot) {
      return c.json({ error: `Unknown conversation: ${conversationId}` }, 404);
    }
    c.header("cache-control", "no-store");
    return c.json({ snapshot });
  }
);

cloudContextRoutes.post("/api/agents/imports/cloud-snapshot", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const body = await c.req
    .json<{
      snapshotKey?: string;
      recordJson?: string;
      eventsJson?: string;
      sourceServerName?: string | null;
      sourceWorkspaceName?: string | null;
      sourceUpdatedAt?: number | null;
    }>()
    .catch(() => null);
  if (
    !body ||
    typeof body.snapshotKey !== "string" ||
    !body.snapshotKey.trim() ||
    typeof body.recordJson !== "string" ||
    typeof body.eventsJson !== "string"
  ) {
    return c.json(
      { error: "Expected snapshotKey, recordJson, and eventsJson." },
      400
    );
  }
  try {
    const result = await materializeCloudSnapshot({
      workspace,
      snapshotKey: body.snapshotKey.trim(),
      recordJson: body.recordJson,
      eventsJson: body.eventsJson,
      sourceServerName: body.sourceServerName ?? null,
      sourceWorkspaceName: body.sourceWorkspaceName ?? null,
      sourceUpdatedAt: body.sourceUpdatedAt ?? null,
    });
    return c.json({ result });
  } catch (error) {
    return c.json(
      {
        error: `Could not materialize snapshot: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      400
    );
  }
});
