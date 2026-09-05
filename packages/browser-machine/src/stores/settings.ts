/**
 * Global + Cesium Agent settings persisted in IndexedDB. The Cesium Agent
 * settings mirror the engine's `cesium-agent-settings.json`: an OpenAI-style
 * provider list with API keys, a model catalog, and a default model id -
 * plus the user-tunable harness preferences (modes, tool permissions, model
 * access, limits) that the Settings UI patches. Everything the settings
 * surface advertises persists here and is enforced by the in-page harness;
 * anything the browser machine cannot execute is simply not advertised.
 * API keys never leave the browser (they are stored locally and used for
 * direct provider calls from the page).
 */
import type {
  CesiumModelAccessSettings,
  CesiumModelCatalogEntry,
  CesiumProviderKind,
} from "@cesium/core";
import {
  CESIUM_DEFAULT_MODEL_ID,
  CESIUM_DEFAULT_MODEL_NAME,
  isCesiumModelEnabled,
  normalizeCesiumModelAccess,
} from "@cesium/core";
import { readDoc, writeDoc } from "./kv-docs";

const GLOBAL_SETTINGS_KEY = "settings:global";
const GLOBAL_SETTINGS_REVISION_KEY = "settings:global-revision";
const CESIUM_AGENT_SETTINGS_KEY = "settings:cesium-agent";
const AGENT_PREFS_KEY = "settings:cesium-agent-prefs";
const MODEL_TOGGLES_KEY = "settings:model-toggles";
const MODEL_ORDER_KEY = "settings:model-order";

export type StoredProvider = {
  id: string;
  name: string;
  baseUrl: string;
  apiKind: CesiumProviderKind;
  apiKey?: string;
  models: CesiumModelCatalogEntry[];
};

export type CesiumAgentStoredSettings = {
  defaultModelId: string | null;
  providers: StoredProvider[];
};

/** Modes the in-page harness genuinely implements. */
export type BrowserModeId = "agent" | "plan" | "ask";

export type BrowserModeDefinition = {
  id: BrowserModeId;
  label: string;
  description: string;
};

/**
 * Advertised mode catalog. Server-only modes (orchestration, goal, workflow)
 * are intentionally absent: the browser machine never advertises settings it
 * cannot execute.
 */
export const BROWSER_MODE_DEFINITIONS: readonly BrowserModeDefinition[] = [
  {
    id: "agent",
    label: "Agent",
    description: "Build, edit, run commands, and complete implementation work.",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Research and draft a reviewable implementation plan before building.",
  },
  {
    id: "ask",
    label: "Ask",
    description: "Read-only Q&A mode for inspecting the workspace without side effects.",
  },
] as const;

export const BROWSER_MODE_IDS: readonly BrowserModeId[] = BROWSER_MODE_DEFINITIONS.map(
  (mode) => mode.id
);

export type BrowserToolPermissionDecision = "ask" | "allow" | "deny";

export type BrowserToolPermissions = {
  editFile: BrowserToolPermissionDecision;
  terminal: BrowserToolPermissionDecision;
  mcpCall: BrowserToolPermissionDecision;
  switchMode: BrowserToolPermissionDecision;
};

export type BrowserHarnessLimits = {
  pluginHookTimeoutMs: number;
  waitMaxSeconds: number;
  waitAgentDefaultTimeoutMs: number;
  waitAgentMinTimeoutMs: number;
  waitAgentMaxTimeoutMs: number;
  maxConcurrentSubagents: number;
};

/** Harness preferences the Settings UI can patch; persisted + enforced in-page. */
export type BrowserAgentPrefs = {
  defaultProviderKeyId: string | null;
  defaultApiKind: CesiumProviderKind | null;
  compression: { enabled: boolean; modelId: string | null; thresholdRatio: number };
  titleGeneration: { modelId: string | null };
  orchestration: { continueWhenIncomplete: boolean };
  modes: { enabled: Record<BrowserModeId, boolean> };
  toolPermissions: BrowserToolPermissions;
  modelAccess: CesiumModelAccessSettings;
  limits: BrowserHarnessLimits;
};

export const DEFAULT_BROWSER_HARNESS_LIMITS: BrowserHarnessLimits = {
  pluginHookTimeoutMs: 10_000,
  waitMaxSeconds: 300,
  waitAgentDefaultTimeoutMs: 60_000,
  waitAgentMinTimeoutMs: 1_000,
  waitAgentMaxTimeoutMs: 600_000,
  maxConcurrentSubagents: 1,
};

