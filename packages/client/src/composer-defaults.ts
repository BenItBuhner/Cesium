import {
  DEFAULT_COMPOSER_PILLS_VISIBILITY,
  isActiveAgentBackendId,
  NO_MODEL_PLACEHOLDER,
  normalizeComposerPillsVisibility,
  type AgentBackendId,
  type ComposerPillsVisibility,
  type EditorMode,
  type ModelInfo,
} from "@cesium/core";
import {
  DEFAULT_COMPOSER_STATUS_BAR_VISIBILITY,
  normalizeComposerStatusBarVisibility,
  type ComposerStatusBarVisibility,
} from "./composer-status-bar";

/**
 * Account-wide composer defaults for brand-new chats.
 *
 * Historically the "last used" harness / mode / model lived inside each
 * workspace's session (`ChatSessionState`), so every workspace - and every
 * engine - remembered a different pick, and a fresh device started from the
 * hardcoded defaults. This slice lives in the global settings document
 * instead: one home, synced to every client of the account.
 *
 * Only *defaults for new conversations* live here. Per-conversation state
 * (a chat's own status-bar toggles, scroll positions, etc.) stays in the
 * workspace session next to the conversation it belongs to.
 */
export type ComposerDefaultsState = {
  /** Harness the next new chat starts on (last used). */
  backendId: AgentBackendId;
  /** Mode the next new chat starts in (last used). */
  mode: EditorMode;
  /** Model the next new chat starts with (last used for `backendId`). */
  model: ModelInfo;
  /**
   * Per-harness "last used" model memory. Switching back to a harness (or
   * starting a new chat after using another one) restores the user's model
   * instead of snapping back to the harness default.
   */
  lastModelByBackend: Record<string, ModelInfo>;
  /**
   * Cesium capability profile for new chats ("code", "work", or a custom
   * profile id). Persisted conversations bind their profile via config
   * options; this only seeds the draft.
   */
  profileId?: string;
  /** Composer footer defaults: repo / branch / goal progress / context. */
  statusBarVisibility: ComposerStatusBarVisibility;
  /** Composer quick-action pill defaults. */
  pillsVisibility: ComposerPillsVisibility;
  /**
   * Epoch ms of the last explicit change; `0` means the account never set a
   * composer default (used to adopt legacy per-workspace picks exactly once).
   */
  updatedAt: number;
};

export const DEFAULT_COMPOSER_BACKEND_ID: AgentBackendId = "cesium-agent";
export const DEFAULT_COMPOSER_MODE: EditorMode = "agent";

const MAX_LAST_MODEL_ENTRIES = 32;
const MAX_MODEL_STRING = 400;
const MAX_CONFIG_SELECTIONS = 32;

/**
 * Backend ids that were renamed; persisted picks under the old id keep
 * working. Mirrors the remaps in `mergeWorkspaceSessionFromImport` and the
 * server's remembered-permission normalizer.
 */
const LEGACY_BACKEND_ID_REMAP: Record<string, AgentBackendId> = {
  cesium: "cesium-agent",
  "claude-adapter": "claude-code-sdk",
  "opencode-acp": "opencode-server",
  "opencode-v2-beta": "opencode-server",
  "codex-adapter": "codex-app-server",
  "gemini-acp": "google-antigravity-cli",
};

const MODEL_PROVIDERS = new Set<ModelInfo["provider"]>([
  "openai",
  "anthropic",
  "google",
  "auto",
  "cursor",
  "opencode",
  "codex",
  "claude",
  "xai",
  "fixture",
]);

export function createDefaultComposerDefaults(): ComposerDefaultsState {
  return {
    backendId: DEFAULT_COMPOSER_BACKEND_ID,
    mode: DEFAULT_COMPOSER_MODE,
    model: NO_MODEL_PLACEHOLDER,
    lastModelByBackend: {},
    statusBarVisibility: { ...DEFAULT_COMPOSER_STATUS_BAR_VISIBILITY },
    pillsVisibility: { ...DEFAULT_COMPOSER_PILLS_VISIBILITY },
    updatedAt: 0,
  };
}

function boundedString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, MAX_MODEL_STRING)
    : undefined;
}

/** Resolve a persisted backend id to an active one, honoring renames. */
export function normalizeComposerBackendId(raw: unknown): AgentBackendId | null {
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  const trimmed = raw.trim();
  const mapped = LEGACY_BACKEND_ID_REMAP[trimmed] ?? trimmed;
  return isActiveAgentBackendId(mapped) ? mapped : null;
}

