import { Hono } from "hono";
import { requireWorkspaceFromRequest } from "../lib/request-workspace.js";
import {
  closeBrowserControlTab,
  completeBrowserControlCommand,
  dispatchBrowserControlInput,
  evaluateBrowserControlTab,
  focusBrowserControlTab,
  listBrowserControlTabs,
  markBrowserControlUserIntervention,
  moveBrowserControlTab,
  navigateBrowserControlTab,
  openBrowserControlTab,
  readBrowserControlCommands,
  readBrowserControlEvents,
  screenshotBrowserControlTab,
  setBrowserControlLock,
  setBrowserControlViewport,
  snapshotBrowserControlTab,
} from "../lib/browser-control/service.js";
import type {
  BrowserControlGroup,
  BrowserControlInput,
  BrowserControlViewport,
} from "../lib/browser-control/types.js";

export const browserControlRoutes = new Hono();

function asGroup(value: unknown): BrowserControlGroup {
  return value === "left" ? "left" : "right";
}

browserControlRoutes.get("/api/browser-control/tabs", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  return c.json({ tabs: listBrowserControlTabs(workspace.id) });
});

browserControlRoutes.post("/api/browser-control/tabs", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const body = await c.req.json<{
    url?: string;
    title?: string;
    group?: BrowserControlGroup;
    engine?: "proxy" | "electron-native" | "server-chromium";
    active?: boolean;
    viewport?: Record<string, unknown>;
  }>();
  const url = body.url?.trim();
  if (!url) return c.json({ error: "Expected url." }, 400);
  try {
    const tab = await openBrowserControlTab({
      workspaceId: workspace.id,
      url,
      title: body.title,
      group: asGroup(body.group),
      engine: body.engine,
      active: body.active,
      viewport: (body.viewport as Partial<BrowserControlViewport> | undefined) ?? undefined,
    });
    return c.json({ tab }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to open browser tab.";
    return c.json({ error: message }, 400);
  }
});

browserControlRoutes.delete("/api/browser-control/tabs/:tabId", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  try {
    await closeBrowserControlTab(workspace.id, c.req.param("tabId"));
    return c.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to close browser tab.";
    return c.json({ error: message }, 404);
  }
});

browserControlRoutes.post("/api/browser-control/tabs/:tabId/focus", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  try {
    return c.json({ tab: focusBrowserControlTab(workspace.id, c.req.param("tabId")) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to focus browser tab.";
    return c.json({ error: message }, 404);
  }
});

browserControlRoutes.post("/api/browser-control/tabs/:tabId/move", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const body = await c.req.json<{ group?: BrowserControlGroup }>();
  try {
    return c.json({
      tab: moveBrowserControlTab(workspace.id, c.req.param("tabId"), asGroup(body.group)),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to move browser tab.";
    return c.json({ error: message }, 404);
  }
});

browserControlRoutes.post("/api/browser-control/tabs/:tabId/navigate", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const body = await c.req.json<
    { op?: "goto"; url?: string } | { op?: "reload" | "back" | "forward"; url?: undefined }
  >();
  if (!body.op) return c.json({ error: "Expected op." }, 400);
  if (body.op === "goto" && !body.url?.trim()) return c.json({ error: "Expected url." }, 400);
  try {
    const tab = await navigateBrowserControlTab(
      workspace.id,
      c.req.param("tabId"),
      body.op === "goto" ? { op: "goto", url: body.url!.trim() } : { op: body.op }
    );
    return c.json({ tab });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to navigate browser tab.";
    return c.json({ error: message }, 400);
  }
});

browserControlRoutes.post("/api/browser-control/tabs/:tabId/lock", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const body = await c.req.json<{
    locked?: boolean;
    conversationId?: string | null;
    reason?: string | null;
    userInitiated?: boolean;
  }>();
  try {
    const tab = setBrowserControlLock({
      workspaceId: workspace.id,
      tabId: c.req.param("tabId"),
      locked: body.locked !== false,
      conversationId: body.conversationId,
      reason: body.reason,
      userInitiated: body.userInitiated,
    });
    return c.json({ tab });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update browser lock.";
    return c.json({ error: message }, 404);
  }
});

