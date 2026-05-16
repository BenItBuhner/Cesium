import { invalidate, readThrough } from "../cache/read-through.js";
import { getStorage } from "../storage/runtime.js";
import {
  readAgentBackendConfigCache,
  forceRefreshAllBackendCaches,
  type ForceRefreshResult,
} from "./agents/provider-cache-store.js";
import type {
  AgentBackendId,
  AgentConfigOption,
  AgentPermissionOptionKind,
} from "./agents/types.js";
import { measureServerPerf } from "./perf.js";

const GLOBAL_SETTINGS_CACHE_TTL_SECONDS = 120;
const KEY_GLOBAL_SETTINGS = "opencursor:settings:global";
const MODEL_TOGGLE_CACHE_TTL_SECONDS = 30;
const modelToggleCacheKeys = new Set<string>();

export type ModelToggleEntry = {
  id: string;
  name: string;
  on: boolean;
  backendId?: string;
};

export type RememberedAgentPermissionDecision = "allow" | "reject";

export type RememberedAgentPermissionRule = {
  id: string;
  workspaceId: string;
  backendId: string;
  toolKey: string;
  toolLabel: string;
  decision: RememberedAgentPermissionDecision;
  optionId: string;
  optionKind: Extract<AgentPermissionOptionKind, "allow_always" | "reject_always">;
  createdAt: number;
  updatedAt: number;
};

export type GlobalSettings = {
  schemaVersion: 1;
  /**
   * Full theme config JSON (same shape as client `ThemeConfig`); optional for legacy rows.
   * Stored in the profile blob so system/light/dark and presets sync across clients.
   */
  themeConfig?: unknown;
  general: {
    doNotDisturb: boolean;
    sideColumnsSwapped: boolean;
    workspaceSortMode: WorkspaceSortMode;
    workspaceCustomOrderIds: string[];
    chatFolders: ChatFolderState[];
  };
  agents: {
    submitCtrlEnter: boolean;
    autocomplete: boolean;
    webSearch: boolean;
    autoWeb: boolean;
    webFetch: boolean;
    hierIgnore: boolean;
    symlinkIgnore: boolean;
    legacyTerm: boolean;
    autoParse: boolean;
    themedDiff: boolean;
    inlineToolDetailsInChat: boolean;
    collapseAuto: boolean;
    commitAttr: boolean;
    prAttr: boolean;
    fileDel: boolean;
    extFile: boolean;
    browserProt: boolean;
    mcpProt: boolean;
    cmdTags: string[];
    modeTags: string[];
    branchPrefix: string;
    /**
     * When true, ACP `session/request_permission` is answered with Allow without showing a prompt.
     * Remembered rules still win when they match. Does not persist new remembered entries.
     */
    autoAcceptAllAgentPermissions: boolean;
    rememberedPermissions: RememberedAgentPermissionRule[];
  };
  models: {
    byBackend: Record<string, ModelToggleEntry[]>;
  };
  /** Placeholder; always empty until tool prefs are modeled. */
  tools: Record<string, never>;
  keyboardShortcuts: {
    bindings: Record<string, string[]>;
    voiceInputMode?: "hold" | "toggle";
  };
};

export type WorkspaceSortMode = "recent" | "alphabetical" | "custom";

export type ChatFolderState = {
  id: string;
  workspaceId: string;
  name: string;
  color: string;
  icon: string;
  sortOrder: number;
  conversationIds: string[];
};

function createDefaultSettings(): GlobalSettings {
  return {
    schemaVersion: 1,
    general: {
      doNotDisturb: false,
      sideColumnsSwapped: false,
      workspaceSortMode: "recent",
      workspaceCustomOrderIds: [],
      chatFolders: [],
    },
    agents: {
      submitCtrlEnter: false,
      autocomplete: false,
      webSearch: true,
      autoWeb: true,
      webFetch: true,
      hierIgnore: false,
      symlinkIgnore: false,
      legacyTerm: false,
      autoParse: false,
      themedDiff: true,
      inlineToolDetailsInChat: true,
      collapseAuto: true,
      commitAttr: true,
      prAttr: true,
      fileDel: true,
      extFile: true,
      browserProt: false,
      mcpProt: false,
      cmdTags: [
        "pip install *",
        "npm install *",
        "uv install *",
        "python *",
        "cd *",
        "ls *",
        "grep *",
        "Select-Object *",
      ],
      modeTags: ["agent-plan"],
      branchPrefix: "cursor/",
      autoAcceptAllAgentPermissions: false,
      rememberedPermissions: [],
    },
    models: {
      byBackend: {},
    },
    tools: {},
    keyboardShortcuts: {
      bindings: {},
      voiceInputMode: "toggle",
    },
  };
}