/**
 * Normalize a persisted `ModelInfo`. Keeps the identity and presentation
 * fields the draft composer needs; drops transient flags (`selected`) and
 * provider-reported parameter dumps that have no business in a settings
 * document. Returns `null` for anything that is not a usable model record.
 */
export function normalizeComposerModelInfo(raw: unknown): ModelInfo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const id = boundedString(record.id);
  if (!id) {
    return null;
  }
  const name = boundedString(record.name) ?? id;
  const provider = MODEL_PROVIDERS.has(record.provider as ModelInfo["provider"])
    ? (record.provider as ModelInfo["provider"])
    : "auto";
  const model: ModelInfo = { id, name, provider };
  const modelValue = boundedString(record.modelValue);
  if (modelValue) {
    model.modelValue = modelValue;
  }
  const backendId = normalizeComposerBackendId(record.backendId);
  if (backendId) {
    model.backendId = backendId;
  }
  const description = boundedString(record.description);
  if (description) {
    model.description = description;
  }
  const detail = boundedString(record.detail);
  if (detail) {
    model.detail = detail;
  }
  const variantGroupId = boundedString(record.variantGroupId);
  if (variantGroupId) {
    model.variantGroupId = variantGroupId;
  }
  const variantGroupName = boundedString(record.variantGroupName);
  if (variantGroupName) {
    model.variantGroupName = variantGroupName;
  }
  if (Array.isArray(record.configSelections)) {
    const selections: Array<{ configId: string; value: string }> = [];
    for (const entry of record.configSelections) {
      if (selections.length >= MAX_CONFIG_SELECTIONS) {
        break;
      }
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const configId = boundedString((entry as Record<string, unknown>).configId);
      const value = boundedString((entry as Record<string, unknown>).value);
      if (configId && value !== undefined) {
        selections.push({ configId, value });
      }
    }
    if (selections.length > 0) {
      model.configSelections = selections;
    }
  }
  return model;
}

function normalizeLastModelByBackend(raw: unknown): Record<string, ModelInfo> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, ModelInfo> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_LAST_MODEL_ENTRIES) {
      break;
    }
    const backendId = normalizeComposerBackendId(key);
    const model = normalizeComposerModelInfo(value);
    if (!backendId || !model) {
      continue;
    }
    out[backendId] = model;
    count += 1;
  }
  return out;
}

function normalizeMode(raw: unknown, fallback: EditorMode): EditorMode {
  return typeof raw === "string" && raw.trim().length > 0 && raw.length <= 64
    ? raw.trim()
    : fallback;
}

export function normalizeComposerDefaults(
  raw: unknown,
  options?: {
    /**
     * `general.composerStatusBarVisibility` from pre-composer profiles. Only
     * consulted when the row carries no `composer` slice at all, so an account
     * that already saved composer defaults is never rewound.
     */
    legacyStatusBarVisibility?: unknown;
  }
): ComposerDefaultsState {
  const defaults = createDefaultComposerDefaults();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (options?.legacyStatusBarVisibility && typeof options.legacyStatusBarVisibility === "object") {
      return {
        ...defaults,
        statusBarVisibility: normalizeComposerStatusBarVisibility(options.legacyStatusBarVisibility),
      };
    }
    return defaults;
  }
  const record = raw as Record<string, unknown>;
  const backendId = normalizeComposerBackendId(record.backendId) ?? defaults.backendId;
  const model = normalizeComposerModelInfo(record.model) ?? defaults.model;
  const profileId =
    typeof record.profileId === "string" && record.profileId.trim()
      ? record.profileId.trim().slice(0, 120)
      : undefined;
  return {
    backendId,
    mode: normalizeMode(record.mode, defaults.mode),
    model,
    lastModelByBackend: normalizeLastModelByBackend(record.lastModelByBackend),
    ...(profileId ? { profileId } : {}),
    statusBarVisibility: normalizeComposerStatusBarVisibility(record.statusBarVisibility),
    pillsVisibility: normalizeComposerPillsVisibility(record.pillsVisibility),
    updatedAt:
      typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) && record.updatedAt > 0
        ? record.updatedAt
        : 0,
  };
}

function configSelectionsSignature(
  selections?: Array<{ configId: string; value: string }>
): string {
  return (selections ?? [])
    .map((selection) => `${selection.configId}:${selection.value}`)
    .sort()
    .join("|");
}

export function composerModelChoiceSignature(model: ModelInfo): string {
  return JSON.stringify({
    id: model.id,
    modelValue: model.modelValue ?? null,
    name: model.name,
    backendId: model.backendId ?? null,
    configSelections: configSelectionsSignature(model.configSelections),
  });
}

