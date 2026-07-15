// Moved to @cesium/client (packages/client/src/resolve-server-base-url.ts). Re-export shim keeps existing imports stable.
export {
  getConfiguredServerBaseUrl,
  parseServerUrlSearchParam,
  resolveClientServerBaseUrl,
  resolveClientServerBaseUrlForCurrentWindow,
  resolveClientServerBaseUrlForLocation,
  resolveExplicitServerBaseUrlForCurrentWindow,
  stripServerUrlSearchParamFromLocation,
} from "@cesium/client";
export type {
  ResolveServerBaseUrlOptions,
} from "@cesium/client";
