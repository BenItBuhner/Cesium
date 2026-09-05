import { Hono } from "hono";
import {
  getGlobalSettings,
  getModelToggleState,
  setModelToggles,
  refreshAndGetModelToggleState,
  removeRememberedAgentPermissionRule,
  clearRememberedAgentPermissionRules,
  replaceRememberedAgentPermissionRules,
  saveGlobalSettingsPreservingRememberedPermissions,
  type GlobalSettings,
  type ModelOrderUpdate,
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
import { resolveOAuthPublicOrigin } from "../lib/oauth/public-origin.js";
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
  CESIUM_MODEL_DESCRIPTION_MAX_LENGTH,
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
  disconnectCesiumOAuth,
  invalidateCesiumOAuthCache,
  startCesiumOAuth,
} from "../lib/cesium-oauth.js";
import {
  cancelGrokBuildDeviceLogin,
  getGrokBuildLoginState,
  isGrokCliInstalled,
  startGrokBuildDeviceLogin,
} from "../lib/grok-build-login.js";
import {
  cancelHarnessCliLogin,
  isHarnessCliAuthBackendId,
  refreshHarnessCliAuthState,
  relayHarnessCliOAuthCallback,
  startHarnessCliLogin,
  startHarnessCliLogout,
} from "../lib/harness-cli-auth.js";
import {
  exportHarnessAuthSnapshotForSync,
  importHarnessAuthSnapshotForSync,
  isHarnessAuthSyncId,
  listHarnessAuthSyncStates,
} from "../lib/harness-auth-sync.js";
import {
  bumpRevision,
  formatEtag,
  getRevision,
  parseRevisionHeader,
} from "../storage/revisions.js";
import {
  ACTIVE_AGENT_BACKEND_IDS,
  isActiveAgentBackendId,
} from "../lib/active-agent-backends.js";
import type { AgentBackendId } from "../lib/agents/types.js";
import { measureServerPerf } from "../lib/perf.js";
import {
  deleteVoiceSpeechSettings,
  patchVoiceSpeechSettings,
  type VoiceSpeechSettingsPatch,
} from "../lib/voice-speech-settings.js";
import { getVoiceSpeechSettingsPublic } from "../lib/voice-speech-resolve.js";

export const settingsRoutes = new Hono();

const GLOBAL_SETTINGS_KEY = "settings:global";

const globalSettingsCoalescer = new WriteCoalescer<GlobalSettings>(
  async (_key, settings) => {
    // Preserve remembered permissions at flush time: an agent may have saved a
    // rule inside the debounce window, after the route captured `settings`.
    await saveGlobalSettingsPreservingRememberedPermissions(settings);
  },
  50
);

function allBackendIds(): AgentBackendId[] {
  return [...ACTIVE_AGENT_BACKEND_IDS];
}

function publicOriginFromRequest(c: {
  req: { url: string; header: (name: string) => string | undefined };
}): string {
  return resolveOAuthPublicOrigin(c.req);
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

  // Remembered always-allow / always-reject rules are written by agent sessions
  // independently of the settings UI (same class of bug as model toggles). The
  // on-disk list is re-applied at write time (inside the mutation chain) by
  // saveGlobalSettingsPreservingRememberedPermissions; dedicated
  // remembered-permission routes own mutations.
  if (process.env.NODE_ENV === "test") {
    await saveGlobalSettingsPreservingRememberedPermissions(toSave);
  } else {
    globalSettingsCoalescer.schedule("global", toSave);
  }

  const nextRevision = bumpRevision(GLOBAL_SETTINGS_KEY);
  c.header("ETag", formatEtag(nextRevision));
  return c.json({ ok: true, revision: nextRevision });
});

settingsRoutes.delete("/api/settings/remembered-permissions/:id", async (c) => {
  const id = c.req.param("id")?.trim();
  if (!id) {
    return c.json({ error: "Expected remembered permission id." }, 400);
  }
  const rememberedPermissions = await removeRememberedAgentPermissionRule(id);
  const nextRevision = getRevision(GLOBAL_SETTINGS_KEY);
  c.header("ETag", formatEtag(nextRevision));
  return c.json({ rememberedPermissions, revision: nextRevision });
});

