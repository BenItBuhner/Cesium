export type OrderedToggleEntry = {
  id: string;
  name: string;
  on: boolean;
  backendId?: string;
};

/** Keep `orderedIds` first (skipping unknown ids), then any leftover catalog rows. */
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

/**
 * Merge a live catalog onto a persisted toggle list without resetting user order.
 * Existing ids keep their previous sequence; new catalog ids append; dropped ids
 * disappear.
 */
export function mergeCatalogPreservingOrder(
  catalog: Array<{ id: string; name: string }>,
  existing: OrderedToggleEntry[],
  backendId: string
): OrderedToggleEntry[] {
  const catalogMap = new Map(catalog.map((model) => [model.id, model]));
  const existingMap = new Map(existing.map((entry) => [entry.id, entry]));
  const merged: OrderedToggleEntry[] = [];

  for (const entry of existing) {
    const catalogEntry = catalogMap.get(entry.id);
    if (!catalogEntry) {
      continue;
    }
    merged.push({
      ...entry,
      name: catalogEntry.name,
      backendId,
    });
  }

  for (const model of catalog) {
    if (existingMap.has(model.id)) {
      continue;
    }
    merged.push({
      id: model.id,
      name: model.name,
      on: true,
      backendId,
    });
  }

  return merged;
}
