/**
 * Settings surface: global settings (raw JSON with ETag revisions),
 * Cesium Agent settings (providers, keys, model catalog, harness prefs),
 * per-model toggles, and remembered permission rules. Only the browser
 * client talks to this engine, so the payloads match what `@cesium/client`
 * server-api expects.
 *
 * Contract with the settings UI: everything this surface advertises is
 * persisted and enforced by the in-page harness. Server-only capabilities
 * (subagent plugins, orchestration/goal/workflow modes, cloud agents) are
 * intentionally absent from the advertised catalogs instead of rendering as
 * dead controls.
 */
import type { CesiumModelCatalogEntry, CesiumProviderKind } from "@cesium/core";
import { mergeCesiumModelAccess } from "@cesium/core";
import { CESIUM_BACKEND_ID } from "@cesium/core";
import { errorResponse, jsonResponse, type EngineRouter } from "../http";
import { readDoc, writeDoc } from "../stores/kv-docs";
import type {
  BrowserAgentPrefs,
  BrowserModeId,
  BrowserToolPermissionDecision,
  ModelOrderUpdate,
  ModelToggleUpdate,
  SettingsStore,
  StoredProvider,
} from "../stores/settings";
import { BROWSER_MODE_DEFINITIONS, BROWSER_MODE_IDS } from "../stores/settings";

const REMEMBERED_PERMISSIONS_KEY = "settings:remembered-permissions";

type RememberedPermissionRule = {
  id: string;
  workspaceId?: string;
  backendId?: string;
  toolKey?: string;
  toolLabel?: string;
  category?: string;
  matchStyle?: string;
  createdAt: number;
};

function providerKeyStatus(provider: StoredProvider): Record<string, unknown> {
  return {
    id: provider.id,
    providerId: provider.id,
    label: provider.name,
    apiKind: provider.apiKind,
    baseUrl: provider.baseUrl,
    source: "stored",
    createdAt: 0,
    updatedAt: Date.now(),
    lastFour: provider.apiKey ? provider.apiKey.slice(-4) : undefined,
  };
}

function customProviderPayload(provider: StoredProvider): Record<string, unknown> {
  return {
    id: provider.id,
    name: provider.name,
    apiKind: provider.apiKind,
    baseUrl: provider.baseUrl,
    models: provider.models.map((model) => ({
      id: model.modelId,
      name: model.modelName,
      contextWindow: model.contextWindow,
      supportsTools: model.supportsTools,
      supportsReasoning: model.supportsReasoning,
      supportsImages: model.supportsImages,
    })),
  };
}

/** All six canonical mode ids; server-only ones stay pinned off in-browser. */
const ALL_MODE_IDS = ["agent", "plan", "orchestration", "goal", "workflow", "ask"] as const;

function modesEnabledPayload(prefs: BrowserAgentPrefs): Record<string, boolean> {
  const enabled: Record<string, boolean> = {};
  for (const modeId of ALL_MODE_IDS) {
    enabled[modeId] = BROWSER_MODE_IDS.includes(modeId as BrowserModeId)
      ? prefs.modes.enabled[modeId as BrowserModeId]
      : false;
  }
  return enabled;
}