export async function getGlobalSettings(): Promise<GlobalSettings> {
  return readThrough(KEY_GLOBAL_SETTINGS, GLOBAL_SETTINGS_CACHE_TTL_SECONDS, async () => {
    const row = await (await getStorage()).getGlobalSettings();
    if (!row) return createDefaultSettings();
    return migrateGlobalSettings(row);
  });
}

export async function saveGlobalSettings(settings: GlobalSettings): Promise<void> {
  await (await getStorage()).saveGlobalSettings(settings);
  await invalidateGlobalSettingsCaches();
}

function modelToggleCacheKey(backendIds: AgentBackendId[]): string {
  return `opencursor:settings:models:${[...backendIds].sort().join(",")}`;
}

async function invalidateModelToggleStateCache(): Promise<void> {
  const keys = [...modelToggleCacheKeys];
  modelToggleCacheKeys.clear();
  if (keys.length > 0) {
    await invalidate(...keys);
  }
}

async function invalidateGlobalSettingsCaches(): Promise<void> {
  await invalidate(KEY_GLOBAL_SETTINGS);
  await invalidateModelToggleStateCache();
}

function isRememberedPermissionOptionKind(
  value: unknown
): value is RememberedAgentPermissionRule["optionKind"] {
  return value === "allow_always" || value === "reject_always";
}

function normalizeRememberedAgentPermissionRules(
  raw: unknown
): RememberedAgentPermissionRule[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const rules: RememberedAgentPermissionRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Partial<RememberedAgentPermissionRule>;
    const workspaceId = typeof record.workspaceId === "string" ? record.workspaceId.trim() : "";
    const backendId = typeof record.backendId === "string" ? record.backendId.trim() : "";
    const toolKey = typeof record.toolKey === "string" ? record.toolKey.trim() : "";
    const decision = record.decision === "allow" || record.decision === "reject" ? record.decision : null;
    const optionKind = isRememberedPermissionOptionKind(record.optionKind)
      ? record.optionKind
      : decision === "allow"
        ? "allow_always"
        : decision === "reject"
          ? "reject_always"
          : null;
    if (!workspaceId || !backendId || !toolKey || !decision || !optionKind) {
      continue;
    }
    const now = Date.now();
    rules.push({
      id: typeof record.id === "string" && record.id.trim()
        ? record.id.trim()
        : `${workspaceId}:${backendId}:${toolKey}`,
      workspaceId,
      backendId,
      toolKey,
      toolLabel:
        typeof record.toolLabel === "string" && record.toolLabel.trim()
          ? record.toolLabel.trim().slice(0, 160)
          : "Tool permission",
      decision,
      optionId:
        typeof record.optionId === "string" && record.optionId.trim()
          ? record.optionId.trim()
          : optionKind,
      optionKind,
      createdAt:
        typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
          ? record.createdAt
          : now,
      updatedAt:
        typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
          ? record.updatedAt
          : now,
    });
  }
  return rules;
}

function normalizeWorkspaceSortMode(raw: unknown): WorkspaceSortMode {
  return raw === "recent" || raw === "alphabetical" || raw === "custom"
    ? raw
    : "recent";
}

function normalizeWorkspaceCustomOrderIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out.slice(0, 500);
}

function normalizeChatFolders(raw: unknown): ChatFolderState[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seenFolderIds = new Set<string>();
  const folders: ChatFolderState[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Partial<ChatFolderState>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const workspaceId = typeof record.workspaceId === "string" ? record.workspaceId.trim() : "";
    if (!id || !workspaceId || seenFolderIds.has(id)) {
      continue;
    }
    seenFolderIds.add(id);
    const seenConversationIds = new Set<string>();
    const conversationIds = Array.isArray(record.conversationIds)
      ? record.conversationIds.flatMap((value): string[] => {
          if (typeof value !== "string" || !value || seenConversationIds.has(value)) {
            return [];
          }
          seenConversationIds.add(value);
          return [value];
        })
      : [];
    const rawColor = typeof record.color === "string" ? record.color.trim() : "";
    const rawIcon = typeof record.icon === "string" ? record.icon.trim() : "";
    folders.push({
      id,
      workspaceId,
      name:
        typeof record.name === "string" && record.name.trim()
          ? record.name.trim().slice(0, 80)
          : "Folder",
      color: /^#[0-9a-f]{6}$/i.test(rawColor) ? rawColor : "#7c3aed",
      icon: rawIcon || "Folder",
      sortOrder:
        typeof record.sortOrder === "number" && Number.isFinite(record.sortOrder)
          ? record.sortOrder
          : folders.length,
      conversationIds,
    });
  }
  return folders.slice(0, 500);
}

