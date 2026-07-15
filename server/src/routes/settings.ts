import { Hono } from "hono";
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
  deleteClaudeCodeSdkSettings,
  getClaudeCodeSdkSettings,
  getClaudeCodeSdkSettingsPublic,
  patchClaudeCodeSdkSettings,
  verifyClaudeCodeSdkSettings,
} from "../lib/claude-code-sdk-settings.js";
import { forceRefreshAllBackendCaches } from "../lib/agents/provider-cache-store.js";
import {
  buildPiAgentOAuthCallbackUrl,
  completePiAgentOAuthCallback,
  disconnectPiAgentOAuth,
  getPiAgentSettingsResponse,
  piAgentOAuthFailureHtml,
  piAgentOAuthSuccessHtml,
  providerLabelForId,
  startPiAgentOAuth,
} from "../lib/pi-agent-oauth.js";
import { upsertPiAgentProviderKey } from "../lib/pi-agent-settings.js";
import {
  deleteCesiumProviderKey,
  getCesiumAgentSettingsPublic,
  getCesiumModelCatalog,
  patchCesiumAgentSettings,
  refreshCesiumModelCatalog,
  upsertCesiumProviderKey,
  type CesiumProviderKind,
  type CesiumCustomProvider,
  type CesiumAgentSettings,
} from "../lib/cesium-agent-settings.js";
import {
  bumpRevision,
  formatEtag,
  getRevision,
  parseRevisionHeader,
} from "../storage/revisions.js";
import { ACTIVE_AGENT_BACKEND_IDS } from "../lib/active-agent-backends.js";
import type { AgentBackendId } from "../lib/agents/types.js";
import { measureServerPerf } from "../lib/perf.js";

export const settingsRoutes = new Hono();

const GLOBAL_SETTINGS_KEY = "settings:global";

const globalSettingsCoalescer = new WriteCoalescer<GlobalSettings>(
  async (_key, settings) => {
    await saveGlobalSettings(settings);
  },
  50
);

function allBackendIds(): AgentBackendId[] {
  return [...ACTIVE_AGENT_BACKEND_IDS];
}