async function buildCesiumAgentPayload(settings: SettingsStore): Promise<Record<string, unknown>> {
  const [stored, prefs, defaults] = await Promise.all([
    settings.getCesiumAgentSettings(),
    settings.getAgentPrefs(),
    settings.resolveDefaultModel(),
  ]);
  const keyedProviders = stored.providers.filter((provider) => Boolean(provider.apiKey));
  const defaultProviderKeyId =
    prefs.defaultProviderKeyId &&
    keyedProviders.some((provider) => provider.id === prefs.defaultProviderKeyId)
      ? prefs.defaultProviderKeyId
      : keyedProviders[0]?.id ?? null;
  const defaultProvider =
    keyedProviders.find((provider) => provider.id === defaultProviderKeyId) ?? stored.providers[0];
  return {
    schemaVersion: 1,
    updatedAt: Date.now(),
    configured: keyedProviders.length > 0,
    defaultProviderKeyId,
    defaultModelId: stored.defaultModelId ?? defaults.modelId,
    defaultApiKind: prefs.defaultApiKind ?? defaultProvider?.apiKind ?? "openai-chat-completions",
    compression: prefs.compression,
    titleGeneration: prefs.titleGeneration,
    orchestration: prefs.orchestration,
    modes: { enabled: modesEnabledPayload(prefs) },
    // Only modes the in-page harness implements are advertised; the UI never
    // renders toggles for orchestration/goal/workflow here.
    modeCatalog: BROWSER_MODE_DEFINITIONS,
    harness: {
      features: {
        subagents: { version: 1, enabled: false },
      },
      limits: prefs.limits,
    },
    // No in-page harness plugins yet, so the plugin list stays empty (the
    // browser machine never advertises plugins it cannot load).
    harnessCatalog: [],
    toolPermissions: prefs.toolPermissions,
    modelAccess: prefs.modelAccess,
    providerKeys: keyedProviders.map(providerKeyStatus),
    oauthProviders: [],
    customProviders: stored.providers.map(customProviderPayload),
    profiles: [],
    enabledProfiles: { code: true, work: true },
    defaultProfileId: "code",
    profileCatalog: [
      {
        id: "code",
        name: "Code",
        description: "Software engineering profile.",
        builtIn: true,
        prompt: { base: "code", customInstructions: "" },
        tools: { allowed: "all", mcpServers: "all" },
        permissionOverrides: {},
      },
      {
        id: "work",
        name: "Work",
        description: "General productivity profile.",
        builtIn: true,
        prompt: { base: "work", customInstructions: "" },
        tools: { allowed: "all", mcpServers: "all" },
        permissionOverrides: {},
      },
    ],
    profileToolGroups: [],
    profileLockedTools: ["read_file", "grep", "todo", "ask_question"],
  };
}

/** Default catalog models seeded when a key is saved without explicit models. */
function defaultModelsForProvider(input: {
  providerId: string;
  providerName: string;
  apiKind: CesiumProviderKind;
  baseUrl: string;
}): CesiumModelCatalogEntry[] {
  const make = (modelId: string, modelName: string, extras?: Partial<CesiumModelCatalogEntry>) =>
    ({
      providerId: input.providerId,
      providerName: input.providerName,
      modelId,
      modelName,
      apiKind: input.apiKind,
      supportsTools: true,
      supportsReasoning: true,
      supportsStructuredOutput: true,
      supportsImages: true,
      contextWindow: 200_000,
      ...extras,
    }) satisfies CesiumModelCatalogEntry;
  switch (input.providerId) {
    case "openai":
      return [make("gpt-5.1", "GPT-5.1"), make("gpt-5.1-mini", "GPT-5.1 Mini")];
    case "anthropic":
      return [make("claude-sonnet-4-5", "Claude Sonnet 4.5")];
    case "google":
      return [make("gemini-2.5-pro", "Gemini 2.5 Pro")];
    case "openrouter":
      return [make("openrouter/auto", "OpenRouter Auto")];
    case "techlit":
      return [make("kimi-k3", "Kimi K3", { contextWindow: 1_000_000 })];
    default:
      return [];
  }
}