export async function getRememberedAgentPermissionRule(input: {
  workspaceId: string;
  backendId: string;
  toolKey: string;
}): Promise<RememberedAgentPermissionRule | undefined> {
  const settings = await getGlobalSettings();
  return settings.agents.rememberedPermissions.find(
    (rule) =>
      rule.workspaceId === input.workspaceId &&
      rule.backendId === input.backendId &&
      rule.toolKey === input.toolKey
  );
}

export async function saveRememberedAgentPermissionRule(input: {
  workspaceId: string;
  backendId: string;
  toolKey: string;
  toolLabel: string;
  decision: RememberedAgentPermissionDecision;
  optionId: string;
  optionKind: RememberedAgentPermissionRule["optionKind"];
}): Promise<RememberedAgentPermissionRule> {
  const settings = await getGlobalSettings();
  const now = Date.now();
  const id = `${input.workspaceId}:${input.backendId}:${input.toolKey}`;
  const existing = settings.agents.rememberedPermissions.find(
    (rule) =>
      rule.workspaceId === input.workspaceId &&
      rule.backendId === input.backendId &&
      rule.toolKey === input.toolKey
  );
  const nextRule: RememberedAgentPermissionRule = {
    id: existing?.id ?? id,
    workspaceId: input.workspaceId,
    backendId: input.backendId,
    toolKey: input.toolKey,
    toolLabel: input.toolLabel.trim().slice(0, 160) || "Tool permission",
    decision: input.decision,
    optionId: input.optionId,
    optionKind: input.optionKind,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const withoutExisting = settings.agents.rememberedPermissions.filter(
    (rule) =>
      !(
        rule.workspaceId === input.workspaceId &&
        rule.backendId === input.backendId &&
        rule.toolKey === input.toolKey
      )
  );
  const rememberedPermissions = [...withoutExisting, nextRule].slice(-250);
  await saveGlobalSettings({
    ...settings,
    agents: {
      ...settings.agents,
      rememberedPermissions,
    },
  });
  return nextRule;
}

function migrateGlobalSettings(raw: Record<string, unknown>): GlobalSettings {
  const defaults = createDefaultSettings();
  const r = raw as Partial<GlobalSettings> & {
    models?: { models?: unknown; byBackend?: Record<string, unknown> };
  };

  if (r.schemaVersion !== 1) {
    return defaults;
  }

  const byBackend = r.models?.byBackend ?? defaults.models.byBackend;
  const migratedByBackend: Record<string, ModelToggleEntry[]> = {};
  if (byBackend && typeof byBackend === "object") {
    for (const [backendId, entries] of Object.entries(byBackend)) {
      if (Array.isArray(entries)) {
        migratedByBackend[backendId] = entries.map((entry: unknown) => {
          if (entry && typeof entry === "object") {
            const e = entry as Partial<ModelToggleEntry>;
            return {
              id: typeof e.id === "string" ? e.id : "",
              name: typeof e.name === "string" ? e.name : "",
              on: typeof e.on === "boolean" ? e.on : true,
              backendId: typeof e.backendId === "string" ? e.backendId : backendId,
            };
          }
          return { id: "", name: "", on: true, backendId };
        });
      }
    }
  }

  return {
    schemaVersion: 1,
    ...(r.themeConfig !== undefined && r.themeConfig !== null
      ? { themeConfig: r.themeConfig }
      : {}),
    general: {
      ...defaults.general,
      ...(r.general ?? {}),
      workspaceSortMode: normalizeWorkspaceSortMode(
        (r.general as Record<string, unknown> | undefined)?.workspaceSortMode
      ),
      workspaceCustomOrderIds: normalizeWorkspaceCustomOrderIds(
        (r.general as Record<string, unknown> | undefined)?.workspaceCustomOrderIds
      ),
      chatFolders: normalizeChatFolders(
        (r.general as Record<string, unknown> | undefined)?.chatFolders
      ),
    },
    agents: {
      ...defaults.agents,
      ...(r.agents ?? {}),
      cmdTags: (r.agents as Record<string, unknown>)?.cmdTags as string[] ?? defaults.agents.cmdTags,
      modeTags: (r.agents as Record<string, unknown>)?.modeTags as string[] ?? defaults.agents.modeTags,
      autoAcceptAllAgentPermissions:
        typeof (r.agents as Record<string, unknown>)?.autoAcceptAllAgentPermissions === "boolean"
          ? (r.agents as GlobalSettings["agents"]).autoAcceptAllAgentPermissions
          : defaults.agents.autoAcceptAllAgentPermissions,
      rememberedPermissions: normalizeRememberedAgentPermissionRules(
        (r.agents as Record<string, unknown>)?.rememberedPermissions
      ),
    },
    models: {
      byBackend: migratedByBackend,
    },
    tools: {},
    keyboardShortcuts: {
      bindings: typeof r.keyboardShortcuts === "object" && r.keyboardShortcuts
        ? (r.keyboardShortcuts as GlobalSettings["keyboardShortcuts"]).bindings ?? {}
        : {},
      voiceInputMode: typeof r.keyboardShortcuts === "object" && r.keyboardShortcuts
        ? (r.keyboardShortcuts as GlobalSettings["keyboardShortcuts"]).voiceInputMode ?? "toggle"
        : "toggle",
    },
  };
}

export type ModelToggleStateResponse = {
  byBackend: Record<string, ModelToggleEntry[]>;
};

export type ModelToggleUpdate = {
  backendId: string;
  modelId: string;
  on: boolean;
};

function isKnownPlaceholderModelToggle(
  backendId: string,
  entry: ModelToggleEntry
): boolean {
  const id = entry.id.trim().toLowerCase();
  const name = entry.name.trim().toLowerCase();
  if (backendId === "cursor-sdk") {
    return id === "composer-2" && name === "composer 2";
  }
  if (backendId === "opencode-server") {
    return id === "auto" && name === "auto";
  }
  return false;
}

function prunePlaceholderModelToggles(
  backendId: string,
  entries: ModelToggleEntry[]
): ModelToggleEntry[] {
  return entries.filter((entry) => !isKnownPlaceholderModelToggle(backendId, entry));
}

async function extractModelCatalogFromBackends(
  backendIds: AgentBackendId[]
): Promise<Record<string, Array<{ id: string; name: string }>>> {
  const catalog: Record<string, Array<{ id: string; name: string }>> = {};
  const results = await Promise.allSettled(
    backendIds.map(async (backendId) => {
      const configOptions = await readAgentBackendConfigCache(backendId);
      const modelOption = configOptions.find(
        (opt) => opt.category === "model"
      );
      if (modelOption && modelOption.options.length > 0) {
        catalog[backendId] = modelOption.options.map((opt) => ({
          id: opt.value,
          name: opt.name,
        }));
      }
    })
  );
  void results;
  return catalog;
}

export async function getModelToggleState(
  backendIds: AgentBackendId[]
): Promise<ModelToggleStateResponse> {
  const key = modelToggleCacheKey(backendIds);
  modelToggleCacheKeys.add(key);
  return readThrough(key, MODEL_TOGGLE_CACHE_TTL_SECONDS, () =>
    measureServerPerf(
      "settings.getModelToggleState",
      async () => {
        const settings = await getGlobalSettings();
        const catalog = await measureServerPerf(
          "settings.extractModelCatalogFromBackends",
          () => extractModelCatalogFromBackends(backendIds),
          { backends: backendIds.length }
        );
        const existing = settings.models.byBackend ?? {};
        const merged: Record<string, ModelToggleEntry[]> = {};

        for (const [backendId, models] of Object.entries(catalog)) {
          const existingForBackend = existing[backendId] ?? [];
          const existingMap = new Map(existingForBackend.map((m) => [m.id, m]));
          merged[backendId] = models.map((model) => {
            const existingEntry = existingMap.get(model.id);
            return existingEntry
              ? { ...existingEntry, name: model.name, backendId }
              : { id: model.id, name: model.name, on: true, backendId };
          });
        }

        for (const [backendId, existingList] of Object.entries(existing)) {
          if (!catalog[backendId]) {
            const pruned = prunePlaceholderModelToggles(backendId, existingList);
            if (pruned.length > 0) {
              merged[backendId] = pruned;
            }
          }
        }

        return { byBackend: merged };
      },
      { backends: backendIds.length }
    )
  );
}

export async function setModelToggles(
  updates: ModelToggleUpdate[]
): Promise<ModelToggleStateResponse> {
  return measureServerPerf(
    "settings.setModelToggles",
    async () => {
      const settings = await getGlobalSettings();
      /**
       * Previously we only updated `settings.models.byBackend[backendId]` when that array
       * already existed. On a fresh account (or before any merged catalog was persisted) the
       * object was often empty, so `PUT /api/settings/models/toggles` was a silent no-op and
       * devices never received stored on/off state. Rebuild the merged view the same way as
       * `getModelToggleState` before applying diffs.
       */
      const touchedBackendIds = [
        ...new Set(updates.map((u) => u.backendId as AgentBackendId)),
      ];
      const byBackend = { ...(settings.models.byBackend ?? {}) };
      const missingBackendIds = touchedBackendIds.filter((backendId) => !byBackend[backendId]);
      if (missingBackendIds.length > 0) {
        const base = await getModelToggleState(missingBackendIds);
        Object.assign(byBackend, base.byBackend);
      }

      for (const update of updates) {
        const list = byBackend[update.backendId];
        if (!list) {
          continue;
        }
        byBackend[update.backendId] = list.map((entry) =>
          entry.id === update.modelId ? { ...entry, on: update.on } : entry
        );
      }

      const next: GlobalSettings = {
        ...settings,
        models: { byBackend },
      };
      await saveGlobalSettings(next);

      return { byBackend: next.models.byBackend };
    },
    { updates: updates.length }
  );
}

export type RefreshModelsResult = {
  toggleState: ModelToggleStateResponse;
  timedOut: AgentBackendId[];
  failed: AgentBackendId[];
};

export async function refreshAndGetModelToggleState(
  backendIds: AgentBackendId[]
): Promise<RefreshModelsResult> {
  const refreshResult: ForceRefreshResult = await forceRefreshAllBackendCaches(backendIds);

  const settings = await getGlobalSettings();
  const existing = settings.models.byBackend ?? {};
  const merged: Record<string, ModelToggleEntry[]> = {};

  const allBackendIds = new Set<AgentBackendId>(backendIds);
  for (const [backendId, configOptions] of Object.entries(refreshResult.byBackend)) {
    const modelOption = configOptions.find(
      (opt) => opt.category === "model"
    );
    const models = modelOption
      ? modelOption.options.map((opt) => ({ id: opt.value, name: opt.name }))
      : [];
    if (models.length > 0) {
      const existingForBackend = existing[backendId] ?? [];
      const existingMap = new Map(existingForBackend.map((m) => [m.id, m]));
      merged[backendId] = models.map((model) => {
        const existingEntry = existingMap.get(model.id);
        return existingEntry
          ? { ...existingEntry, name: model.name, backendId }
          : { id: model.id, name: model.name, on: true, backendId };
      });
    }
    allBackendIds.delete(backendId as AgentBackendId);
  }

  for (const backendId of allBackendIds) {
    const catalog = await extractModelCatalogFromBackends([backendId]);
    const models = catalog[backendId] ?? [];
    if (models.length > 0) {
      const existingForBackend = existing[backendId] ?? [];
      const existingMap = new Map(existingForBackend.map((m) => [m.id, m]));
      merged[backendId] = models.map((model) => {
        const existingEntry = existingMap.get(model.id);
        return existingEntry
          ? { ...existingEntry, name: model.name, backendId }
          : { id: model.id, name: model.name, on: true, backendId };
      });
    } else if (existing[backendId]) {
      const pruned = prunePlaceholderModelToggles(backendId, existing[backendId]);
      if (pruned.length > 0) {
        merged[backendId] = pruned;
      }
    }
  }

  for (const [backendId, existingList] of Object.entries(existing)) {
    if (!merged[backendId]) {
      const pruned = prunePlaceholderModelToggles(backendId, existingList);
      if (pruned.length > 0) {
        merged[backendId] = pruned;
      }
    }
  }

  const next: GlobalSettings = {
    ...settings,
    models: { byBackend: merged },
  };
  await saveGlobalSettings(next);

  return {
    toggleState: { byBackend: merged },
    timedOut: refreshResult.timedOut,
    failed: refreshResult.failed,
  };
}
