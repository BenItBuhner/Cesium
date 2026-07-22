import type { PhoneControlCapabilities } from "@cesium/core/phone-control";
import { Hono } from "hono";
import {
  authorizePhoneDevice,
  completePhoneCommand,
  listPhoneDevices,
  readPhoneCommands,
  registerPhoneDeviceSession,
  unregisterPhoneDevice,
} from "../lib/phone-control/service.js";
import { requireWorkspaceFromRequest } from "../lib/request-workspace.js";

export const phoneControlRoutes = new Hono();

phoneControlRoutes.get("/api/phone-control/devices", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  return c.json({ devices: listPhoneDevices(workspace.id) });
});

phoneControlRoutes.post("/api/phone-control/devices/register", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const body = await c.req.json<{
    deviceId?: string;
    name?: string;
    capabilities?: Partial<PhoneControlCapabilities>;
    appVersion?: string;
    androidVersion?: string;
    sdkInt?: number;
    model?: string;
    deviceToken?: string;
  }>();
  if (!body.deviceId?.trim()) {
    return c.json({ error: "Expected deviceId." }, 400);
  }
  try {
    const session = registerPhoneDeviceSession({
      workspaceId: workspace.id,
      deviceId: body.deviceId,
      name: body.name,
      capabilities: body.capabilities,
      appVersion: body.appVersion,
      androidVersion: body.androidVersion,
      sdkInt: body.sdkInt,
      model: body.model,
      deviceToken: body.deviceToken,
    });
    return c.json(session, 201);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to register phone.";
    return c.json(
      { error: message },
      message.includes("pairing token") ? 403 : 400
    );
  }
});

phoneControlRoutes.delete("/api/phone-control/devices/:deviceId", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const removed = unregisterPhoneDevice(workspace.id, c.req.param("deviceId"));
  return removed
    ? c.json({ ok: true })
    : c.json({ error: "Phone device not found." }, 404);
});

phoneControlRoutes.get(
  "/api/phone-control/devices/:deviceId/commands",
  async (c) => {
    const workspace = await requireWorkspaceFromRequest(c);
    const afterSeq = Number.parseInt(c.req.query("after") ?? "0", 10);
    const waitMs = Number.parseInt(c.req.query("waitMs") ?? "0", 10);
    try {
      authorizePhoneDevice(
        workspace.id,
        c.req.param("deviceId"),
        c.req.header("x-cesium-phone-token")
      );
      return c.json(
        await readPhoneCommands({
          workspaceId: workspace.id,
          deviceId: c.req.param("deviceId"),
          afterSeq: Number.isFinite(afterSeq) ? Math.max(0, afterSeq) : 0,
          waitMs: Number.isFinite(waitMs) ? Math.max(0, waitMs) : 0,
        })
      );
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Failed to read phone commands." },
        404
      );
    }
  }
);

phoneControlRoutes.post(
  "/api/phone-control/devices/:deviceId/commands/:commandId/result",
  async (c) => {
    const workspace = await requireWorkspaceFromRequest(c);
    const body: { ok?: boolean; result?: unknown; error?: string } = await c.req
      .json<{ ok?: boolean; result?: unknown; error?: string }>()
      .catch(() => ({}));
    try {
      authorizePhoneDevice(
        workspace.id,
        c.req.param("deviceId"),
        c.req.header("x-cesium-phone-token")
      );
      const result = completePhoneCommand({
        workspaceId: workspace.id,
        deviceId: c.req.param("deviceId"),
        commandId: c.req.param("commandId"),
        ok: body.ok !== false,
        result: body.result,
        error: body.error,
      });
      return c.json({ result });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Failed to complete phone command." },
        404
      );
    }
  }
);
