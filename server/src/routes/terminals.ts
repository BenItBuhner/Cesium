import { Hono } from "hono";
import {
  createTerminalSession,
  killTerminalSession,
  listTerminalSessions,
} from "../ws/terminal.js";

export const terminalRoutes = new Hono();

terminalRoutes.get("/api/terminals", (c) => {
  return c.json({
    terminals: listTerminalSessions(),
  });
});

terminalRoutes.post("/api/terminals", async (c) => {
  const body = (await c.req.json<{ shell?: string }>().catch(() => null)) ?? {};
  const terminal = createTerminalSession(body.shell);
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
