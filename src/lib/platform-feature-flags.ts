// Moved to @cesium/client (packages/client/src/platform-feature-flags.ts). Re-export shim keeps existing imports stable.
export {
  areIpadBetaFeaturesEnabled,
  getCesiumRendererFeatureFlags,
  resolveEffectiveUserPreferences,
} from "@cesium/client";
export type {
  CesiumRendererFeatureFlags,
} from "@cesium/client";
