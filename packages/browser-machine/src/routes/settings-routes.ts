/**
 * Settings surface: global settings (raw JSON with ETag revisions),
 * Cesium Agent settings (providers, keys, model catalog), and remembered
 * permission rules. Only the browser client talks to this engine, so the
 * payloads match what `@cesium/client` server-api expects.
 */
import type { CesiumModelCatalogEntry, CesiumProviderKind } from "@cesium/core";
import { errorResponse, jsonResponse, type EngineRouter } from "../http";
import { readDoc, writeDoc } from "../stores/kv-docs";
import type { SettingsStore, StoredProvider } from "../stores/settings";

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

let globalSettingsRevision = 1;

const MODE_CATALOG = [
  { id: "agent", label: "Agent", description: "Full agentic coding with tools." },
  { id: "plan", label: "Plan", description: "Read-only research and planning." },
  { id: "orchestration", label: "Orchestration", description: "Kanban multi-agent orchestration." },
  { id: "goal", label: "Goal", description: "Long-running goal tracking." },
  { id: "workflow", label: "Workflow", description: "Deterministic workflow runs." },
  { id: "ask", label: "Ask", description: "Q&A without edits." },
] as const;

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

async function buildCesiumAgentPayload(settings: SettingsStore): Promise<Record<string, unknown>> {
  const stored = await settings.getCesiumAgentSettings();
  const defaults = await settings.resolveDefaultModel();
  return {
    schemaVersion: 1,
    updatedAt: Date.now(),
    configured: stored.providers.some((provider) => Boolean(provider.apiKey)),
    defaultProviderKeyId: stored.providers[0]?.id ?? null,
    defaultModelId: stored.defaultModelId ?? defaults.modelId,
    defaultApiKind: stored.providers[0]?.apiKind ?? "openai-chat-completions",
    compression: { enabled: false, modelId: null, thresholdRatio: 0.8 },
    titleGeneration: { modelId: null },
    orchestration: { continueWhenIncomplete: false },
    modes: {
      enabled: {
        agent: true,
        plan: true,
        orchestration: false,
        goal: false,
        workflow: false,
        ask: true,
      },
    },
    modeCatalog: MODE_CATALOG,
    harness: {
      features: {
        subagents: { version: 1, enabled: false },
      },
      limits: {
        pluginHookTimeoutMs: 10_000,
        waitMaxSeconds: 300,
        waitAgentDefaultTimeoutMs: 60_000,
        waitAgentMinTimeoutMs: 1_000,
        waitAgentMaxTimeoutMs: 600_000,
        maxConcurrentSubagents: 1,
      },
    },
    harnessCatalog: [],
    toolPermissions: {
      editFile: "ask",
      terminal: "ask",
      mcpCall: "ask",
      switchMode: "ask",
    },
    modelAccess: { entries: {} },
    providerKeys: stored.providers.filter((p) => p.apiKey).map(providerKeyStatus),
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

export function registerSettingsRoutes(
  router: EngineRouter,
  deps: { settings: SettingsStore }
): void {
  const { settings } = deps;

  router.get("/api/settings/global", async () => {
    const stored = await settings.getGlobalSettings();
    return jsonResponse({ settings: stored, revision: globalSettingsRevision }, 200, {
      ETag: `W/"${globalSettingsRevision}"`,
    });
  });

  router.put("/api/settings/global", async (request) => {
    const body = await request.json<{ settings?: Record<string, unknown> }>();
    if (!body.settings || typeof body.settings !== "object") {
      return errorResponse("Expected settings object");
    }
    await settings.putGlobalSettings(body.settings);
    globalSettingsRevision += 1;
    return jsonResponse({ ok: true, revision: globalSettingsRevision }, 200, {
      ETag: `W/"${globalSettingsRevision}"`,
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
    const patch = await request.json<{
      defaultModelId?: string;
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
    }>();
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
    await settings.putCesiumAgentSettings(stored);
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
    return jsonResponse({ ok: true, settings: await buildCesiumAgentPayload(settings) });
  });

  router.get("/api/settings/cesium-agent/models", async () =>
    jsonResponse({ models: await settings.listModels() })
  );

  router.post("/api/settings/cesium-agent/models/refresh", async () =>
    jsonResponse({ ok: true, models: await settings.listModels() })
  );

  // Cross-backend model toggle surface: the browser machine has exactly one
  // backend, so mirror the cesium-agent catalog with everything enabled.
  async function modelToggleState(): Promise<Record<string, unknown>> {
    const models = await settings.listModels();
    return {
      byBackend: {
        "cesium-agent": models.map((model) => ({
          id: `${model.providerId}/${model.modelId}`,
          name: model.modelName,
          on: true,
          backendId: "cesium-agent",
        })),
      },
    };
  }

  router.get("/api/settings/models", async () => jsonResponse(await modelToggleState()));
  router.get("/api/settings/models-by-backend", async () => {
    const models = await settings.listModels();
    return jsonResponse({
      byBackend: {
        "cesium-agent": models.map((model) => ({
          id: `${model.providerId}/${model.modelId}`,
          name: model.modelName,
        })),
      },
    });
  });
  router.post("/api/settings/models/refresh", async () =>
    jsonResponse({ ...(await modelToggleState()), timedOut: [], failed: [] })
  );
  router.post("/api/settings/models/toggles", async () =>
    jsonResponse(await modelToggleState())
  );

  // Cloud Agents are a real-server feature; expose a disabled stub so the
  // settings surface renders instead of erroring.
  router.get("/api/cloud-agents/settings", async () =>
    jsonResponse({
      settings: {
        schemaVersion: 1,
        updatedAt: Date.now(),
        defaults: {
          backendId: "cesium-agent",
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
