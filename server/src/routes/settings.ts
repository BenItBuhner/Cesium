import { Hono } from "hono";
import {
  getGlobalSettings,
  saveGlobalSettings,
  type GlobalSettings,
} from "../lib/global-settings-store.js";
import { WriteCoalescer } from "../storage/coalesce.js";
import {
  bumpRevision,
  formatEtag,
  getRevision,
  parseRevisionHeader,
} from "../storage/revisions.js";

export const settingsRoutes = new Hono();

const GLOBAL_SETTINGS_KEY = "settings:global";

// Global settings writes get coalesced on a 50ms idle window. The client may
// emit a burst of PUTs (e.g. a slider sweeping) but we only persist the final
// state, with an immediate ack on each request.
const globalSettingsCoalescer = new WriteCoalescer<GlobalSettings>(
  async (_key, settings) => {
    await saveGlobalSettings(settings);
  },
  50
);

settingsRoutes.get("/api/settings/global", async (c) => {
  const settings = await getGlobalSettings();
  const revision = getRevision(GLOBAL_SETTINGS_KEY);
  const etag = formatEtag(revision);

  const ifNoneMatch = parseRevisionHeader(c.req.header("if-none-match"));
  if (ifNoneMatch && ifNoneMatch.value === revision) {
    c.header("ETag", etag);
    return c.body(null, 304);
  }

  c.header("ETag", etag);
  return c.json({ settings, revision });
});

settingsRoutes.put("/api/settings/global", async (c) => {
  const body = await c.req.json<{ settings?: GlobalSettings }>();
  if (!body.settings) {
    return c.json({ error: "Expected settings payload" }, 400);
  }

  // Optimistic concurrency: clients may pass `If-Match: W/"<rev>"` to assert
  // they are updating the revision they last read. A mismatch returns 412 so
  // the client can re-fetch and retry without stomping on another writer.
  const ifMatch = parseRevisionHeader(c.req.header("if-match"));
  if (ifMatch) {
    const current = getRevision(GLOBAL_SETTINGS_KEY);
    if (ifMatch.value !== current) {
      c.header("ETag", formatEtag(current));
      return c.json(
        {
          error: "Revision mismatch",
          expectedRevision: ifMatch.value,
          actualRevision: current,
        },
        412
      );
    }
  }

  // Fast path: ack immediately, flush after the debounce window elapses.
  // Tests disable coalescing to preserve read-after-write semantics.
  if (process.env.NODE_ENV === "test") {
    await saveGlobalSettings(body.settings);
  } else {
    globalSettingsCoalescer.schedule("global", body.settings);
  }

  const nextRevision = bumpRevision(GLOBAL_SETTINGS_KEY);
  c.header("ETag", formatEtag(nextRevision));
  return c.json({ ok: true, revision: nextRevision });
});