browserControlRoutes.delete("/api/browser-control/tabs/:tabId/lock", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  try {
    const tab = setBrowserControlLock({
      workspaceId: workspace.id,
      tabId: c.req.param("tabId"),
      locked: false,
      userInitiated: true,
    });
    return c.json({ tab });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to unlock browser tab.";
    return c.json({ error: message }, 404);
  }
});

browserControlRoutes.post("/api/browser-control/tabs/:tabId/user-intervention", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const body = await c.req.json<{ detail?: string }>().catch(() => ({}));
  try {
    return c.json({
      tab: markBrowserControlUserIntervention(
        workspace.id,
        c.req.param("tabId"),
        "detail" in body ? body.detail : undefined
      ),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to mark user intervention.";
    return c.json({ error: message }, 404);
  }
});

browserControlRoutes.post("/api/browser-control/tabs/:tabId/viewport", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const body = await c.req.json<Record<string, unknown>>();
  try {
    const tab = await setBrowserControlViewport(
      workspace.id,
      c.req.param("tabId"),
      body as Partial<BrowserControlViewport>
    );
    return c.json({ tab });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to set browser viewport.";
    return c.json({ error: message }, 400);
  }
});

browserControlRoutes.post("/api/browser-control/tabs/:tabId/input", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const body = await c.req.json<BrowserControlInput>();
  try {
    const ok = await dispatchBrowserControlInput(workspace.id, c.req.param("tabId"), body);
    return c.json({ ok });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to dispatch browser input.";
    return c.json({ error: message }, 400);
  }
});

browserControlRoutes.post("/api/browser-control/tabs/:tabId/evaluate", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const body = await c.req.json<{ script?: string }>();
  if (!body.script?.trim()) return c.json({ error: "Expected script." }, 400);
  try {
    const result = await evaluateBrowserControlTab(workspace.id, c.req.param("tabId"), body.script);
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to evaluate browser JavaScript.";
    return c.json({ error: message }, 400);
  }
});

browserControlRoutes.get("/api/browser-control/tabs/:tabId/snapshot", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  try {
    const snapshot = await snapshotBrowserControlTab(workspace.id, c.req.param("tabId"));
    return c.json({ snapshot });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to snapshot browser tab.";
    return c.json({ error: message }, 400);
  }
});

browserControlRoutes.get("/api/browser-control/tabs/:tabId/screenshot", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  try {
    return c.json(await screenshotBrowserControlTab(workspace.id, c.req.param("tabId")));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to screenshot browser tab.";
    return c.json({ error: message }, 400);
  }
});

browserControlRoutes.get("/api/browser-control/tabs/:tabId/events", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const after = Number.parseInt(c.req.query("after") ?? "0", 10) || 0;
  return c.json(readBrowserControlEvents(workspace.id, c.req.param("tabId"), after));
});

browserControlRoutes.get("/api/browser-control/tabs/:tabId/commands", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const after = Number.parseInt(c.req.query("after") ?? "0", 10) || 0;
  try {
    return c.json(readBrowserControlCommands(workspace.id, c.req.param("tabId"), after));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read browser commands.";
    return c.json({ error: message }, 404);
  }
});

browserControlRoutes.post("/api/browser-control/tabs/:tabId/commands/:seq/result", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const seq = Number.parseInt(c.req.param("seq"), 10);
  if (!Number.isFinite(seq) || seq <= 0) {
    return c.json({ error: "Expected command seq." }, 400);
  }
  const body = (await c.req.json<{
    ok?: boolean;
    result?: unknown;
    error?: string;
  }>().catch(() => ({}))) as {
    ok?: boolean;
    result?: unknown;
    error?: string;
  };
  try {
    return c.json({
      result: completeBrowserControlCommand({
        workspaceId: workspace.id,
        tabId: c.req.param("tabId"),
        seq,
        ok: body.ok !== false,
        result: body.result,
        error: body.error,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to complete browser command.";
    return c.json({ error: message }, 404);
  }
});
