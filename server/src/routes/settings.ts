import { Hono } from "hono";
import {
  getGlobalSettings,
  saveGlobalSettings,
  type GlobalSettings,
} from "../lib/global-settings-store.js";

export const settingsRoutes = new Hono();

settingsRoutes.get("/api/settings/global", async (c) => {
  const settings = await getGlobalSettings();
  return c.json({ settings });
});

settingsRoutes.put("/api/settings/global", async (c) => {
  const body = await c.req.json<{ settings?: GlobalSettings }>();
  if (!body.settings) {
    return c.json({ error: "Expected settings payload" }, 400);
  }
  await saveGlobalSettings(body.settings);
  return c.json({ ok: true });
});
