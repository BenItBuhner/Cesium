// Moved to @cesium/client (packages/client/src/auth-client.ts). Re-export shim keeps existing imports stable.
export {
  ACCESS_TOKEN_QUERY_PARAM,
  AUTH_STORAGE_KEY,
  IFRAME_ACCESS_TOKEN_QUERY_PARAM,
  LEGACY_AUTH_STORAGE_KEY,
  SESSION_TOKEN_HEADER,
  attachSessionToken,
  buildAuthenticatedUrl,
  buildIframeAuthenticatedUrl,
  clearStoredAuth,
  getStoredSessionToken,
  migrateStoredAuthServerBaseUrl,
  setStoredSessionToken,
  syncAuthTokenFromResponse,
  updateStoredAuthSession,
} from "@cesium/client";
export type {
  AuthSession,
  AuthStatusResponse,
} from "@cesium/client";