type CesiumAgentPatch = {
  defaultModelId?: string;
  defaultProviderKeyId?: string | null;
  defaultApiKind?: CesiumProviderKind;
  compression?: Partial<BrowserAgentPrefs["compression"]>;
  titleGeneration?: Partial<BrowserAgentPrefs["titleGeneration"]>;
  orchestration?: Partial<BrowserAgentPrefs["orchestration"]>;
  modes?: { enabled?: Partial<Record<string, boolean>> };
  harness?: {
    features?: Record<string, { version?: number; enabled?: boolean; config?: unknown }>;
    limits?: Partial<BrowserAgentPrefs["limits"]>;
  };
  toolPermissions?: Partial<
    Record<keyof BrowserAgentPrefs["toolPermissions"], BrowserToolPermissionDecision>
  >;
  modelAccess?: {
    entries?: Record<string, { enabled?: boolean; description?: string | null } | null>;
  };
  customProviders?: Array<{
    id: string;
    name: string;
    apiKind: CesiumProviderKind;
    baseUrl?: string;
    models: Array<{
      id: string;
      name: string;
      contextWindow?: number;
      supportsTools?: boolean;
      supportsReasoning?: boolean;
      supportsImages?: boolean;
    }>;
  }>;
};

function isDecision(value: unknown): value is BrowserToolPermissionDecision {
  return value === "ask" || value === "allow" || value === "deny";
}

/** Merge a settings patch into stored prefs; throws on validation errors. */
export function mergeBrowserAgentPrefs(
  current: BrowserAgentPrefs,
  patch: CesiumAgentPatch
): BrowserAgentPrefs {
  const next: BrowserAgentPrefs = {
    ...current,
    compression: { ...current.compression },
    titleGeneration: { ...current.titleGeneration },
    orchestration: { ...current.orchestration },
    modes: { enabled: { ...current.modes.enabled } },
    toolPermissions: { ...current.toolPermissions },
    modelAccess: { entries: { ...current.modelAccess.entries } },
    limits: { ...current.limits },
  };
  if (patch.defaultProviderKeyId !== undefined) {
    next.defaultProviderKeyId = patch.defaultProviderKeyId?.trim() || null;
  }
  if (typeof patch.defaultApiKind === "string") {
    next.defaultApiKind = patch.defaultApiKind;
  }
  if (patch.compression) {
    if (typeof patch.compression.enabled === "boolean") {
      next.compression.enabled = patch.compression.enabled;
    }
    if (patch.compression.modelId !== undefined) {
      next.compression.modelId = patch.compression.modelId || null;
    }
    if (
      typeof patch.compression.thresholdRatio === "number" &&
      Number.isFinite(patch.compression.thresholdRatio)
    ) {
      next.compression.thresholdRatio = Math.min(
        Math.max(patch.compression.thresholdRatio, 0.1),
        1
      );
    }
  }
  if (patch.titleGeneration && patch.titleGeneration.modelId !== undefined) {
    next.titleGeneration.modelId = patch.titleGeneration.modelId || null;
  }
  if (patch.orchestration && typeof patch.orchestration.continueWhenIncomplete === "boolean") {
    next.orchestration.continueWhenIncomplete = patch.orchestration.continueWhenIncomplete;
  }
  if (patch.modes?.enabled) {
    for (const modeId of BROWSER_MODE_IDS) {
      const value = patch.modes.enabled[modeId];
      if (typeof value === "boolean") {
        next.modes.enabled[modeId] = value;
      }
    }
    if (!BROWSER_MODE_IDS.some((modeId) => next.modes.enabled[modeId])) {
      throw new Error("At least one Cesium mode must remain enabled.");
    }
  }
  if (patch.toolPermissions) {
    for (const key of ["editFile", "terminal", "mcpCall", "switchMode"] as const) {
      const value = patch.toolPermissions[key];
      if (isDecision(value)) {
        next.toolPermissions[key] = value;
      }
    }
  }
  if (patch.modelAccess) {
    // Shared merge semantics with the server: null deletes, long notes throw.
    next.modelAccess = mergeCesiumModelAccess(current.modelAccess, patch.modelAccess);
  }
  if (patch.harness?.limits) {
    for (const key of [
      "pluginHookTimeoutMs",
      "waitMaxSeconds",
      "waitAgentDefaultTimeoutMs",
      "waitAgentMinTimeoutMs",
      "waitAgentMaxTimeoutMs",
      "maxConcurrentSubagents",
    ] as const) {
      const value = patch.harness.limits[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        next.limits[key] = value;
      }
    }
  }
  return next;
}

