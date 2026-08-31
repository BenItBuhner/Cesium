/**
 * Health / meta / auth endpoints. The browser machine has no auth layer:
 * it runs in the user's own page, so `/api/auth/status` reports auth
 * disabled + authenticated, exactly like a loopback engine without a
 * password.
 */
import { CESIUM_CAPABILITIES, CESIUM_PROTOCOL_VERSION } from "@cesium/contracts";
import type { EngineRouter } from "../http";
import { jsonResponse } from "../http";

export const BROWSER_MACHINE_INSTANCE_ID = "browser-machine";
export const BROWSER_MACHINE_VERSION = "0.1.0";

export function registerCoreRoutes(router: EngineRouter): void {
  router.get("/health", () =>
    jsonResponse({
      ok: true,
      instanceId: BROWSER_MACHINE_INSTANCE_ID,
      transcription: { configured: false },
    })
  );

  router.get("/api/meta", () =>
    jsonResponse({
      name: "cesium",
      protocolVersion: CESIUM_PROTOCOL_VERSION,
      capabilities: [...CESIUM_CAPABILITIES],
      serverVersion: BROWSER_MACHINE_VERSION,
      transports: { http: "/api", websocket: "/ws" },
    })
  );

  router.get("/api/auth/status", () =>
    jsonResponse({
      enabled: false,
      authenticated: true,
      session: null,
      rotationIntervalMs: 0,
    })
  );

  router.post("/api/auth/logout", () => jsonResponse({ ok: true }));
}
