import { Hono } from "hono";
import { getUsageOverview } from "../lib/usage/index.js";

/**
 * Cross-harness subscription usage ("Codex Meter for everything"): local-only
 * aggregation of the session artifacts each coding-agent CLI writes to disk.
 */
export const usageRoutes = new Hono();

usageRoutes.get("/api/usage/overview", async (c) => {
  const daysRaw = Number.parseInt(c.req.query("days") ?? "30", 10);
  const days = Number.isFinite(daysRaw) ? daysRaw : 30;
  const refresh = c.req.query("refresh") === "1";
  const overview = await getUsageOverview({ days, refresh });
  return c.json(overview);
});