export function defaultBrowserAgentPrefs(): BrowserAgentPrefs {
  return {
    defaultProviderKeyId: null,
    defaultApiKind: null,
    compression: { enabled: false, modelId: null, thresholdRatio: 0.8 },
    titleGeneration: { modelId: null },
    orchestration: { continueWhenIncomplete: false },
    modes: { enabled: { agent: true, plan: true, ask: true } },
    toolPermissions: {
      editFile: "ask",
      terminal: "ask",
      mcpCall: "ask",
      switchMode: "ask",
    },
    modelAccess: { entries: {} },
    limits: { ...DEFAULT_BROWSER_HARNESS_LIMITS },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asDecision(
  value: unknown,
  fallback: BrowserToolPermissionDecision
): BrowserToolPermissionDecision {
  return value === "ask" || value === "allow" || value === "deny" ? value : fallback;
}

function asBoundedNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Normalize a stored prefs doc; unknown fields are dropped, gaps get defaults. */
export function normalizeBrowserAgentPrefs(raw: unknown): BrowserAgentPrefs {
  const defaults = defaultBrowserAgentPrefs();
  const record = asRecord(raw);
  if (!record) {
    return defaults;
  }
  const compression = asRecord(record.compression);
  const titleGeneration = asRecord(record.titleGeneration);
  const orchestration = asRecord(record.orchestration);
  const modesEnabled = asRecord(asRecord(record.modes)?.enabled);
  const toolPermissions = asRecord(record.toolPermissions);
  const limits = asRecord(record.limits);
  const enabled: Record<BrowserModeId, boolean> = { ...defaults.modes.enabled };
  for (const modeId of BROWSER_MODE_IDS) {
    if (typeof modesEnabled?.[modeId] === "boolean") {
      enabled[modeId] = modesEnabled[modeId] as boolean;
    }
  }
  // At least one mode must survive normalization or the picker goes empty.
  if (!BROWSER_MODE_IDS.some((modeId) => enabled[modeId])) {
    enabled.agent = true;
  }
  return {
    defaultProviderKeyId:
      typeof record.defaultProviderKeyId === "string" && record.defaultProviderKeyId.trim()
        ? record.defaultProviderKeyId.trim()
        : null,
    defaultApiKind:
      typeof record.defaultApiKind === "string" && record.defaultApiKind
        ? (record.defaultApiKind as CesiumProviderKind)
        : null,
    compression: {
      enabled:
        typeof compression?.enabled === "boolean"
          ? compression.enabled
          : defaults.compression.enabled,
      modelId:
        typeof compression?.modelId === "string" && compression.modelId
          ? compression.modelId
          : null,
      thresholdRatio: asBoundedNumber(
        compression?.thresholdRatio,
        defaults.compression.thresholdRatio
      ),
    },
    titleGeneration: {
      modelId:
        typeof titleGeneration?.modelId === "string" && titleGeneration.modelId
          ? titleGeneration.modelId
          : null,
    },
    orchestration: {
      continueWhenIncomplete:
        typeof orchestration?.continueWhenIncomplete === "boolean"
          ? orchestration.continueWhenIncomplete
          : defaults.orchestration.continueWhenIncomplete,
    },
    modes: { enabled },
    toolPermissions: {
      editFile: asDecision(toolPermissions?.editFile, defaults.toolPermissions.editFile),
      terminal: asDecision(toolPermissions?.terminal, defaults.toolPermissions.terminal),
      mcpCall: asDecision(toolPermissions?.mcpCall, defaults.toolPermissions.mcpCall),
      switchMode: asDecision(toolPermissions?.switchMode, defaults.toolPermissions.switchMode),
    },
    modelAccess: normalizeCesiumModelAccess(record.modelAccess),
    limits: {
      pluginHookTimeoutMs: asBoundedNumber(
        limits?.pluginHookTimeoutMs,
        defaults.limits.pluginHookTimeoutMs
      ),
      waitMaxSeconds: asBoundedNumber(limits?.waitMaxSeconds, defaults.limits.waitMaxSeconds),
      waitAgentDefaultTimeoutMs: asBoundedNumber(
        limits?.waitAgentDefaultTimeoutMs,
        defaults.limits.waitAgentDefaultTimeoutMs
      ),
      waitAgentMinTimeoutMs: asBoundedNumber(
        limits?.waitAgentMinTimeoutMs,
        defaults.limits.waitAgentMinTimeoutMs
      ),
      waitAgentMaxTimeoutMs: asBoundedNumber(
        limits?.waitAgentMaxTimeoutMs,
        defaults.limits.waitAgentMaxTimeoutMs
      ),
      maxConcurrentSubagents: asBoundedNumber(
        limits?.maxConcurrentSubagents,
        defaults.limits.maxConcurrentSubagents
      ),
    },
  };
}

export type ModelToggleUpdate = {
  backendId: string;
  modelId: string;
  on: boolean;
};

export type ModelOrderUpdate = {
  backendId: string;
  modelIds: string[];
};

/** backendId → catalog model id (`provider/model`) → on. Missing keys mean on. */
export type StoredModelToggles = Record<string, Record<string, boolean>>;

/** backendId → catalog model ids in picker order. */
export type StoredModelOrder = Record<string, string[]>;

function applyIdOrder<T extends { id: string }>(items: T[], orderedIds: string[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const next: T[] = [];
  for (const id of orderedIds) {
    const item = byId.get(id);
    if (!item || seen.has(id)) {
      continue;
    }
    next.push(item);
    seen.add(id);
  }
  for (const item of items) {
    if (!seen.has(item.id)) {
      next.push(item);
    }
  }
  return next;
}

export class SettingsStore {
  private bootstrapPromise: Promise<void> | null = null;

  /**
   * Merge an env-provided inference provider from the hosting deployment
   * (see src/app/api/browser-machine-bootstrap). Stored keys always win;
   * this only fills the gap when no provider is configured yet. All settings
   * reads await this so early conversations pick up bootstrapped defaults.
   */
  applyEnvBootstrap(): Promise<void> {
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = (async () => {
        if (typeof fetch === "undefined" || typeof location === "undefined") return;
        try {
          const response = await fetch("/api/browser-machine-bootstrap", { cache: "no-store" });
          if (!response.ok) return;
          const payload = (await response.json()) as {
            enabled?: boolean;
            defaultModelId?: string;
            provider?: StoredProvider;
          };
          if (!payload.enabled || !payload.provider) return;
          const stored = await this.readStoredSettings();
          if (stored.providers.some((provider) => provider.id === payload.provider?.id)) {
            return;
          }
          stored.providers.push(payload.provider);
          if (!stored.defaultModelId && payload.defaultModelId) {
            stored.defaultModelId = payload.defaultModelId;
          }
          await this.putCesiumAgentSettings(stored);
        } catch {
          // No bootstrap endpoint (desktop renderer, static hosting) - fine.
        }
      })();
    }
    return this.bootstrapPromise;
  }

  async getGlobalSettings(): Promise<Record<string, unknown>> {
    return (await readDoc<Record<string, unknown>>(GLOBAL_SETTINGS_KEY)) ?? {};
  }

  async putGlobalSettings(settings: Record<string, unknown>): Promise<void> {
    await writeDoc(GLOBAL_SETTINGS_KEY, settings);
  }

  /**
   * Monotonic revision backing the `/api/settings/global` ETag. Persisted so
   * revisions survive engine reloads and stay comparable across tabs.
   */
  async getGlobalSettingsRevision(): Promise<number> {
    const stored = await readDoc<number>(GLOBAL_SETTINGS_REVISION_KEY);
    return typeof stored === "number" && Number.isFinite(stored) && stored >= 1 ? stored : 1;
  }

  async bumpGlobalSettingsRevision(): Promise<number> {
    const next = (await this.getGlobalSettingsRevision()) + 1;
    await writeDoc(GLOBAL_SETTINGS_REVISION_KEY, next);
    return next;
  }

  private async readStoredSettings(): Promise<CesiumAgentStoredSettings> {
    return (
      (await readDoc<CesiumAgentStoredSettings>(CESIUM_AGENT_SETTINGS_KEY)) ?? {
        defaultModelId: null,
        providers: [],
      }
    );
  }

  async getCesiumAgentSettings(): Promise<CesiumAgentStoredSettings> {
    await this.applyEnvBootstrap().catch(() => undefined);
    return this.readStoredSettings();
  }

  async putCesiumAgentSettings(settings: CesiumAgentStoredSettings): Promise<void> {
    await writeDoc(CESIUM_AGENT_SETTINGS_KEY, settings);
  }

  async getAgentPrefs(): Promise<BrowserAgentPrefs> {
    return normalizeBrowserAgentPrefs(await readDoc<unknown>(AGENT_PREFS_KEY));
  }

  async putAgentPrefs(prefs: BrowserAgentPrefs): Promise<void> {
    await writeDoc(AGENT_PREFS_KEY, prefs);
  }

  async getModelToggles(): Promise<StoredModelToggles> {
    const stored = await readDoc<StoredModelToggles>(MODEL_TOGGLES_KEY);
    return stored && typeof stored === "object" ? stored : {};
  }

  async applyModelToggles(updates: ModelToggleUpdate[]): Promise<StoredModelToggles> {
    const toggles = await this.getModelToggles();
    for (const update of updates) {
      if (!update?.backendId || !update.modelId) continue;
      const backend = { ...(toggles[update.backendId] ?? {}) };
      if (update.on) {
        // On is the implicit default - drop the row to keep the doc small.
        delete backend[update.modelId];
      } else {
        backend[update.modelId] = false;
      }
      if (Object.keys(backend).length === 0) {
        delete toggles[update.backendId];
      } else {
        toggles[update.backendId] = backend;
      }
    }
    await writeDoc(MODEL_TOGGLES_KEY, toggles);
    return toggles;
  }

  async getModelOrder(): Promise<StoredModelOrder> {
    const stored = await readDoc<StoredModelOrder>(MODEL_ORDER_KEY);
    return stored && typeof stored === "object" ? stored : {};
  }

  async applyModelOrders(orders: ModelOrderUpdate[]): Promise<StoredModelOrder> {
    const stored = await this.getModelOrder();
    for (const order of orders) {
      if (!order?.backendId || !Array.isArray(order.modelIds)) {
        continue;
      }
      stored[order.backendId] = order.modelIds.filter(
        (id): id is string => typeof id === "string" && id.length > 0
      );
    }
    await writeDoc(MODEL_ORDER_KEY, stored);
    return stored;
  }

  orderModelEntries<T extends { id: string }>(
    backendId: string,
    entries: T[],
    order: StoredModelOrder
  ): T[] {
    const orderedIds = order[backendId];
    if (!orderedIds || orderedIds.length === 0) {
      return entries;
    }
    return applyIdOrder(entries, orderedIds);
  }

  isModelToggledOn(
    toggles: StoredModelToggles,
    backendId: string,
    catalogModelId: string
  ): boolean {
    return toggles[backendId]?.[catalogModelId] !== false;
  }

  /** Flattened model catalog across providers. */
  async listModels(): Promise<CesiumModelCatalogEntry[]> {
    const settings = await this.getCesiumAgentSettings();
    return settings.providers.flatMap((provider) => provider.models);
  }

  /**
   * Catalog models the composer may offer, honoring the user's Model access
   * allowlist (keyed by bare or `provider/model` id) - the default model and
   * an explicitly kept model id always survive so open conversations never
   * lose their selection (server parity).
   */
  async listPickerModels(options?: { keepModelId?: string | null }): Promise<
    CesiumModelCatalogEntry[]
  > {
    const [models, prefs, defaults] = await Promise.all([
      this.listModels(),
      this.getAgentPrefs(),
      this.resolveDefaultModel(),
    ]);
    const keep = new Set(
      [defaults.modelId, options?.keepModelId ?? null].filter(
        (value): value is string => Boolean(value)
      )
    );
    return models.filter((model) => {
      const catalogId = `${model.providerId}/${model.modelId}`;
      if (keep.has(catalogId) || keep.has(model.modelId)) {
        return true;
      }
      return (
        isCesiumModelEnabled(model.modelId, prefs.modelAccess) &&
        isCesiumModelEnabled(catalogId, prefs.modelAccess)
      );
    });
  }

  async resolveDefaultModel(): Promise<{ modelId: string; modelName: string }> {
    const settings = await this.getCesiumAgentSettings();
    const models = settings.providers.flatMap((provider) => provider.models);
    const configured = settings.defaultModelId
      ? models.find(
          (model) =>
            model.modelId === settings.defaultModelId ||
            `${model.providerId}/${model.modelId}` === settings.defaultModelId
        )
      : null;
    if (configured) {
      return {
        modelId: `${configured.providerId}/${configured.modelId}`,
        modelName: configured.modelName,
      };
    }
    const first = models[0];
    if (first) {
      return {
        modelId: `${first.providerId}/${first.modelId}`,
        modelName: first.modelName,
      };
    }
    return { modelId: CESIUM_DEFAULT_MODEL_ID, modelName: CESIUM_DEFAULT_MODEL_NAME };
  }

  /**
   * Resolve provider + credentials for a conversation model id of the form
   * `providerId/modelId` (falling back to catalog search by bare model id).
   */
  async resolveModelAuth(modelId: string): Promise<{
    provider: StoredProvider;
    model: CesiumModelCatalogEntry;
  } | null> {
    const settings = await this.getCesiumAgentSettings();
    const slash = modelId.indexOf("/");
    if (slash > 0) {
      const providerId = modelId.slice(0, slash);
      const bareModelId = modelId.slice(slash + 1);
      const provider = settings.providers.find((entry) => entry.id === providerId);
      const model = provider?.models.find((entry) => entry.modelId === bareModelId);
      if (provider && model) {
        return { provider, model };
      }
    }
    for (const provider of settings.providers) {
      const model = provider.models.find((entry) => entry.modelId === modelId);
      if (model) {
        return { provider, model };
      }
    }
    return null;
  }
}
