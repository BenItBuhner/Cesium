import { Hono } from "hono";
import type { CesiumUpdateApplyEvent, CesiumUpdateSettings } from "@cesium/contracts";
import { applySelfUpdate } from "../lib/updates/apply.js";
import { detectInstallKind } from "../lib/updates/install-kind.js";
import {
  checkForUpdates,
  getUpdateStatus,
  isUpdateApplyInFlight,
  resolveSelfUpdateSupport,
  setUpdateApplyInFlight,
  updateUpdateSettings,
} from "../lib/updates/update-manager.js";

export const updateRoutes = new Hono();

/** Cached status only - never touches the network. */
updateRoutes.get("/api/updates/status", async (c) => {
  const status = await getUpdateStatus();
  c.header("cache-control", "no-store");
  return c.json(status);
});

/** Refresh every feed (GitHub releases, npm registry, git remote) now. */
updateRoutes.post("/api/updates/check", async (c) => {
  const status = await checkForUpdates();
  c.header("cache-control", "no-store");
  return c.json(status);
});

updateRoutes.put("/api/updates/settings", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | Partial<CesiumUpdateSettings>
    | null;
  if (!body || typeof body !== "object") {
    return c.json({ error: "Expected a JSON settings object." }, 400);
  }
  const patch: Partial<CesiumUpdateSettings> = {};
  if (typeof body.autoCheck === "boolean") patch.autoCheck = body.autoCheck;
  if (typeof body.includePrereleases === "boolean") {
    patch.includePrereleases = body.includePrereleases;
  }
  if (body.dismissedVersion === null || typeof body.dismissedVersion === "string") {
    patch.dismissedVersion = body.dismissedVersion;
  }
  const status = await updateUpdateSettings(patch);
  c.header("cache-control", "no-store");
  return c.json(status);
});

/**
 * Run the self-update strategy for this install kind, streaming NDJSON
 * progress events (`CesiumUpdateApplyEvent` per line). Refused up front when
 * the installation has no automated path (desktop, unknown).
 */
updateRoutes.post("/api/updates/apply", (c) => {
  const installKind = detectInstallKind();
  const support = resolveSelfUpdateSupport(installKind);
  if (!support.supported) {
    return c.json(
      {
        error:
          support.reason ??
          `Self-update is not supported for the ${installKind} installation type.`,
      },
      400
    );
  }
  if (isUpdateApplyInFlight()) {
    return c.json({ error: "An update is already being applied." }, 409);
  }
  setUpdateApplyInFlight(true);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const emit = (event: CesiumUpdateApplyEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      void applySelfUpdate({ installKind, emit })
        .catch((error) => {
          emit({
            type: "done",
            ok: false,
            restartRequired: false,
            error: (error as Error).message,
          });
        })
        .finally(() => {
          setUpdateApplyInFlight(false);
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed by a disconnecting client
          }
        });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    },
  });
});
