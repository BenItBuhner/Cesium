// Lives in @cesium/client (packages/client/src/quick-open-scopes.ts). Re-export shim keeps app imports stable.
export {
  QUICK_OPEN_SCOPE_IDS,
  QUICK_OPEN_SCOPE_LABELS,
  QUICK_OPEN_SCOPE_PLACEHOLDERS,
  QUICK_OPEN_SCOPE_SIGILS,
  QUICK_OPEN_SCOPE_WORD_PREFIXES,
  QUICK_SWITCHER_SCOPE_IDS,
  QUICK_SWITCHER_SCOPE_LABELS,
  cycleQuickOpenScope,
  isQuickOpenScopeId,
  isQuickSwitcherScopeId,
  normalizeQuickOpenScope,
  normalizeQuickSwitcherScope,
  parseQuickOpenQuery,
} from "@cesium/client";
export type {
  ParsedQuickOpenQuery,
  QuickOpenScopeId,
  QuickSwitcherScopeId,
} from "@cesium/client";
