import type { EditorTab } from "@/lib/types";
import type {
  EditorPaneId,
  EditorPaneNode,
  EditorPaneTabsState,
  EditorSessionState,
  EditorSplitOrientation,
} from "@/lib/workspace-session";

export type LegacyEditorSessionShape = Partial<{
  split: boolean;
  splitOrientation: EditorSplitOrientation;
  splitLayout: Record<string, number> | null;
  focusedGroup: "left" | "right";
  leftTabs: EditorTab[];
  rightTabs: EditorTab[];
  leftActiveId: string | null;
  rightActiveId: string | null;
  viewStateByTabId: Record<string, unknown>;
}>;

const ROOT_PANE_ID = "left";
const LEGACY_SECOND_PANE_ID = "right";
const ROOT_SPLIT_ID = "split-root";

function normalizeSplitOrientation(value: unknown): EditorSplitOrientation {
  return value === "vertical" ? "vertical" : "horizontal";
}

function normalizeSplitLayout(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const entries = Object.entries(value).filter(
    ([panelId, size]) =>
      typeof panelId === "string" &&
      panelId.length > 0 &&
      typeof size === "number" &&
      Number.isFinite(size)
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function createPaneTabsState(
  tabs: EditorTab[] = [],
  activeId: string | null = null
): EditorPaneTabsState {
  const nextTabs = Array.isArray(tabs) ? tabs : [];
  const nextActiveId =
    activeId && nextTabs.some((tab) => tab.id === activeId) ? activeId : nextTabs[0]?.id ?? null;
  return {
    tabs: nextTabs,
    activeId: nextActiveId,
  };
}

function collectLeafPaneIds(node: EditorPaneNode, target: EditorPaneId[] = []): EditorPaneId[] {
  if (node.type === "leaf") {
    target.push(node.paneId);
    return target;
  }
  collectLeafPaneIds(node.first, target);
  collectLeafPaneIds(node.second, target);
  return target;
}

function normalizePaneNode(
  value: unknown,
  seenSplitIds = new Set<string>()
): EditorPaneNode | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<EditorPaneNode>;
  if (candidate.type === "leaf") {
    return typeof candidate.paneId === "string" && candidate.paneId.length > 0
      ? { type: "leaf", paneId: candidate.paneId }
      : null;
  }
  if (
    candidate.type !== "split" ||
    typeof candidate.nodeId !== "string" ||
    candidate.nodeId.length === 0 ||
    seenSplitIds.has(candidate.nodeId)
  ) {
    return null;
  }
  seenSplitIds.add(candidate.nodeId);
  const first = normalizePaneNode(candidate.first, seenSplitIds);
  const second = normalizePaneNode(candidate.second, seenSplitIds);
  if (!first || !second) {
    return null;
  }
  return {
    type: "split",
    nodeId: candidate.nodeId,
    orientation: normalizeSplitOrientation(candidate.orientation),
    layout: normalizeSplitLayout(candidate.layout),
    first,
    second,
  };
}

function createLegacyEditorSession(
  raw: LegacyEditorSessionShape,
  fallback: EditorSessionState
): EditorSessionState {
  const leftFallback = fallback.panesById[ROOT_PANE_ID];
  const rightFallback = fallback.panesById[LEGACY_SECOND_PANE_ID];
  const leftTabs = Array.isArray(raw.leftTabs) ? raw.leftTabs : leftFallback?.tabs ?? [];
  const rightTabs = Array.isArray(raw.rightTabs) ? raw.rightTabs : rightFallback?.tabs ?? [];
  const split = raw.split === true || rightTabs.length > 0;
  const panesById: Record<EditorPaneId, EditorPaneTabsState> = {
    [ROOT_PANE_ID]: createPaneTabsState(leftTabs, raw.leftActiveId ?? leftFallback?.activeId ?? null),
  };
  if (split || rightTabs.length > 0 || rightFallback) {
    panesById[LEGACY_SECOND_PANE_ID] = createPaneTabsState(
      rightTabs,
      raw.rightActiveId ?? rightFallback?.activeId ?? null
    );
  }
  return {
    root: split
      ? {
          type: "split",
          nodeId: ROOT_SPLIT_ID,
          orientation: normalizeSplitOrientation(raw.splitOrientation),
          layout: normalizeSplitLayout(raw.splitLayout),
          first: { type: "leaf", paneId: ROOT_PANE_ID },
          second: { type: "leaf", paneId: LEGACY_SECOND_PANE_ID },
        }
      : { type: "leaf", paneId: ROOT_PANE_ID },
    panesById,
    focusedPaneId:
      raw.focusedGroup === "right" && split ? LEGACY_SECOND_PANE_ID : ROOT_PANE_ID,
    viewStateByTabId:
      raw.viewStateByTabId && typeof raw.viewStateByTabId === "object"
        ? raw.viewStateByTabId
        : fallback.viewStateByTabId,
  };
}

export function createEmptyEditorSessionState(): EditorSessionState {
  return {
    root: { type: "leaf", paneId: ROOT_PANE_ID },
    panesById: {
      [ROOT_PANE_ID]: createPaneTabsState(),
    },
    focusedPaneId: ROOT_PANE_ID,
    viewStateByTabId: {},
  };
}

export function normalizeEditorSessionState(
  raw: Partial<EditorSessionState> | LegacyEditorSessionShape | null | undefined,
  defaults: EditorSessionState = createEmptyEditorSessionState()
): EditorSessionState {
  if (!raw || typeof raw !== "object") {
    return defaults;
  }

  const candidateRoot = normalizePaneNode((raw as Partial<EditorSessionState>).root);
  if (!candidateRoot) {
    return createLegacyEditorSession(raw as LegacyEditorSessionShape, defaults);
  }

  const paneIds = [...new Set(collectLeafPaneIds(candidateRoot))];
  if (paneIds.length === 0) {
    return defaults;
  }

  const rawPanesById =
    (raw as Partial<EditorSessionState>).panesById &&
    typeof (raw as Partial<EditorSessionState>).panesById === "object"
      ? ((raw as Partial<EditorSessionState>).panesById as Partial<
          Record<EditorPaneId, EditorPaneTabsState>
        >)
      : {};

  const panesById = Object.fromEntries(
    paneIds.map((paneId) => {
      const fallbackPane = defaults.panesById[paneId];
      const rawPane = rawPanesById[paneId];
      return [
        paneId,
        createPaneTabsState(
          Array.isArray(rawPane?.tabs) ? rawPane.tabs : fallbackPane?.tabs ?? [],
          rawPane?.activeId ?? fallbackPane?.activeId ?? null
        ),
      ];
    })
  );

  const focusedPaneId =
    typeof (raw as Partial<EditorSessionState>).focusedPaneId === "string" &&
    paneIds.includes((raw as Partial<EditorSessionState>).focusedPaneId!)
      ? (raw as Partial<EditorSessionState>).focusedPaneId!
      : paneIds[0]!;

  const viewStateByTabId =
    (raw as Partial<EditorSessionState>).viewStateByTabId &&
    typeof (raw as Partial<EditorSessionState>).viewStateByTabId === "object"
      ? (raw as Partial<EditorSessionState>).viewStateByTabId!
      : defaults.viewStateByTabId;

  return {
    root: candidateRoot,
    panesById,
    focusedPaneId,
    viewStateByTabId,
  };
}

export function createPersistableEditorSessionState(
  session: EditorSessionState,
  mapTab: (tab: EditorTab) => EditorTab
): EditorSessionState {
  const paneIds = getEditorPaneIds(session);
  return {
    ...session,
    panesById: Object.fromEntries(
      paneIds.map((paneId) => {
        const pane = session.panesById[paneId] ?? createPaneTabsState();
        return [
          paneId,
          {
            ...pane,
            tabs: pane.tabs.map(mapTab),
          },
        ];
      })
    ),
  };
}

export function getEditorNodePanelId(node: EditorPaneNode): string {
  return node.type === "leaf" ? node.paneId : `split:${node.nodeId}`;
}

export function getEditorPaneIds(session: EditorSessionState): EditorPaneId[] {
  return [...new Set(collectLeafPaneIds(session.root))];
}

export function getEditorPaneCount(session: EditorSessionState): number {
  return getEditorPaneIds(session).length;
}

export function getEditorPaneState(
  session: EditorSessionState,
  paneId: EditorPaneId
): EditorPaneTabsState | null {
  return session.panesById[paneId] ?? null;
}

export function getFocusedEditorPaneState(
  session: EditorSessionState
): EditorPaneTabsState | null {
  return getEditorPaneState(session, session.focusedPaneId);
}

export function getEditorPaneActiveTab(
  session: EditorSessionState,
  paneId: EditorPaneId
): EditorTab | null {
  const pane = getEditorPaneState(session, paneId);
  if (!pane) {
    return null;
  }
  return pane.tabs.find((tab) => tab.id === pane.activeId) ?? null;
}

export function getAllEditorTabs(session: EditorSessionState): EditorTab[] {
  return getEditorPaneIds(session).flatMap((paneId) => session.panesById[paneId]?.tabs ?? []);
}

export function countEditorTabs(session: EditorSessionState): number {
  return getAllEditorTabs(session).length;
}

export function findEditorPaneIdByTabId(
  session: EditorSessionState,
  tabId: string
): EditorPaneId | null {
  for (const paneId of getEditorPaneIds(session)) {
    if (session.panesById[paneId]?.tabs.some((tab) => tab.id === tabId)) {
      return paneId;
    }
  }
  return null;
}

export function findEditorPaneIdByConversationId(
  session: EditorSessionState,
  conversationId: string
): EditorPaneId | null {
  for (const paneId of getEditorPaneIds(session)) {
    if (
      session.panesById[paneId]?.tabs.some((tab) => tab.conversationId === conversationId)
    ) {
      return paneId;
    }
  }
  return null;
}

export function getOpenConversationIdsFromEditorSession(
  session: EditorSessionState
): string[] {
  const ids = new Set<string>();
  for (const tab of getAllEditorTabs(session)) {
    if (tab.conversationId) {
      ids.add(tab.conversationId);
    }
  }
  return [...ids];
}

export function getVisibleConversationIdsFromEditorSession(
  session: EditorSessionState
): string[] {
  const ids = new Set<string>();
  for (const paneId of getEditorPaneIds(session)) {
    const tab = getEditorPaneActiveTab(session, paneId);
    if (tab?.conversationId) {
      ids.add(tab.conversationId);
    }
  }
  return [...ids];
}

function collapseEmptyLeaves(
  node: EditorPaneNode,
  panesById: Record<EditorPaneId, EditorPaneTabsState>
): EditorPaneNode | null {
  if (node.type === "leaf") {
    const pane = panesById[node.paneId];
    if (!pane) {
      return null;
    }
    return pane.tabs.length > 0 ? node : null;
  }

  const first = collapseEmptyLeaves(node.first, panesById);
  const second = collapseEmptyLeaves(node.second, panesById);
  if (first && second) {
    return {
      ...node,
      first,
      second,
    };
  }
  return first ?? second;
}

export function pruneEditorSessionTabs(
  session: EditorSessionState,
  predicate: (tab: EditorTab) => boolean
): EditorSessionState {
  const nextPanesById = Object.fromEntries(
    getEditorPaneIds(session).map((paneId) => {
      const pane = session.panesById[paneId] ?? createPaneTabsState();
      const nextTabs = pane.tabs.filter(predicate);
      const nextActiveId =
        pane.activeId && nextTabs.some((tab) => tab.id === pane.activeId)
          ? pane.activeId
          : nextTabs[0]?.id ?? null;
      return [paneId, { tabs: nextTabs, activeId: nextActiveId }];
    })
  );

  const collapsedRoot = collapseEmptyLeaves(session.root, nextPanesById);
  if (!collapsedRoot) {
    return {
      ...createEmptyEditorSessionState(),
      viewStateByTabId: {},
    };
  }

  const paneIds = getEditorPaneIds({
    ...session,
    root: collapsedRoot,
    panesById: nextPanesById,
  });
  const focusedPaneId = paneIds.includes(session.focusedPaneId)
    ? session.focusedPaneId
    : paneIds[0]!;
  const validTabIds = new Set(
    paneIds.flatMap((paneId) => nextPanesById[paneId]?.tabs.map((tab) => tab.id) ?? [])
  );

  return {
    ...session,
    root: collapsedRoot,
    panesById: Object.fromEntries(
      paneIds.map((paneId) => [paneId, nextPanesById[paneId] ?? createPaneTabsState()])
    ),
    focusedPaneId,
    viewStateByTabId: Object.fromEntries(
      Object.entries(session.viewStateByTabId).filter(([tabId]) => validTabIds.has(tabId))
    ),
  };
}