settingsRoutes.post("/api/settings/remembered-permissions/clear", async (c) => {
  const body = await c.req.json<{ backendId?: string }>().catch(() => ({} as { backendId?: string }));
  const backendId =
    typeof body.backendId === "string" && body.backendId.trim()
      ? body.backendId.trim()
      : undefined;
  if (backendId && !isActiveAgentBackendId(backendId)) {
    return c.json({ error: `Unknown backendId: ${backendId}` }, 400);
  }
  const rememberedPermissions = await clearRememberedAgentPermissionRules(
    backendId ? { backendId } : undefined
  );
  const nextRevision = getRevision(GLOBAL_SETTINGS_KEY);
  c.header("ETag", formatEtag(nextRevision));
  return c.json({ rememberedPermissions, revision: nextRevision });
});

settingsRoutes.put("/api/settings/remembered-permissions", async (c) => {
  const body = await c.req.json<{ rememberedPermissions?: unknown }>();
  if (!Array.isArray(body.rememberedPermissions)) {
    return c.json({ error: "Expected rememberedPermissions array." }, 400);
  }
  const rememberedPermissions = await replaceRememberedAgentPermissionRules(
    body.rememberedPermissions as Parameters<typeof replaceRememberedAgentPermissionRules>[0]
  );
  const nextRevision = getRevision(GLOBAL_SETTINGS_KEY);
  c.header("ETag", formatEtag(nextRevision));
  return c.json({ rememberedPermissions, revision: nextRevision });
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

settingsRoutes.get("/api/settings/voice", async (c) => {
  return c.json({ settings: await getVoiceSpeechSettingsPublic() });
});

settingsRoutes.put("/api/settings/voice", async (c) => {
  const body = await c.req.json<VoiceSpeechSettingsPatch>().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Expected voice settings payload." }, 400);
  }
  try {
    await patchVoiceSpeechSettings({
      ...(body.transcription ? { transcription: body.transcription } : {}),
      ...(body.titleGeneration ? { titleGeneration: body.titleGeneration } : {}),
      ...(body.tts ? { tts: body.tts } : {}),
      ...(body.controller ? { controller: body.controller } : {}),
    });
    return c.json({ ok: true, settings: await getVoiceSpeechSettingsPublic() });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to save voice settings.";
    return c.json({ error: message }, 400);
  }
});

settingsRoutes.delete("/api/settings/voice", async (c) => {
  await deleteVoiceSpeechSettings();
  return c.json({ ok: true, settings: await getVoiceSpeechSettingsPublic() });
});

settingsRoutes.get("/api/settings/pi-agent", async (c) => {
  return c.json(await getPiAgentSettingsResponse());
});

settingsRoutes.put("/api/settings/pi-agent", async (c) => {
  const body = await c.req.json<{
    agentHome?: "native" | "isolated";
  }>();
  if (body.agentHome !== "native" && body.agentHome !== "isolated") {
    return c.json({ error: "Expected agentHome to be \"native\" or \"isolated\"." }, 400);
  }
  try {
    const { setPiAgentHome } = await import("../lib/pi-agent-settings.js");
    await setPiAgentHome(body.agentHome);
    const payload = await getPiAgentSettingsResponse();
    const refresh = await forceRefreshAllBackendCaches(["pi-agent"]);
    return c.json({ ok: true, ...payload, refresh });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to update Pi Agent settings.";
    return c.json({ error: message }, 400);
  }
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
    // The Cesium harness reads the same auth.json; surface the new connection
    // (provider status + OAuth model catalog rows) without waiting for the TTL.
    invalidateCesiumOAuthCache();
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
    titleGeneration?: { modelId?: string | null };
    orchestration?: Record<string, unknown>;
    modes?: { enabled?: Record<string, boolean> };
    harness?: {
      features?: Record<
        string,
        {
          version?: number | string;
          enabled?: boolean;
          config?: Record<string, unknown>;
        }
      >;
      limits?: Record<string, unknown>;
    };
    toolPermissions?: Record<string, unknown>;
    modelAccess?: {
      entries?: Record<
        string,
        { enabled?: boolean; description?: string | null } | null
      >;
    };
    customProviders?: CesiumCustomProvider[];
    profiles?: unknown[];
    enabledProfiles?: Record<string, boolean>;
    defaultProfileId?: string;
  }>();
  for (const [modelId, entry] of Object.entries(body.modelAccess?.entries ?? {})) {
    const description = entry?.description;
    if (
      typeof description === "string" &&
      description.trim().length > CESIUM_MODEL_DESCRIPTION_MAX_LENGTH
    ) {
      return c.json(
        {
          error: `Model description for ${modelId} must be at most ${CESIUM_MODEL_DESCRIPTION_MAX_LENGTH} characters.`,
        },
        400
      );
    }
  }
  const settings = await patchCesiumAgentSettings({
    ...(body.defaultProviderKeyId !== undefined
      ? { defaultProviderKeyId: body.defaultProviderKeyId }
      : {}),
    ...(typeof body.defaultModelId === "string" ? { defaultModelId: body.defaultModelId } : {}),
    ...(isCesiumProviderKind(body.defaultApiKind) ? { defaultApiKind: body.defaultApiKind } : {}),
    ...(body.compression
      ? { compression: body.compression as Partial<CesiumAgentSettings["compression"]> }
      : {}),
    ...(body.titleGeneration
      ? {
          titleGeneration: {
            ...(body.titleGeneration.modelId !== undefined
              ? {
                  modelId:
                    typeof body.titleGeneration.modelId === "string" &&
                    body.titleGeneration.modelId.trim()
                      ? body.titleGeneration.modelId.trim()
                      : null,
                }
              : {}),
          },
        }
      : {}),
    ...(body.orchestration
      ? { orchestration: body.orchestration as Partial<CesiumAgentSettings["orchestration"]> }
      : {}),
    ...(body.modes
      ? {
          modes: body.modes as {
            enabled?: Partial<CesiumAgentSettings["modes"]["enabled"]>;
          },
        }
      : {}),
    ...(body.harness
      ? {
          harness: body.harness as {
            features?: Record<
              string,
              {
                version?: number | string;
                enabled?: boolean;
                config?: Record<string, unknown>;
              }
            >;
            limits?: Partial<CesiumAgentSettings["harness"]["limits"]>;
          },
        }
      : {}),
    ...(body.toolPermissions
      ? { toolPermissions: body.toolPermissions as Partial<CesiumAgentSettings["toolPermissions"]> }
      : {}),
    ...(body.modelAccess ? { modelAccess: body.modelAccess } : {}),
    ...(Array.isArray(body.customProviders) ? { customProviders: body.customProviders } : {}),
    ...(Array.isArray(body.profiles)
      ? {
          profiles: body.profiles as Parameters<
            typeof patchCesiumAgentSettings
          >[0]["profiles"],
        }
      : {}),
    ...(body.enabledProfiles && typeof body.enabledProfiles === "object"
      ? { enabledProfiles: body.enabledProfiles }
      : {}),
    ...(typeof body.defaultProfileId === "string"
      ? { defaultProfileId: body.defaultProfileId }
      : {}),
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

settingsRoutes.get("/api/settings/cesium-agent/oauth/:providerId/start", async (c) => {
  const providerId = c.req.param("providerId");
  try {
    const origin = publicOriginFromRequest(c);
    // Shares the Pi OAuth flow and callback endpoint; the credential lands in
    // the shared auth.json that resolveCesiumOAuthRequestAuth reads.
    const result = await startCesiumOAuth({ providerId, publicOrigin: origin });
    return c.json({
      ...result,
      callbackUrl: result.callbackUrl ?? buildPiAgentOAuthCallbackUrl(origin),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to start Cesium OAuth.";
    return c.json({ error: message }, 400);
  }
});

settingsRoutes.delete("/api/settings/cesium-agent/oauth/:providerId", async (c) => {
  try {
    await disconnectCesiumOAuth(c.req.param("providerId"));
    await forceRefreshAllBackendCaches(["pi-agent"]);
    return c.json({ ok: true, settings: await getCesiumAgentSettingsPublic() });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to disconnect OAuth provider.";
    return c.json({ error: message }, 400);
  }
});

settingsRoutes.get("/api/settings/grok-build/login", async (c) => {
  return c.json({
    installed: isGrokCliInstalled(),
    login: getGrokBuildLoginState(),
  });
});

settingsRoutes.post("/api/settings/grok-build/login/start", async (c) => {
  const login = await startGrokBuildDeviceLogin();
  return c.json({ installed: isGrokCliInstalled(), login });
});

settingsRoutes.post("/api/settings/grok-build/login/cancel", async (c) => {
  return c.json({
    installed: isGrokCliInstalled(),
    login: cancelGrokBuildDeviceLogin(),
  });
});

settingsRoutes.get("/api/settings/harness-auth/:backendId", async (c) => {
  const backendId = c.req.param("backendId");
  if (!isHarnessCliAuthBackendId(backendId)) {
    return c.json({ error: "This harness does not use host CLI authentication." }, 404);
  }
  return c.json(await refreshHarnessCliAuthState(backendId));
});

settingsRoutes.post("/api/settings/harness-auth/:backendId/login", async (c) => {
  const backendId = c.req.param("backendId");
  if (!isHarnessCliAuthBackendId(backendId)) {
    return c.json({ error: "This harness does not use host CLI authentication." }, 404);
  }
  // Optional body for ACP-driven auth: which `authenticate` method to use and
  // enterprise GCP coordinates. CLI-driven harnesses ignore it.
  let options: { methodId?: string | null; gcpProject?: string | null; gcpLocation?: string | null } = {};
  try {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (body && typeof body === "object") {
      options = {
        methodId: typeof body.methodId === "string" ? body.methodId : null,
        gcpProject: typeof body.gcpProject === "string" ? body.gcpProject : null,
        gcpLocation: typeof body.gcpLocation === "string" ? body.gcpLocation : null,
      };
    }
  } catch {
    options = {};
  }
  return c.json(await startHarnessCliLogin(backendId, options));
});

/**
 * Remote-browser fallback for ACP-driven Google OAuth: the user pastes the
 * `http://127.0.0.1:<port>/?code=...` URL their browser could not reach and
 * the engine replays it against the ACP server's loopback listener locally.
 */
settingsRoutes.post("/api/settings/harness-auth/:backendId/oauth-callback", async (c) => {
  const backendId = c.req.param("backendId");
  if (!isHarnessCliAuthBackendId(backendId)) {
    return c.json({ error: "This harness does not use host CLI authentication." }, 404);
  }
  const body = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (!url) {
    return c.json({ error: "Provide the redirected callback URL as `url`." }, 400);
  }
  try {
    return c.json(await relayHarnessCliOAuthCallback(backendId, url));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

settingsRoutes.post("/api/settings/harness-auth/:backendId/logout", async (c) => {
  const backendId = c.req.param("backendId");
  if (!isHarnessCliAuthBackendId(backendId)) {
    return c.json({ error: "This harness does not use host CLI authentication." }, 404);
  }
  return c.json(await startHarnessCliLogout(backendId));
});

settingsRoutes.post("/api/settings/harness-auth/:backendId/cancel", async (c) => {
  const backendId = c.req.param("backendId");
  if (!isHarnessCliAuthBackendId(backendId)) {
    return c.json({ error: "This harness does not use host CLI authentication." }, 404);
  }
  return c.json(cancelHarnessCliLogin(backendId));
});

/* ---------------------------------------------------------------------- */
/* Harness auth sync: move harness sign-ins between this engine and the    */
/* account's encrypted secret vault. Export/import move plaintext only     */
/* over the authenticated engine channel; sealing (AES-256-GCM envelopes)  */
/* happens client-side before anything reaches cloud storage.              */
/* ---------------------------------------------------------------------- */

settingsRoutes.get("/api/settings/harness-auth-sync", async (c) => {
  return c.json({ harnesses: await listHarnessAuthSyncStates() });
});

settingsRoutes.get("/api/settings/harness-auth-sync/:syncId/export", async (c) => {
  const syncId = c.req.param("syncId");
  if (!isHarnessAuthSyncId(syncId)) {
    return c.json({ error: "Unknown harness auth sync id." }, 404);
  }
  try {
    const snapshot = await exportHarnessAuthSnapshotForSync(syncId);
    return c.json({ snapshot });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to export harness credentials.";
    return c.json({ error: message }, 400);
  }
});

settingsRoutes.post("/api/settings/harness-auth-sync/:syncId/import", async (c) => {
  const syncId = c.req.param("syncId");
  if (!isHarnessAuthSyncId(syncId)) {
    return c.json({ error: "Unknown harness auth sync id." }, 404);
  }
  try {
    const body = await c.req.json<{ snapshot?: unknown }>();
    const result = await importHarnessAuthSnapshotForSync(syncId, body?.snapshot);
    return c.json({ ok: true, ...result });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to import harness credentials.";
    return c.json({ error: message }, 400);
  }
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
  const body = await c.req.json<{
    toggles?: ModelToggleUpdate[];
    orders?: ModelOrderUpdate[];
  }>();
  const toggles = Array.isArray(body.toggles) ? body.toggles : [];
  const orders = Array.isArray(body.orders) ? body.orders : [];
  if (toggles.length === 0 && orders.length === 0) {
    return c.json({ error: "Expected toggles or orders array" }, 400);
  }
  const result = await measureServerPerf(
    "http.settings.modelsToggles",
    () => setModelToggles(toggles, orders),
    { updates: toggles.length, orders: orders.length }
  );
  return c.json(result);
});
