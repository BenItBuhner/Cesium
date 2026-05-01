import { Hono } from "hono";
import { Cursor } from "@cursor/sdk";
import {
  getGlobalSettings,
  saveGlobalSettings,
  getModelToggleState,
  setModelToggles,
  refreshAndGetModelToggleState,
  type GlobalSettings,
  type ModelToggleUpdate,
} from "../lib/global-settings-store.js";
import { WriteCoalescer } from "../storage/coalesce.js";
import {
  deleteCursorSdkApiKey,
  getCursorSdkCredentialStatus,
  saveCursorSdkApiKey,
} from "../lib/cursor-sdk-credentials.js";
import {
  bumpRevision,
  formatEtag,
  getRevision,
  parseRevisionHeader,
} from "../storage/revisions.js";
import { AGENT_BACKENDS } from "../lib/agents/providers.js";
import type { AgentBackendId } from "../lib/agents/types.js";

export const settingsRoutes = new Hono();

const GLOBAL_SETTINGS_KEY = "settings:global";

const globalSettingsCoalescer = new WriteCoalescer<GlobalSettings>(
  async (_key, settings) => {
    await saveGlobalSettings(settings);
  },
  50
);

function allBackendIds(): AgentBackendId[] {
  return Object.keys(AGENT_BACKENDS) as AgentBackendId[];
}

settingsRoutes.get("/api/settings/global", async (c) => {
  const settings = await getGlobalSettings();
  const revision = getRevision(GLOBAL_SETTINGS_KEY);
  const etag = formatEtag(revision);

  const ifNoneMatch = parseRevisionHeader(c.req.header("if-none-match"));
  c.header(
    "Cache-Control",
    "private, max-age=10, stale-while-revalidate=60, must-revalidate"
  );
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

  let toSave = body.settings;
  const incomingByBackend = toSave.models?.byBackend;
  if (
    !incomingByBackend ||
    Object.keys(incomingByBackend).length === 0
  ) {
    const onDisk = await getGlobalSettings();
    const onDiskByBackend = onDisk.models?.byBackend;
    if (onDiskByBackend && Object.keys(onDiskByBackend).length > 0) {
      toSave = {
        ...toSave,
        models: { byBackend: { ...onDiskByBackend } },
      };
    }
  }

  if (process.env.NODE_ENV === "test") {
    await saveGlobalSettings(toSave);
  } else {
    globalSettingsCoalescer.schedule("global", toSave);
  }

  const nextRevision = bumpRevision(GLOBAL_SETTINGS_KEY);
  c.header("ETag", formatEtag(nextRevision));
  return c.json({ ok: true, revision: nextRevision });
});

settingsRoutes.get("/api/settings/models-by-backend", async (c) => {
  const toggleState = await getModelToggleState(allBackendIds());
  const byBackend: Record<string, Array<{ id: string; name: string }>> = {};
  for (const [backendId, entries] of Object.entries(toggleState.byBackend)) {
    byBackend[backendId] = entries.map(({ id, name }) => ({ id, name }));
  }
  return c.json({ byBackend });
});

settingsRoutes.get("/api/settings/models", async (c) => {
  const toggleState = await getModelToggleState(allBackendIds());
  return c.json(toggleState);
});

settingsRoutes.get("/api/settings/cursor-sdk", async (c) => {
  return c.json({ status: await getCursorSdkCredentialStatus() });
});

settingsRoutes.put("/api/settings/cursor-sdk", async (c) => {
  const body = await c.req.json<{ apiKey?: string }>();
  const apiKey = body.apiKey?.trim();
  if (!apiKey) {
    return c.json({ error: "Expected Cursor API key." }, 400);
  }

  try {
    const me = await Cursor.me({ apiKey });
    const status = await saveCursorSdkApiKey({
      apiKey,
      apiKeyName: me.apiKeyName,
      userEmail: me.userEmail,
    });
    return c.json({ ok: true, status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to verify Cursor API key.";
    return c.json({ error: message }, 400);
  }
});

settingsRoutes.delete("/api/settings/cursor-sdk", async (c) => {
  await deleteCursorSdkApiKey();
  return c.json({ ok: true, status: await getCursorSdkCredentialStatus() });
});

settingsRoutes.post("/api/settings/models/refresh", async (c) => {
  const result = await refreshAndGetModelToggleState(allBackendIds());
  return c.json({
    byBackend: result.toggleState.byBackend,
    timedOut: result.timedOut,
    failed: result.failed,
  });
});

settingsRoutes.put("/api/settings/models/toggles", async (c) => {
  const body = await c.req.json<{ toggles?: ModelToggleUpdate[] }>();
  if (!Array.isArray(body.toggles) || body.toggles.length === 0) {
    return c.json({ error: "Expected toggles array" }, 400);
  }
  const result = await setModelToggles(body.toggles);
  return c.json(result);
});
