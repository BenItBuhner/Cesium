import { invalidate, readThrough } from "../cache/read-through.js";
import { getStorage } from "../storage/runtime.js";
import {
  readAgentBackendConfigCache,
  forceRefreshAllBackendCaches,
  type ForceRefreshResult,
} from "./agents/provider-cache-store.js";
import type {
  AgentBackendId,
  AgentPermissionCategory,
  AgentPermissionOptionKind,
  RememberedAgentPermissionMatchStyle,
} from "./agents/types.js";
import { isAgentPermissionCategory } from "./agents/permission-options.js";
import {
  isActiveAgentBackendId,
  pruneModelToggleByBackend,
} from "./active-agent-backends.js";
import { refreshCesiumModelCatalog } from "./cesium-agent-settings.js";
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
  /** Optional category for UI grouping and category-scoped matching. */
  permissionCategory?: AgentPermissionCategory;
  /**
   * `exact` (default): match this toolKey only.
   * `category`: match any tool call in `permissionCategory` for this workspace/backend.
   */
  matchStyle?: RememberedAgentPermissionMatchStyle;
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
    workspaceRailAppearances: Record<string, WorkspaceRailAppearance>;
    serverRailAppearances: Record<string, ServerRailAppearance>;
    chatFolders: ChatFolderState[];
    agentRail: AgentRailSettingsState;
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
     * When true, the server auto-approves agent tool permission prompts across harnesses.
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
  features: {
    vscodeExtensionsBeta: boolean;
  };
  keyboardShortcuts: {
    bindings: Record<string, string[]>;
    voiceInputMode?: "hold" | "toggle";
  };
};

export type WorkspaceSortMode = "recent" | "alphabetical" | "custom";
export type AgentRailGroupByMode = "workspace" | "repository" | "server" | "updated" | "status";

export type ChatFolderState = {
  id: string;
  workspaceId: string;
  name: string;
  color: string;
  icon: string;
  sortOrder: number;
  conversationIds: string[];
};

/** Per server-scoped workspace key (`serverId:workspaceId`). */
export type WorkspaceRailAppearance = {
  icon: string;
  color: string;
};

/** Per server id (`ServerConnection.id`). */
export type ServerRailAppearance = {
  icon: string;
  color: string;
  nickname?: string;
};

export type AgentRailSettingsState = {
  groupBy: AgentRailGroupByMode;
  visibleStatusFilters: string[];
  /** Legacy allow-list kept only so old persisted settings can be read. New filtering uses hiddenServerIds. */
  visibleServerIds: string[];
  hiddenServerIds: string[];
  showIcons: boolean;
};