function publicOriginFromRequest(c: {
  req: { url: string; header: (name: string) => string | undefined };
}): string {
  const forwardedProto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = c.req.header("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
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
  const onDisk = await getGlobalSettings();
  const onDiskByBackend = onDisk.models?.byBackend;
  if (onDiskByBackend && Object.keys(onDiskByBackend).length > 0) {
    // Model toggles have their own diff endpoint. Preserve the server's current
    // model state so a delayed full-settings save cannot overwrite newer toggle edits.
    toSave = {
      ...toSave,
      models: { byBackend: { ...onDiskByBackend } },
    };
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
  const toggleState = await measureServerPerf(
    "http.settings.modelsByBackend",
    () => getModelToggleState(allBackendIds())
  );
  const byBackend: Record<string, Array<{ id: string; name: string }>> = {};
  for (const [backendId, entries] of Object.entries(toggleState.byBackend)) {
    byBackend[backendId] = entries.map(({ id, name }) => ({ id, name }));
  }
  c.header("Cache-Control", "private, max-age=10, stale-while-revalidate=60, must-revalidate");
  return c.json({ byBackend });
});

settingsRoutes.get("/api/settings/models", async (c) => {
  const toggleState = await measureServerPerf(
    "http.settings.models",
    () => getModelToggleState(allBackendIds())
  );
  c.header("Cache-Control", "private, max-age=10, stale-while-revalidate=60, must-revalidate");
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
    const { Cursor } = await import("@cursor/sdk");
    const me = await Cursor.me({ apiKey });
    const status = await saveCursorSdkApiKey({
      apiKey,
      apiKeyName: me.apiKeyName,
      userEmail: me.userEmail,
    });
    await forceRefreshAllBackendCaches(["cursor-sdk"]);
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

settingsRoutes.get("/api/settings/claude-code-sdk", async (c) => {
  return c.json({ settings: await getClaudeCodeSdkSettingsPublic() });
});

settingsRoutes.put("/api/settings/claude-code-sdk", async (c) => {
  const body = await c.req.json<{
    baseUrl?: string | null;
    apiKey?: string | null;
    model?: string | null;
    pathToExecutable?: string | null;
  }>();

  try {
    const currentStored = await getClaudeCodeSdkSettings();
    const verifyBaseUrl =
      (body.baseUrl !== undefined ? body.baseUrl?.trim() : currentStored?.baseUrl) || undefined;
    const verifyApiKey = body.apiKey?.trim() || currentStored?.apiKey;
    const verifyModel =
      (body.model !== undefined ? body.model?.trim() : currentStored?.model) || undefined;
    const shouldVerify =
      Boolean(verifyBaseUrl && verifyApiKey) &&
      (body.apiKey?.trim() || body.baseUrl !== undefined);
    if (shouldVerify && verifyBaseUrl && verifyApiKey) {
      await verifyClaudeCodeSdkSettings({
        baseUrl: verifyBaseUrl,
        apiKey: verifyApiKey,
        model: verifyModel,
      });
    } else if (body.apiKey?.trim() && !verifyBaseUrl) {
      return c.json({ error: "Base URL is required when saving an API key." }, 400);
    }

    const settings = await patchClaudeCodeSdkSettings({
      ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
      ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.pathToExecutable !== undefined ? { pathToExecutable: body.pathToExecutable } : {}),
    });
    const refresh = await forceRefreshAllBackendCaches(["claude-code-sdk"]);
    return c.json({ ok: true, settings, refresh });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to save Claude Code SDK settings.";
    return c.json({ error: message }, 400);
  }
});

settingsRoutes.delete("/api/settings/claude-code-sdk", async (c) => {
  await deleteClaudeCodeSdkSettings();
  const refresh = await forceRefreshAllBackendCaches(["claude-code-sdk"]);
  return c.json({ ok: true, settings: await getClaudeCodeSdkSettingsPublic(), refresh });
});

settingsRoutes.get("/api/settings/pi-agent", async (c) => {
  return c.json(await getPiAgentSettingsResponse());
});

settingsRoutes.get("/api/settings/pi-agent/oauth/:providerId/start", async (c) => {
  const providerId = c.req.param("providerId");
  try {
    const origin = publicOriginFromRequest(c);
    const result = await startPiAgentOAuth({ providerId, publicOrigin: origin });
    return c.json({
      ...result,
      callbackUrl: result.callbackUrl ?? buildPiAgentOAuthCallbackUrl(origin),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to start Pi Agent OAuth.";
    return c.json({ error: message }, 400);
  }
});

settingsRoutes.get("/api/settings/pi-agent/oauth/callback", async (c) => {
  const redirect = c.req.query("redirect")?.trim();
  const code = c.req.query("code")?.trim();
  const state = c.req.query("state")?.trim();
  const providerId = c.req.query("providerId")?.trim();
  const error = c.req.query("error")?.trim();
  if (error) {
    return c.html(piAgentOAuthFailureHtml(error), 400);
  }
  if (!redirect && !code) {
    return c.html(piAgentOAuthFailureHtml("Missing redirect URL or authorization code."), 400);
  }
  try {
    const result = await completePiAgentOAuthCallback({
      ...(providerId ? { providerId } : {}),
      ...(redirect ? { redirect } : {}),
      ...(code ? { code } : {}),
      ...(state ? { state } : {}),
    });
    await forceRefreshAllBackendCaches(["pi-agent"]);
    return c.html(piAgentOAuthSuccessHtml(providerLabelForId(result.providerId)));
  } catch (callbackError) {
    const message =
      callbackError instanceof Error ? callbackError.message : "Pi Agent OAuth callback failed.";
    return c.html(piAgentOAuthFailureHtml(message), 400);
  }
});

settingsRoutes.delete("/api/settings/pi-agent/oauth/:providerId", async (c) => {
  try {
    const payload = await disconnectPiAgentOAuth(c.req.param("providerId"));
    const refresh = await forceRefreshAllBackendCaches(["pi-agent"]);
    return c.json({ ok: true, ...payload, refresh });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to disconnect Pi Agent provider.";
    return c.json({ error: message }, 400);
  }
});

settingsRoutes.put("/api/settings/pi-agent/provider-key", async (c) => {
  const body = await c.req.json<{
    id?: string;
    providerId?: string;
    label?: string;
    apiKey?: string;
  }>();
  if (!body.providerId?.trim() || !body.apiKey?.trim()) {
    return c.json({ error: "Expected providerId and apiKey." }, 400);
  }
  try {
    await upsertPiAgentProviderKey({
      id: body.id,
      providerId: body.providerId,
      label: body.label,
      apiKey: body.apiKey,
    });
    const payload = await getPiAgentSettingsResponse();
    const refresh = await forceRefreshAllBackendCaches(["pi-agent"]);
    return c.json({ ok: true, ...payload, refresh });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to save Pi Agent provider key.";
    return c.json({ error: message }, 400);
  }
});

function isCesiumProviderKind(value: unknown): value is CesiumProviderKind {
  return (
    value === "openai-chat-completions" ||
    value === "openai-responses" ||
    value === "openai-realtime" ||
    value === "anthropic" ||
    value === "google-genai" ||
    value === "openai-compatible"
  );
}

settingsRoutes.get("/api/settings/cesium-agent", async (c) => {
  return c.json({ settings: await getCesiumAgentSettingsPublic() });
});

settingsRoutes.patch("/api/settings/cesium-agent", async (c) => {
  const body = await c.req.json<{
    defaultProviderKeyId?: string | null;
    defaultModelId?: string;
    defaultApiKind?: unknown;
    compression?: Record<string, unknown>;
    orchestration?: Record<string, unknown>;
    toolPermissions?: Record<string, unknown>;
    customProviders?: CesiumCustomProvider[];
  }>();
  const settings = await patchCesiumAgentSettings({
    ...(body.defaultProviderKeyId !== undefined
      ? { defaultProviderKeyId: body.defaultProviderKeyId }
      : {}),
    ...(typeof body.defaultModelId === "string" ? { defaultModelId: body.defaultModelId } : {}),
    ...(isCesiumProviderKind(body.defaultApiKind) ? { defaultApiKind: body.defaultApiKind } : {}),
    ...(body.compression
      ? { compression: body.compression as Partial<CesiumAgentSettings["compression"]> }
      : {}),
    ...(body.orchestration
      ? { orchestration: body.orchestration as Partial<CesiumAgentSettings["orchestration"]> }
      : {}),
    ...(body.toolPermissions
      ? { toolPermissions: body.toolPermissions as Partial<CesiumAgentSettings["toolPermissions"]> }
      : {}),
    ...(Array.isArray(body.customProviders) ? { customProviders: body.customProviders } : {}),
  });
  return c.json({ ok: true, settings });
});

settingsRoutes.put("/api/settings/cesium-agent/provider-key", async (c) => {
  const body = await c.req.json<{
    id?: string;
    providerId?: string;
    label?: string;
    apiKind?: unknown;
    apiKey?: string;
    baseUrl?: string;
  }>();
  if (!body.providerId?.trim() || !body.apiKey?.trim() || !isCesiumProviderKind(body.apiKind)) {
    return c.json({ error: "Expected providerId, apiKind, and apiKey." }, 400);
  }
  const settings = await upsertCesiumProviderKey({
    id: body.id,
    providerId: body.providerId,
    label: body.label,
    apiKind: body.apiKind,
    apiKey: body.apiKey,
    baseUrl: body.baseUrl,
  });
  return c.json({ ok: true, settings });
});

settingsRoutes.delete("/api/settings/cesium-agent/provider-key/:id", async (c) => {
  const settings = await deleteCesiumProviderKey(c.req.param("id"));
  return c.json({ ok: true, settings });
});

settingsRoutes.get("/api/settings/cesium-agent/models", async (c) => {
  return c.json({ models: await getCesiumModelCatalog() });
});

settingsRoutes.post("/api/settings/cesium-agent/models/refresh", async (c) => {
  const models = await refreshCesiumModelCatalog();
  return c.json({ ok: true, models });
});

settingsRoutes.post("/api/settings/cesium-agent/providers/discover", async (c) => {
  const body = await c.req.json<{
    apiKind?: unknown;
    apiKey?: string;
    baseUrl?: string;
  }>();
  if (!isCesiumProviderKind(body.apiKind) || !body.apiKey?.trim() || !body.baseUrl?.trim()) {
    return c.json({ error: "Expected apiKind, apiKey, and baseUrl." }, 400);
  }
  const { discoverCesiumProviderModels } = await import("../lib/cesium-agent-settings.js");
  const models = await discoverCesiumProviderModels({
    apiKind: body.apiKind,
    apiKey: body.apiKey,
    baseUrl: body.baseUrl,
  });
  return c.json({ ok: true, models });
});

settingsRoutes.post("/api/settings/models/refresh", async (c) => {
  const result = await measureServerPerf(
    "http.settings.modelsRefresh",
    () => refreshAndGetModelToggleState(allBackendIds())
  );
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
  const result = await measureServerPerf(
    "http.settings.modelsToggles",
    () => setModelToggles(body.toggles!),
    { updates: body.toggles.length }
  );
  return c.json(result);
});
