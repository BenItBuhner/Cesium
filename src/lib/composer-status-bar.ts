// Moved to @cesium/client (packages/client/src/composer-status-bar.ts). Re-export shim keeps existing imports stable.
export {
  DEFAULT_COMPOSER_STATUS_BAR_VISIBILITY,
  composerStatusBarHasVisibleItems,
  formatContextTokenCount,
  formatContextUsagePair,
  normalizeComposerStatusBarVisibility,
  resolveComposerBranchLabel,
  resolveComposerRepoLabel,
} from "@cesium/client";
export type {
  ComposerStatusBarVisibility,
} from "@cesium/client";