export function registerSettingsRoutes(
  router: EngineRouter,
  deps: { settings: SettingsStore }
): void {
  const { settings } = deps;

  router.get("/api/settings/global", async () => {
    const [stored, revision] = await Promise.all([
      settings.getGlobalSettings(),
      settings.getGlobalSettingsRevision(),
    ]);
    return jsonResponse({ settings: stored, revision }, 200, {
      ETag: `W/"${revision}"`,
    });
  });

  router.put("/api/settings/global", async (request) => {
    const body = await request.json<{ settings?: Record<string, unknown> }>();
    if (!body.settings || typeof body.settings !== "object") {
      return errorResponse("Expected settings object");
    }
    await settings.putGlobalSettings(body.settings);
    const revision = await settings.bumpGlobalSettingsRevision();
    return jsonResponse({ ok: true, revision }, 200, {
      ETag: `W/"${revision}"`,
    });
  });

  router.get("/api/settings/remembered-permissions", async () => {
    const rules = (await readDoc<RememberedPermissionRule[]>(REMEMBERED_PERMISSIONS_KEY)) ?? [];
    return jsonResponse({ rememberedPermissions: rules });
  });

  router.delete("/api/settings/remembered-permissions/:id", async (request) => {
    const id = request.params.id ?? "";
    const rules = (await readDoc<RememberedPermissionRule[]>(REMEMBERED_PERMISSIONS_KEY)) ?? [];
    const next = rules.filter((rule) => rule.id !== id);
    await writeDoc(REMEMBERED_PERMISSIONS_KEY, next);
    return jsonResponse({ rememberedPermissions: next });
  });

  router.post("/api/settings/remembered-permissions/clear", async (request) => {
    const body = await request
      .json<{ backendId?: string }>()
      .catch(() => ({}) as { backendId?: string });
    const rules = (await readDoc<RememberedPermissionRule[]>(REMEMBERED_PERMISSIONS_KEY)) ?? [];
    const next = body.backendId ? rules.filter((rule) => rule.backendId !== body.backendId) : [];
    await writeDoc(REMEMBERED_PERMISSIONS_KEY, next);
    return jsonResponse({ rememberedPermissions: next });
  });

  router.get("/api/settings/cesium-agent", async () =>
    jsonResponse({ settings: await buildCesiumAgentPayload(settings) })
  );

  router.patch("/api/settings/cesium-agent", async (request) => {
    const patch = await request.json<CesiumAgentPatch>();
    const stored = await settings.getCesiumAgentSettings();
    if (typeof patch.defaultModelId === "string") {
      stored.defaultModelId = patch.defaultModelId;
    }
    if (Array.isArray(patch.customProviders)) {
      for (const custom of patch.customProviders) {
        const existing = stored.providers.find((provider) => provider.id === custom.id);
        const models: CesiumModelCatalogEntry[] = custom.models.map((model) => ({
          providerId: custom.id,
          providerName: custom.name,
          modelId: model.id,
          modelName: model.name,
          apiKind: custom.apiKind,
          supportsTools: model.supportsTools ?? true,
          supportsReasoning: model.supportsReasoning ?? false,
          supportsStructuredOutput: false,
          supportsImages: model.supportsImages ?? false,
          contextWindow: model.contextWindow,
        }));
        if (existing) {
          existing.name = custom.name;
          existing.apiKind = custom.apiKind;
          existing.baseUrl = custom.baseUrl ?? existing.baseUrl;
          existing.models = models;
        } else {
          stored.providers.push({
            id: custom.id,
            name: custom.name,
            apiKind: custom.apiKind,
            baseUrl: custom.baseUrl ?? "",
            models,
          });
        }
      }
    }
    let prefs: BrowserAgentPrefs;
    try {
      prefs = mergeBrowserAgentPrefs(await settings.getAgentPrefs(), patch);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : String(error), 400);
    }
    await Promise.all([
      settings.putCesiumAgentSettings(stored),
      settings.putAgentPrefs(prefs),
    ]);
    return jsonResponse({ ok: true, settings: await buildCesiumAgentPayload(settings) });
  });

  router.put("/api/settings/cesium-agent/provider-key", async (request) => {
    const body = await request.json<{
      id?: string;
      providerId: string;
      label?: string;
      apiKind: CesiumProviderKind;
      apiKey: string;
      baseUrl?: string;
    }>();
    if (!body.providerId?.trim() || !body.apiKey?.trim()) {
      return errorResponse("Expected providerId and apiKey");
    }
    const stored = await settings.getCesiumAgentSettings();
    const providerId = body.providerId.trim();
    const existing = stored.providers.find((provider) => provider.id === providerId);
    if (existing) {
      existing.apiKey = body.apiKey.trim();
      existing.apiKind = body.apiKind;
      if (body.baseUrl?.trim()) existing.baseUrl = body.baseUrl.trim();
      if (body.label?.trim()) existing.name = body.label.trim();
    } else {
      const name = body.label?.trim() || providerId;
      const baseUrl = body.baseUrl?.trim() || "";
      stored.providers.push({
        id: providerId,
        name,
        apiKind: body.apiKind,
        baseUrl,
        apiKey: body.apiKey.trim(),
        models: defaultModelsForProvider({
          providerId,
          providerName: name,
          apiKind: body.apiKind,
          baseUrl,
        }),
      });
    }
    await settings.putCesiumAgentSettings(stored);
    const prefs = await settings.getAgentPrefs();
    if (!prefs.defaultProviderKeyId) {
      await settings.putAgentPrefs({ ...prefs, defaultProviderKeyId: providerId });
    }
    return jsonResponse({ ok: true, settings: await buildCesiumAgentPayload(settings) });
  });

  router.delete("/api/settings/cesium-agent/provider-key/:id", async (request) => {
    const id = request.params.id ?? "";
    const stored = await settings.getCesiumAgentSettings();
    const provider = stored.providers.find((entry) => entry.id === id);
    if (provider) {
      delete provider.apiKey;
    }
    await settings.putCesiumAgentSettings(stored);
    const prefs = await settings.getAgentPrefs();
    if (prefs.defaultProviderKeyId === id) {
      const fallback = stored.providers.find((entry) => Boolean(entry.apiKey))?.id ?? null;
      await settings.putAgentPrefs({ ...prefs, defaultProviderKeyId: fallback });
    }
    return jsonResponse({ ok: true, settings: await buildCesiumAgentPayload(settings) });
  });

  router.get("/api/settings/cesium-agent/models", async () =>
    jsonResponse({ models: await settings.listModels() })
  );

  router.post("/api/settings/cesium-agent/models/refresh", async () =>
    jsonResponse({ ok: true, models: await settings.listModels() })
  );

  // Cross-backend model toggle surface. The browser machine mirrors the
  // server contract: toggles persist per backend + catalog model id, and
  // toggled-off models leave the composer picker on the next state sync.
  async function modelToggleState(): Promise<Record<string, unknown>> {
    const [models, toggles, order] = await Promise.all([
      settings.listModels(),
      settings.getModelToggles(),
      settings.getModelOrder(),
    ]);
    const entries = models.map((model) => {
      const id = `${model.providerId}/${model.modelId}`;
      return {
        id,
        name: model.modelName,
        on: settings.isModelToggledOn(toggles, CESIUM_BACKEND_ID, id),
        backendId: CESIUM_BACKEND_ID,
      };
    });
    return {
      byBackend: {
        [CESIUM_BACKEND_ID]: settings.orderModelEntries(
          CESIUM_BACKEND_ID,
          entries,
          order
        ),
      },
    };
  }

  async function applyModelToggleRequest(body: {
    toggles?: ModelToggleUpdate[];
    orders?: ModelOrderUpdate[];
  }): Promise<Response> {
    const toggles = Array.isArray(body.toggles) ? body.toggles : [];
    const orders = Array.isArray(body.orders) ? body.orders : [];
    if (toggles.length === 0 && orders.length === 0) {
      return errorResponse("Expected toggles or orders array");
    }
    if (toggles.length > 0) {
      await settings.applyModelToggles(toggles);
    }
    if (orders.length > 0) {
      await settings.applyModelOrders(orders);
    }
    return jsonResponse(await modelToggleState());
  }

  router.get("/api/settings/models", async () => jsonResponse(await modelToggleState()));
  router.get("/api/settings/models-by-backend", async () => {
    const models = await settings.listModels();
    return jsonResponse({
      byBackend: {
        [CESIUM_BACKEND_ID]: models.map((model) => ({
          id: `${model.providerId}/${model.modelId}`,
          name: model.modelName,
        })),
      },
    });
  });
  router.post("/api/settings/models/refresh", async () =>
    jsonResponse({ ...(await modelToggleState()), timedOut: [], failed: [] })
  );
  // The client saves with PUT (server parity); POST stays as a compatibility
  // alias for older clients that reached this engine.
  router.put("/api/settings/models/toggles", async (request) =>
    applyModelToggleRequest(
      await request.json<{ toggles?: ModelToggleUpdate[]; orders?: ModelOrderUpdate[] }>()
    )
  );
  router.post("/api/settings/models/toggles", async (request) =>
    applyModelToggleRequest(
      await request
        .json<{ toggles?: ModelToggleUpdate[]; orders?: ModelOrderUpdate[] }>()
        .catch(() => ({}) as { toggles?: ModelToggleUpdate[]; orders?: ModelOrderUpdate[] })
    )
  );

  // Cloud Agents are a real-server feature; expose a disabled stub so the
  // settings surface renders instead of erroring.
  router.get("/api/cloud-agents/settings", async () =>
    jsonResponse({
      settings: {
        schemaVersion: 1,
        updatedAt: Date.now(),
        defaults: {
          backendId: CESIUM_BACKEND_ID,
          modelId: null,
          executionMode: "queue",
          autoDispatch: false,
          workspaceId: null,
        },
        routingRules: [],
        connections: [],
        oauthApps: [],
      },
      endpoints: { oauthCallbackUrl: "", webhooks: {} },
    })
  );
  router.get("/api/cloud-agents/tasks", async () => jsonResponse({ tasks: [] }));

  router.post("/api/settings/cesium-agent/providers/discover", async (request) => {
    const body = await request.json<{
      apiKind: CesiumProviderKind;
      apiKey: string;
      baseUrl: string;
    }>();
    if (!body.baseUrl?.trim()) {
      return errorResponse("Expected baseUrl");
    }
    try {
      const response = await fetch(`${body.baseUrl.replace(/\/+$/, "")}/models`, {
        headers: body.apiKey ? { authorization: `Bearer ${body.apiKey}` } : undefined,
      });
      if (!response.ok) {
        return errorResponse(`Model discovery failed (${response.status})`);
      }
      const payload = (await response.json()) as {
        data?: Array<{ id?: string; name?: string; context_length?: number }>;
      };
      const models = (payload.data ?? [])
        .filter((entry) => typeof entry.id === "string")
        .map((entry) => ({
          id: entry.id as string,
          name: entry.name ?? (entry.id as string),
          contextWindow: entry.context_length,
        }));
      return jsonResponse({ ok: true, models });
    } catch (error) {
      return errorResponse(
        error instanceof Error
          ? `Model discovery failed: ${error.message} (the provider may not allow browser requests)`
          : "Model discovery failed."
      );
    }
  });
}
