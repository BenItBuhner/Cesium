import { NativeModules, Platform } from "react-native";

export type AndroidRuntimeConfig = {
  projectsDir: string | null;
  serverDataDir: string | null;
  defaultWorkspaceRoot: string | null;
  allowedWorkspaceRoots: string[];
  backendEnvironment: Record<string, string>;
  localBackendReady: boolean;
};

type CesiumAndroidRuntimeModule = {
  getRuntimeConfig(): Promise<Partial<AndroidRuntimeConfig>>;
};

const nativeModule = NativeModules.CesiumAndroidRuntime as CesiumAndroidRuntimeModule | undefined;

export const CesiumAndroidRuntime = {
  async getRuntimeConfig(): Promise<AndroidRuntimeConfig | null> {
    if (Platform.OS !== "android" || !nativeModule) {
      return null;
    }

    try {
      return normalizeRuntimeConfig(await nativeModule.getRuntimeConfig());
    } catch {
      return null;
    }
  },
};

function normalizeRuntimeConfig(raw: Partial<AndroidRuntimeConfig>): AndroidRuntimeConfig {
  const backendEnvironment =
    raw.backendEnvironment && typeof raw.backendEnvironment === "object"
      ? Object.fromEntries(
          Object.entries(raw.backendEnvironment).filter(
            (entry): entry is [string, string] =>
              typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1].length > 0
          )
        )
      : {};

  return {
    projectsDir: normalizePath(raw.projectsDir),
    serverDataDir: normalizePath(raw.serverDataDir),
    defaultWorkspaceRoot: normalizePath(raw.defaultWorkspaceRoot),
    allowedWorkspaceRoots: Array.isArray(raw.allowedWorkspaceRoots)
      ? raw.allowedWorkspaceRoots.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [],
    backendEnvironment,
    localBackendReady: raw.localBackendReady === true,
  };
}

function normalizePath(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
