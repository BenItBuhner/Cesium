import { compactModelName, stripCursorSdkModelParams } from "@/lib/settings-model-compaction";
import type { ModelToggleState } from "@/lib/global-settings";

export type CompactModelToggleRow = {
  id: string;
  name: string;
  on: boolean;
  modelIds: string[];
};

/**
 * Collapse per-variant catalog ids into one settings row, keeping the first-seen
 * order from `models` so the picker order the user arranged is not resorted.
 */
export function compactModelRowsForBackend(models: ModelToggleState[]): CompactModelToggleRow[] {
  const groups = new Map<string, CompactModelToggleRow>();
  for (const model of models) {
    const baseId = stripCursorSdkModelParams(model.id);
    const baseName = compactModelName(model.name, baseId);
    const key = baseName.toLowerCase();
    const existing = groups.get(key);
    if (existing) {
      existing.on = existing.on || model.on;
      existing.modelIds.push(model.id);
      continue;
    }
    groups.set(key, {
      id: key,
      name: baseName,
      on: model.on,
      modelIds: [model.id],
    });
  }
  return [...groups.values()];
}

export function moveItem<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length
  ) {
    return [...items];
  }
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) {
    return [...items];
  }
  next.splice(toIndex, 0, moved);
  return next;
}

/**
 * Rebuild a backend toggle list so enabled compact rows appear in `orderedEnabled`
 * order, followed by every other catalog entry in its previous relative order.
 */
export function applyEnabledCompactOrder(
  models: ModelToggleState[],
  orderedEnabled: CompactModelToggleRow[]
): ModelToggleState[] {
  const byId = new Map(models.map((model) => [model.id, model]));
  const placed = new Set<string>();
  const next: ModelToggleState[] = [];
  for (const row of orderedEnabled) {
    for (const id of row.modelIds) {
      const model = byId.get(id);
      if (!model || placed.has(id)) {
        continue;
      }
      next.push(model);
      placed.add(id);
    }
  }
  for (const model of models) {
    if (!placed.has(model.id)) {
      next.push(model);
    }
  }
  return next;
}

/** Newly enabled ids move just after the last already-enabled entry. */
export function appendEnabledModelIds(
  models: ModelToggleState[],
  modelIds: string[]
): ModelToggleState[] {
  const movingIds = new Set(modelIds);
  const moving: ModelToggleState[] = [];
  const rest: ModelToggleState[] = [];
  for (const model of models) {
    if (movingIds.has(model.id)) {
      moving.push({ ...model, on: true });
    } else {
      rest.push(model);
    }
  }
  let insertAt = 0;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i]?.on) {
      insertAt = i + 1;
    }
  }
  return [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)];
}

export function applyIdOrder<T extends { id: string }>(items: T[], orderedIds: string[]): T[] {
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
