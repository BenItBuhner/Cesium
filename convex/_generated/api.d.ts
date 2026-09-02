/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agents from "../agents.js";
import type * as catalogs from "../catalogs.js";
import type * as context from "../context.js";
import type * as github from "../github.js";
import type * as lib_clerkGithub from "../lib/clerkGithub.js";
import type * as lib_codespaceBootstrap from "../lib/codespaceBootstrap.js";
import type * as lib_githubApi from "../lib/githubApi.js";
import type * as lib_identity from "../lib/identity.js";
import type * as lib_serverRecords from "../lib/serverRecords.js";
import type * as onboarding from "../onboarding.js";
import type * as preferences from "../preferences.js";
import type * as secrets from "../secrets.js";
import type * as servers from "../servers.js";
import type * as shares from "../shares.js";
import type * as snapshots from "../snapshots.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agents: typeof agents;
  catalogs: typeof catalogs;
  context: typeof context;
  github: typeof github;
  "lib/clerkGithub": typeof lib_clerkGithub;
  "lib/codespaceBootstrap": typeof lib_codespaceBootstrap;
  "lib/githubApi": typeof lib_githubApi;
  "lib/identity": typeof lib_identity;
  "lib/serverRecords": typeof lib_serverRecords;
  onboarding: typeof onboarding;
  preferences: typeof preferences;
  secrets: typeof secrets;
  servers: typeof servers;
  shares: typeof shares;
  snapshots: typeof snapshots;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