/** Structural subset of {@link ComposerDefaultsState} the draft helpers read. */
export type ComposerDraftSelection = {
  backendId: AgentBackendId;
  mode: EditorMode;
  model: ModelInfo;
  lastModelByBackend?: Record<string, ModelInfo>;
};

/**
 * Apply a harness / mode / model pick to the composer defaults. Returns the
 * same object when nothing changed so React state updates can short-circuit.
 * The model is remembered per harness so a later switch back restores it.
 */
export function updateComposerDraftDefault(
  current: ComposerDefaultsState,
  patch: {
    backendId?: AgentBackendId;
    mode?: EditorMode;
    model?: ModelInfo;
  },
  now: number = Date.now()
): ComposerDefaultsState {
  const backendId =
    (patch.model?.backendId as AgentBackendId | undefined) ?? patch.backendId ?? current.backendId;
  const mode = patch.mode ?? current.mode;
  const model = patch.model ?? current.model;

  const rememberKey = (model.backendId as AgentBackendId | undefined) ?? backendId;
  const previousRemembered = current.lastModelByBackend?.[rememberKey];
  const rememberedChanged =
    previousRemembered == null ||
    composerModelChoiceSignature(previousRemembered) !== composerModelChoiceSignature(model);

  if (
    current.backendId === backendId &&
    current.mode === mode &&
    composerModelChoiceSignature(current.model) === composerModelChoiceSignature(model) &&
    !rememberedChanged
  ) {
    return current;
  }

  return {
    ...current,
    backendId,
    mode,
    model,
    lastModelByBackend: rememberedChanged
      ? { ...current.lastModelByBackend, [rememberKey]: model }
      : current.lastModelByBackend,
    updatedAt: now,
  };
}

/** Set the draft mode for new chats (no-op when unchanged). */
export function updateComposerDraftMode(
  current: ComposerDefaultsState,
  mode: EditorMode,
  now: number = Date.now()
): ComposerDefaultsState {
  return current.mode === mode ? current : { ...current, mode, updatedAt: now };
}

/** Set the Cesium capability profile for new chats (no-op when unchanged). */
export function updateComposerDraftProfile(
  current: ComposerDefaultsState,
  profileId: string | null | undefined,
  now: number = Date.now()
): ComposerDefaultsState {
  const next = profileId?.trim() || undefined;
  if ((current.profileId ?? undefined) === next) {
    return current;
  }
  const rest: ComposerDefaultsState = { ...current, updatedAt: now };
  if (next) {
    rest.profileId = next;
  } else {
    delete rest.profileId;
  }
  return rest;
}

/**
 * Resolve the model a new-chat draft should show for `backend` from the
 * user's last-used choices: the current draft model when it belongs to this
 * backend, then the per-backend memory. Matches against the live catalog
 * (`draftModels`) so stale ids cannot leak into the dropdown, but when the
 * catalog has not hydrated yet (placeholder 0/1-entry list built from the
 * hardcoded backend default) the remembered pick is trusted as-is - snapping
 * to the placeholder default is exactly the bug this prevents.
 *
 * Returns null when nothing usable was remembered; callers fall back to the
 * backend's default model.
 */
export function resolveLastUsedDraftModel(
  current: ComposerDraftSelection,
  backend: { id: AgentBackendId },
  draftModels: ModelInfo[]
): ModelInfo | null {
  const candidates: ModelInfo[] = [];
  if ((current.model.backendId ?? current.backendId) === backend.id) {
    candidates.push(current.model);
  }
  const remembered = current.lastModelByBackend?.[backend.id];
  if (remembered && remembered !== current.model) {
    candidates.push(remembered);
  }

  for (const candidate of candidates) {
    // Exact row id first: keeps composite variant picks (e.g. thought-level
    // rows like `model::thought::high`) instead of collapsing to the first
    // variant that shares the same modelValue.
    const exact = draftModels.find((model) => model.id === candidate.id);
    if (exact) {
      return exact;
    }
    const candidateValue = candidate.modelValue ?? candidate.id;
    const valueMatches = draftModels.filter(
      (model) => (model.modelValue ?? model.id) === candidateValue
    );
    if (valueMatches.length > 0) {
      return (
        valueMatches.find(
          (model) =>
            configSelectionsSignature(model.configSelections) ===
            configSelectionsSignature(candidate.configSelections)
        ) ?? valueMatches[0]!
      );
    }
    if (draftModels.length <= 1 && candidate.backendId === backend.id) {
      // Catalog not hydrated (single synthetic entry): trust the explicit
      // last-used pick over the placeholder.
      return candidate;
    }
  }
  return null;
}