function createDefaultSettings(): GlobalSettings {
  return {
    schemaVersion: 1,
    general: {
      doNotDisturb: false,
      sideColumnsSwapped: false,
      workspaceSortMode: "recent",
      workspaceCustomOrderIds: [],
      workspaceRailAppearances: {},
      serverRailAppearances: {},
      chatFolders: [],
      agentRail: {
        groupBy: "workspace",
        visibleStatusFilters: [],
        visibleServerIds: [],
        hiddenServerIds: [],
        showIcons: true,
      },
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
    features: {
      vscodeExtensionsBeta: false,
    },
    keyboardShortcuts: {
      bindings: {},
      voiceInputMode: "toggle",
    },
  };
}

function hadLegacyModelBackendKeys(raw: Record<string, unknown>): boolean {
  const byBackend = (raw.models as { byBackend?: Record<string, unknown> } | undefined)?.byBackend;
  if (!byBackend || typeof byBackend !== "object") {
    return false;
  }
  return Object.keys(byBackend).some((backendId) => !isActiveAgentBackendId(backendId));
}

export async function getGlobalSettings(): Promise<GlobalSettings> {
  return readThrough(KEY_GLOBAL_SETTINGS, GLOBAL_SETTINGS_CACHE_TTL_SECONDS, async () => {
    const row = await (await getStorage()).getGlobalSettings();
    if (!row) return createDefaultSettings();
    const migrated = migrateGlobalSettings(row);
    if (hadLegacyModelBackendKeys(row)) {
      await saveGlobalSettings(migrated);
    }
    return migrated;
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

const REMEMBERED_PERMISSION_BACKEND_REMAP: Record<string, string> = {
  cesium: "cesium-agent",
  "cursor-acp": "cursor-sdk",
  "claude-adapter": "claude-code-sdk",
  "opencode-acp": "opencode-server",
  "codex-adapter": "codex-app-server",
  "gemini-acp": "google-antigravity-cli",
};

function normalizeRememberedPermissionBackendId(backendId: string): string {
  return REMEMBERED_PERMISSION_BACKEND_REMAP[backendId] ?? backendId;
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
    const backendId = normalizeRememberedPermissionBackendId(
      typeof record.backendId === "string" ? record.backendId.trim() : ""
    );
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
      permissionCategory: isAgentPermissionCategory(record.permissionCategory)
        ? record.permissionCategory
        : undefined,
      matchStyle:
        record.matchStyle === "exact" || record.matchStyle === "category"
          ? record.matchStyle
          : undefined,
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

function normalizeServerRailAppearances(
  raw: unknown
): Record<string, ServerRailAppearance> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const out: Record<string, ServerRailAppearance> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= 100) {
      break;
    }
    const serverId = typeof key === "string" ? key.trim() : "";
    if (!serverId || !value || typeof value !== "object") {
      continue;
    }
    const record = value as Partial<ServerRailAppearance>;
    const rawColor = typeof record.color === "string" ? record.color.trim() : "";
    const rawIcon = typeof record.icon === "string" ? record.icon.trim() : "";
    const rawNickname =
      typeof record.nickname === "string" ? record.nickname.trim().slice(0, 80) : "";
    if (!rawIcon && !/^#[0-9a-f]{6}$/i.test(rawColor) && !rawNickname) {
      continue;
    }
    out[serverId] = {
      icon: rawIcon || "Globe",
      color: /^#[0-9a-f]{6}$/i.test(rawColor) ? rawColor : "#2563eb",
      ...(rawNickname ? { nickname: rawNickname } : {}),
    };
    count += 1;
  }
  return out;
}

function normalizeWorkspaceRailAppearances(
  raw: unknown
): Record<string, WorkspaceRailAppearance> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const out: Record<string, WorkspaceRailAppearance> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= 500) {
      break;
    }
    const workspaceKey = typeof key === "string" ? key.trim() : "";
    if (!workspaceKey || !value || typeof value !== "object") {
      continue;
    }
    const record = value as Partial<WorkspaceRailAppearance>;
    const rawColor = typeof record.color === "string" ? record.color.trim() : "";
    const rawIcon = typeof record.icon === "string" ? record.icon.trim() : "";
    if (!rawIcon && !/^#[0-9a-f]{6}$/i.test(rawColor)) {
      continue;
    }
    out[workspaceKey] = {
      icon: rawIcon || "Folder",
      color: /^#[0-9a-f]{6}$/i.test(rawColor) ? rawColor : "#7c3aed",
    };
    count += 1;
  }
  return out;
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

function normalizeAgentRailSettings(raw: unknown): AgentRailSettingsState {
  const defaults = createDefaultSettings().general.agentRail;
  if (!raw || typeof raw !== "object") {
    return defaults;
  }
  const record = raw as Partial<AgentRailSettingsState>;
  const rawGroupBy =
    record.groupBy === "workspace" ||
    record.groupBy === "repository" ||
    record.groupBy === "server" ||
    record.groupBy === "updated" ||
    record.groupBy === "status"
      ? record.groupBy
      : defaults.groupBy;
  const groupBy = rawGroupBy === "server" ? "workspace" : rawGroupBy;
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  return {
    groupBy,
    visibleStatusFilters: strings(record.visibleStatusFilters),
    // Do not preserve legacy allow-lists. They hide newly added servers forever,
    // which is catastrophic for a dynamic multi-server rail.
    visibleServerIds: [],
    hiddenServerIds: strings(record.hiddenServerIds),
    showIcons:
      typeof record.showIcons === "boolean" ? record.showIcons : defaults.showIcons,
  };
}

export function findMatchingRememberedPermissionRule(
  rules: RememberedAgentPermissionRule[],
  input: {
    workspaceId: string;
    backendId: string;
    toolKey: string;
    permissionCategory?: AgentPermissionCategory;
  }
): RememberedAgentPermissionRule | undefined {
  const backendId = normalizeRememberedPermissionBackendId(input.backendId.trim());
  const scoped = rules.filter(
    (rule) => rule.workspaceId === input.workspaceId && rule.backendId === backendId
  );
  const exact = scoped.find(
    (rule) => (rule.matchStyle ?? "exact") === "exact" && rule.toolKey === input.toolKey
  );
  if (exact) {
    return exact;
  }
  if (input.permissionCategory) {
    return scoped.find(
      (rule) =>
        rule.matchStyle === "category" &&
        rule.permissionCategory === input.permissionCategory
    );
  }
  return undefined;
}

