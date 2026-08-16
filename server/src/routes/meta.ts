import { Hono } from "hono";
import {
  CESIUM_CAPABILITIES,
  CESIUM_PROTOCOL_VERSION,
  type CesiumServerMetadata,
} from "@cesium/contracts/meta";
import { resolveCurrentVersion } from "../lib/updates/app-version.js";

export const metaRoutes = new Hono();

metaRoutes.get("/api/meta", (c) => {
  const body: CesiumServerMetadata = {
    name: "cesium",
    protocolVersion: CESIUM_PROTOCOL_VERSION,
    capabilities: [...CESIUM_CAPABILITIES],
    serverVersion: resolveCurrentVersion(),
    transports: {
      http: "/api",
      websocket: "/ws",
    },
  };
  c.header("Cache-Control", "private, max-age=60");
  c.header("x-cesium-protocol-version", CESIUM_PROTOCOL_VERSION);
  return c.json(body);
});