/**
 * Legacy per-workspace draft fields, as persisted inside a workspace session's
 * `chat` slice before composer defaults moved to the account. Read once from
 * any session the client loads so an upgraded install keeps its last picks.
 */
export type LegacyChatComposerFields = Partial<
  Pick<ComposerDefaultsState, "backendId" | "mode" | "model" | "lastModelByBackend" | "profileId">
> & {
  statusBarVisibility?: ComposerStatusBarVisibility;
  pillsVisibility?: ComposerPillsVisibility;
};

export function extractLegacyComposerFieldsFromChatSession(
  rawChat: unknown
): LegacyChatComposerFields | null {
  if (!rawChat || typeof rawChat !== "object" || Array.isArray(rawChat)) {
    return null;
  }
  const record = rawChat as Record<string, unknown>;
  const out: LegacyChatComposerFields = {};
  const backendId = normalizeComposerBackendId(record.backendId);
  if (backendId) {
    out.backendId = backendId;
  }
  if (typeof record.mode === "string" && record.mode.trim()) {
    out.mode = normalizeMode(record.mode, DEFAULT_COMPOSER_MODE);
  }
  const model = normalizeComposerModelInfo(record.model);
  if (model && model.id !== NO_MODEL_PLACEHOLDER.id) {
    out.model = model;
  }
  const lastModelByBackend = normalizeLastModelByBackend(record.lastModelByBackend);
  if (Object.keys(lastModelByBackend).length > 0) {
    out.lastModelByBackend = lastModelByBackend;
  }
  if (typeof record.profileId === "string" && record.profileId.trim()) {
    out.profileId = record.profileId.trim().slice(0, 120);
  }
  if (record.composerStatusBarVisibility && typeof record.composerStatusBarVisibility === "object") {
    out.statusBarVisibility = normalizeComposerStatusBarVisibility(
      record.composerStatusBarVisibility
    );
  }
  if (record.composerPillsVisibility && typeof record.composerPillsVisibility === "object") {
    out.pillsVisibility = normalizeComposerPillsVisibility(record.composerPillsVisibility);
  }
  return Object.keys(out).length > 0 ? out : null;
}

function sameVisibility(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

/** True when the account has never picked a harness/model anywhere. */
export function composerHasNoModelSelection(current: ComposerDefaultsState): boolean {
  return (
    current.model.id === NO_MODEL_PLACEHOLDER.id &&
    Object.keys(current.lastModelByBackend).length === 0
  );
}

/**
 * Adopt legacy per-workspace picks into the account defaults exactly once:
 * only while the account never set a composer default (`updatedAt === 0`),
 * and field-by-field only where the account still holds factory values. Once
 * the user has chosen anything on any device, workspace-local leftovers must
 * not override it.
 */
export function adoptLegacyComposerFields(
  current: ComposerDefaultsState,
  legacy: LegacyChatComposerFields | null,
  now: number = Date.now()
): ComposerDefaultsState {
  if (!legacy || current.updatedAt > 0) {
    return current;
  }
  let next = current;
  let changed = false;
  const hasLegacySelection = Boolean(
    legacy.backendId || legacy.model || legacy.lastModelByBackend || legacy.mode || legacy.profileId
  );
  if (hasLegacySelection && composerHasNoModelSelection(current)) {
    next = {
      ...next,
      backendId: legacy.backendId ?? next.backendId,
      mode: legacy.mode ?? next.mode,
      model: legacy.model ?? next.model,
      lastModelByBackend: { ...next.lastModelByBackend, ...(legacy.lastModelByBackend ?? {}) },
      ...(legacy.profileId ? { profileId: legacy.profileId } : {}),
    };
    changed = true;
  }
  if (
    legacy.statusBarVisibility &&
    sameVisibility(current.statusBarVisibility, DEFAULT_COMPOSER_STATUS_BAR_VISIBILITY) &&
    !sameVisibility(legacy.statusBarVisibility, DEFAULT_COMPOSER_STATUS_BAR_VISIBILITY)
  ) {
    next = { ...next, statusBarVisibility: legacy.statusBarVisibility };
    changed = true;
  }
  if (
    legacy.pillsVisibility &&
    sameVisibility(current.pillsVisibility, DEFAULT_COMPOSER_PILLS_VISIBILITY) &&
    !sameVisibility(legacy.pillsVisibility, DEFAULT_COMPOSER_PILLS_VISIBILITY)
  ) {
    next = { ...next, pillsVisibility: legacy.pillsVisibility };
    changed = true;
  }
  return changed ? { ...next, updatedAt: now } : current;
}
