/**
 * User customization of the device / server picker dropdown: which sections
 * and entries show up, and in what order. Entry ids are stable strings so
 * the same setting covers saved servers, GitHub Codespaces, cloud
 * pseudo-devices, and the footer actions.
 */

export const DEVICE_PICKER_SECTION_IDS = ["servers", "codespaces", "cloud"] as const;

export type DevicePickerSectionId = (typeof DEVICE_PICKER_SECTION_IDS)[number];

export const DEVICE_PICKER_SECTION_LABELS: Record<DevicePickerSectionId, string> = {
  servers: "Saved servers",
  codespaces: "GitHub Codespaces",
  cloud: "Cloud",
};

/** Footer actions in the device variant that can be hidden independently. */
export const DEVICE_PICKER_ACTION_IDS = [
  "action:browser",
  "action:connect",
  "action:setup-codespace",
] as const;

export type DevicePickerActionId = (typeof DEVICE_PICKER_ACTION_IDS)[number];

export const DEVICE_PICKER_ACTION_LABELS: Record<
  DevicePickerActionId,
  { label: string; description: string }
> = {
  "action:browser": {
    label: "Use this browser",
    description: "Offer the in-browser engine that runs entirely in this tab.",
  },
  "action:connect": {
    label: "Connect a device",
    description: "Inline form to pair another Cesium engine by URL.",
  },
  "action:setup-codespace": {
    label: "Set up a Codespace…",
    description: "Shortcut to the GitHub Codespace setup wizard.",
  },
};

export type DevicePickerState = {
  /** Section render order. Unknown/missing ids are appended in default order. */
  sectionOrder: DevicePickerSectionId[];
  /**
   * Global entry ranking. Entries present here render first (in this order)
   * within their section; anything not listed keeps its natural order after.
   */
  order: string[];
  /** Entry, section (`section:*`), and action (`action:*`) ids removed from the picker. */
  hidden: string[];
};

const MAX_DEVICE_PICKER_IDS = 500;

export function isDevicePickerSectionId(value: unknown): value is DevicePickerSectionId {
  return DEVICE_PICKER_SECTION_IDS.includes(value as DevicePickerSectionId);
}

export function isDevicePickerActionId(value: unknown): value is DevicePickerActionId {
  return DEVICE_PICKER_ACTION_IDS.includes(value as DevicePickerActionId);
}

export function devicePickerServerEntryId(serverId: string): string {
  return `server:${serverId}`;
}

export function devicePickerCodespaceEntryId(deviceKey: string): string {
  return `codespace:${deviceKey}`;
}

export function devicePickerSectionHiddenId(section: DevicePickerSectionId): string {
  return `section:${section}`;
}

export function createDefaultDevicePickerState(): DevicePickerState {
  return { sectionOrder: [...DEVICE_PICKER_SECTION_IDS], order: [], hidden: [] };
}

function dedupeStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) {
      continue;
    }
    if (out.length >= MAX_DEVICE_PICKER_IDS) {
      break;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function normalizeDevicePickerState(raw: unknown): DevicePickerState {
  const defaults = createDefaultDevicePickerState();
  if (!raw || typeof raw !== "object") {
    return defaults;
  }
  const record = raw as Partial<DevicePickerState>;
  const orderedSections = dedupeStrings(record.sectionOrder).filter(isDevicePickerSectionId);
  return {
    sectionOrder: [
      ...orderedSections,
      ...DEVICE_PICKER_SECTION_IDS.filter((id) => !orderedSections.includes(id)),
    ],
    order: dedupeStrings(record.order),
    hidden: dedupeStrings(record.hidden),
  };
}

export function isDevicePickerEntryHidden(state: DevicePickerState, id: string): boolean {
  return state.hidden.includes(id);
}

export function isDevicePickerSectionHidden(
  state: DevicePickerState,
  section: DevicePickerSectionId
): boolean {
  return state.hidden.includes(devicePickerSectionHiddenId(section));
}

/**
 * Stable sort: ranked entries first by rank, then unranked entries in their
 * incoming order. Works on any item shape via `getId`.
 */
export function sortByDevicePickerOrder<T>(
  items: readonly T[],
  order: readonly string[],
  getId: (item: T) => string
): T[] {
  if (order.length === 0 || items.length === 0) {
    return [...items];
  }
  const rank = new Map<string, number>();
  order.forEach((id, index) => rank.set(id, index));
  return items
    .map((item, index) => ({ item, index, rank: rank.get(getId(item)) }))
    .sort((a, b) => {
      if (a.rank !== undefined && b.rank !== undefined) {
        return a.rank - b.rank;
      }
      if (a.rank !== undefined) return -1;
      if (b.rank !== undefined) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

export function toggleDevicePickerHidden(
  state: DevicePickerState,
  id: string,
  hidden?: boolean
): DevicePickerState {
  const currentlyHidden = state.hidden.includes(id);
  const nextHidden = hidden ?? !currentlyHidden;
  if (nextHidden === currentlyHidden) {
    return state;
  }
  return {
    ...state,
    hidden: nextHidden
      ? [...state.hidden, id].slice(-MAX_DEVICE_PICKER_IDS)
      : state.hidden.filter((value) => value !== id),
  };
}

/**
 * Move `id` by `delta` within `displayedIds` (the section's ids as currently
 * rendered) and persist that full section order at the front of the ranking,
 * keeping other sections' rankings intact.
 */
export function moveDevicePickerEntry(
  state: DevicePickerState,
  displayedIds: readonly string[],
  id: string,
  delta: -1 | 1
): DevicePickerState {
  const from = displayedIds.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= displayedIds.length) {
    return state;
  }
  const next = [...displayedIds];
  next.splice(from, 1);
  next.splice(to, 0, id);
  const displayed = new Set(displayedIds);
  return {
    ...state,
    order: [...next, ...state.order.filter((value) => !displayed.has(value))].slice(
      0,
      MAX_DEVICE_PICKER_IDS
    ),
  };
}

export function moveDevicePickerSection(
  state: DevicePickerState,
  section: DevicePickerSectionId,
  delta: -1 | 1
): DevicePickerState {
  const from = state.sectionOrder.indexOf(section);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= state.sectionOrder.length) {
    return state;
  }
  const next = [...state.sectionOrder];
  next.splice(from, 1);
  next.splice(to, 0, section);
  return { ...state, sectionOrder: next };
}
