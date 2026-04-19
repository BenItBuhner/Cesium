import { Hono } from "hono";
import { requireWorkspaceFromRequest } from "../lib/request-workspace.js";
import {
  createTerminalSession,
  killTerminalSession,
  listTerminalSessions,
} from "../ws/terminal.js";
import { setShortCache } from "../lib/cache-headers.js";

export const terminalRoutes = new Hono();

terminalRoutes.get("/api/terminals", (c) => {
  const workspaceId = c.req.header("x-opencursor-workspace-id")?.trim();
  setShortCache(c, { maxAgeSec: 5, swr: 30 });
  return c.json({
    terminals: listTerminalSessions().filter((terminal) =>
      workspaceId ? terminal.workspaceId === workspaceId : true
    ),
  });
});

terminalRoutes.post("/api/terminals", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const body = (await c.req.json<{ shell?: string }>().catch(() => null)) ?? {};
  const terminal = createTerminalSession(workspace.id, workspace.root, body.shell);
  return c.json(terminal, 201);
});

terminalRoutes.delete("/api/terminals/:id", (c) => {
  const id = c.req.param("id");
  const deleted = killTerminalSession(id);
  if (!deleted) {
    return c.json({ error: `Unknown terminal: ${id}` }, 404);
  }
  return c.json({ ok: true });
});
