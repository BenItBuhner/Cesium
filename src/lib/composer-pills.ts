// Re-export shim matching src/lib/composer-status-bar.ts; implementation lives
// in @cesium/client (packages/client/src/composer-pills.ts).
export {
  DEFAULT_COMPOSER_PILLS_VISIBILITY,
  countComposerBackgroundWork,
  deriveComposerBuiltinPills,
  formatDiffPillLabel,
  listRunningSubagentWorkItems,
  normalizeComposerPillsVisibility,
  resolveComposerPillsVisibility,
  withComposerPillsVisibility,
} from "@cesium/client";
export type {
  ComposerBackgroundWorkItem,
  ComposerBackgroundWorkOptions,
  ComposerBuiltinPillState,
  ComposerPillsScopeState,
  ComposerPillsVisibility,
} from "@cesium/client";