export async function getRememberedAgentPermissionRule(input: {
  workspaceId: string;
  backendId: string;
  toolKey: string;
  permissionCategory?: AgentPermissionCategory;
}): Promise<RememberedAgentPermissionRule | undefined> {
  const settings = await getGlobalSettings();
  return findMatchingRememberedPermissionRule(settings.agents.rememberedPermissions, input);
}

export async function saveRememberedAgentPermissionRule(input: {
  workspaceId: string;
  backendId: string;
  toolKey: string;
  toolLabel: string;
  decision: RememberedAgentPermissionDecision;
  optionId: string;
  optionKind: RememberedAgentPermissionRule["optionKind"];
  permissionCategory?: AgentPermissionCategory;
  matchStyle?: RememberedAgentPermissionMatchStyle;
}): Promise<RememberedAgentPermissionRule> {
  const settings = await getGlobalSettings();
  const now = Date.now();
  const backendId = normalizeRememberedPermissionBackendId(input.backendId.trim());
  const matchStyle = input.matchStyle ?? "exact";
  const id = `${input.workspaceId}:${backendId}:${input.toolKey}:${matchStyle}`;
  const existing = settings.agents.rememberedPermissions.find(
    (rule) =>
      rule.workspaceId === input.workspaceId &&
      rule.backendId === backendId &&
      rule.toolKey === input.toolKey &&
      (rule.matchStyle ?? "exact") === matchStyle
  );
  const nextRule: RememberedAgentPermissionRule = {
    id: existing?.id ?? id,
    workspaceId: input.workspaceId,
    backendId,
    toolKey: input.toolKey,
    toolLabel: input.toolLabel.trim().slice(0, 160) || "Tool permission",
    decision: input.decision,
    optionId: input.optionId,
    optionKind: input.optionKind,
    permissionCategory: input.permissionCategory,
    matchStyle,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const withoutExisting = settings.agents.rememberedPermissions.filter(
    (rule) =>
      !(
        rule.workspaceId === input.workspaceId &&
        rule.backendId === backendId &&
        rule.toolKey === input.toolKey &&
        (rule.matchStyle ?? "exact") === matchStyle
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
      workspaceRailAppearances: normalizeWorkspaceRailAppearances(
        (r.general as Record<string, unknown> | undefined)?.workspaceRailAppearances
      ),
      serverRailAppearances: normalizeServerRailAppearances(
        (r.general as Record<string, unknown> | undefined)?.serverRailAppearances
      ),
      chatFolders: normalizeChatFolders(
        (r.general as Record<string, unknown> | undefined)?.chatFolders
      ),
      agentRail: normalizeAgentRailSettings(
        (r.general as Record<string, unknown> | undefined)?.agentRail
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
    features: {
      vscodeExtensionsBeta:
        typeof (r as { features?: { vscodeExtensionsBeta?: unknown } }).features
          ?.vscodeExtensionsBeta === "boolean"
          ? (r as { features: { vscodeExtensionsBeta: boolean } }).features
              .vscodeExtensionsBeta
          : defaults.features.vscodeExtensionsBeta,
    },
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
  if (backendId === "opencode-server" || backendId === "opencode-v2-beta") {
    return id === "auto" && name === "auto";
  }
  if (backendId === "pi-agent") {
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

        return { byBackend: pruneModelToggleByBackend(merged) };
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
  if (backendIds.includes("cesium-agent")) {
    await refreshCesiumModelCatalog().catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn("[settings] Cesium models.dev catalog refresh failed:", detail);
    });
  }

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

  const prunedMerged = pruneModelToggleByBackend(merged);

  const next: GlobalSettings = {
    ...settings,
    models: { byBackend: prunedMerged },
  };
  await saveGlobalSettings(next);

  return {
    toggleState: { byBackend: prunedMerged },
    timedOut: refreshResult.timedOut,
    failed: refreshResult.failed,
  };
}
